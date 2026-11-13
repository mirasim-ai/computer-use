/**
 * A navigation that waits on a Service Worker, through the real extension — `node scripts/test.mjs extension-stalled-tab`.
 *
 * The site has a Service Worker that controls its pages. A navigation into it while the worker is
 * stopped waits for the worker to start, and a starting worker stays paused until EVERY debugger
 * session that auto-attached it with `waitForDebuggerOnStart` has resumed it. Chrome answers
 * nothing on a tab whose navigation is pending, so one silent session anywhere on the site makes
 * another tab stop answering.
 *
 *  1. A second client of the bridge holds another tab of the site and resumes nothing. The
 *     session's click opens a new tab on the site, which loads: page sessions on the bridge do not
 *     auto-attach service workers, so there is nothing for anyone to leave paused.
 *  2. A debugger that is NOT ours (straight on Chrome's own endpoint) does the same, which the
 *     bridge cannot prevent: the new tab answers nothing. Its commands fail naming the tab and its
 *     address, the line stays up, other tabs work, and a new line does not stall on it again.
 *
 * `COMPUTER_USE_TEST_BRANDED_CHROME=1` runs the suite on the installed Chrome instead of
 * Playwright's Chromium, and `STALL_TIMEOUT_MS=30000` with the bridge's real budget.
 */

import { createServer } from "node:http";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { BridgeServer } from "../src/platform/browser/bridge/server.ts";
import { extensionDir } from "../src/platform/browser/bridge/extension-id.ts";
import { createDriver } from "../src/platform/registry.ts";
import { firstText } from "./harness.ts";
import { sleep } from "./helpers.ts";
import { RawCdp, evalInExtension, setAccess, spawnChromeWithExtension } from "./rig.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

/** How long the bridge waits for an answer here. The product's 30s with `STALL_TIMEOUT_MS=30000`. */
const COMMAND_TIMEOUT_MS = Number(process.env.STALL_TIMEOUT_MS ?? 6000);

/** A site whose Service Worker controls every page, and whose list page opens a document in a new tab. */
async function serveSite(): Promise<{ url: (path: string) => string; close: () => void }> {
  const srv = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/sw.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(`self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    if (path === "/doc") res.end("<title>doc</title><h1>DOC PAGE</h1>");
    else if (path === "/plain") res.end("<title>plain</title><h1>PLAIN PAGE</h1>");
    else res.end(`<title>${path === "/other" ? "other" : "list"}</title><h1>LIST</h1>
<button onclick="window.open('/doc?n=' + Date.now())">new doc</button>
<script>navigator.serviceWorker.register('/sw.js');</script>`);
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as { port: number }).port;
  return { url: (path) => `http://localhost:${port}${path}`, close: () => srv.close() };
}

/** A raw CDP client that keeps the events it is sent: Chrome's own endpoint, or the bridge's. */
class Cdp {
  readonly events: Array<{ method: string; params: any; sessionId?: string }> = [];
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id === undefined) { this.events.push(message); return; }
      const callback = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) callback?.reject(new Error(message.error.message));
      else callback?.resolve(message.result);
    });
  }
  static async connect(httpUrl: string): Promise<Cdp> {
    const version = (await (await fetch(`${httpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close(): void { this.ws.close(); }
}

async function main() {
  const chrome = await spawnChromeWithExtension(extensionDir());
  if (!chrome) {
    console.log("SKIP  extension-stalled-tab: no browser that loads the extension; npx playwright install chromium to enable");
    return;
  }
  const site = await serveSite();
  const bridgeLog: string[] = [];
  const server = new BridgeServer({
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    log: (...args: unknown[]) => {
      const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
      bridgeLog.push(line);
      if (/slow|did not answer|let go|timed out|extension connected/i.test(line)) console.error(`[${at()}] [bridge]`, line);
    },
    openUrl: async (url) => {
      const probe = await chromium.connectOverCDP(chrome.cdpUrl);
      try {
        await (await probe.contexts()[0]!.newPage()).goto(url).catch(() => {}); // the worker closes it mid-settle
      } finally {
        await probe.close();
      }
    },
  });
  await server.start();
  let rawCdp: RawCdp | null = null;
  let own: Cdp | null = null;
  let second: Cdp | null = null;
  const drivers: Array<{ close(): Promise<void> }> = [];
  try {
    rawCdp = await RawCdp.connect(chrome.cdpUrl);
    await setAccess(rawCdp, { scope: "all" });
    await server.ensureExtension();
    own = await Cdp.connect(chrome.cdpUrl);
    const product = String((await own.send("Browser.getVersion")).product);
    console.log(`browser: ${product}; the bridge waits ${COMMAND_TIMEOUT_MS} ms for an answer`);

    // The user's own two tabs on the site, opened outside the bridge, both controlled by the worker.
    const openUserTab = async (path: string) => {
      const { targetId } = await own!.send("Target.createTarget", { url: site.url(path) });
      const { sessionId } = await own!.send("Target.attachToTarget", { targetId, flatten: true });
      for (let i = 0; i < 80; i++) {
        const { result } = await own!.send("Runtime.evaluate", { expression: "!!navigator.serviceWorker.controller" }, sessionId);
        if (result.value) break;
        await sleep(100);
      }
      return { targetId, sessionId };
    };
    const list = await openUserTab("/");
    const other = await openUserTab("/other");
    await own.send("Target.detachFromTarget", { sessionId: other.sessionId });
    /** Stop the SITE's worker, as Chrome does to an idle one. Not `stopAllWorkers`: the bridge
     *  extension is a service worker too. */
    const stopSiteWorker = async (): Promise<string> => {
      const seen = own!.events.length;
      await own!.send("ServiceWorker.enable", {}, list.sessionId);
      await sleep(300);
      const versions = new Map<string, any>();
      const collect = () => {
        for (const e of own!.events.slice(seen)) if (e.method === "ServiceWorker.workerVersionUpdated") for (const v of e.params.versions) versions.set(v.versionId, v);
      };
      collect();
      for (const v of versions.values())
        if (String(v.scriptURL).startsWith(site.url("")) && v.runningStatus !== "stopped") await own!.send("ServiceWorker.stopWorker", { versionId: v.versionId }, list.sessionId);
      await sleep(500);
      collect();
      await own!.send("ServiceWorker.disable", {}, list.sessionId);
      return [...versions.values()].filter((v) => String(v.scriptURL).startsWith(site.url(""))).map((v) => v.runningStatus).join(",");
    };
    const debuggerOn = async (tabId: number) => await evalInExtension(rawCdp!,
      `chrome.debugger.getTargets().then((ts) => ts.some((t) => t.tabId === ${tabId} && t.attached))`) as boolean;
    const newDriver = () => {
      const driver = createDriver("browser", {
        cdpUrl: server.cdpUrl(), browser: { cdpUrl: server.cdpUrl(), cdpStrict: true },
        env: { ...process.env, COMPUTER_USE_CDP_URL: server.cdpUrl(), COMPUTER_USE_CDP_STRICT: "1" },
      });
      drivers.push(driver);
      return driver;
    };

    // ── 1. A second client of the bridge that resumes nothing ──────────────────────────────
    // It holds the user's OTHER tab on the site, with the auto-attach every client asks for.
    second = await Cdp.connect(server.cdpUrl());
    await second.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const listed = await second.send("Mirasim.tabs");
    const otherTab = listed.tabs.find((t: any) => t.title === "other");
    const otherTarget = (await second.send("Mirasim.tabTarget", { tabId: otherTab.tabId, browserSession: listed.browserSession })).targetId;
    await second.send("Mirasim.restoreTab", { tabId: otherTab.tabId, targetId: otherTarget, browserSession: listed.browserSession });
    const held = second.events.find((e) => e.method === "Target.attachedToTarget" && e.params.targetInfo.targetId === otherTarget)!.params.sessionId;

    const driver = newDriver();
    const listing = await driver.listTargets();
    await driver.focusTarget(listing.find((t) => t.title === "list")!.id);
    await driver.prepareTarget();
    const ref = firstText(await driver.observeElements()).split("\n").find((l) => /"new doc"/.test(l))?.match(/^e\d+/)?.[0];
    check("the site's worker is stopped before the click", (await stopSiteWorker()) === "stopped");
    // Only now: a session that auto-attaches while the worker runs is attached to it, and a worker
    // with a debugger on it is not one Chrome has to start again.
    await second.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, held);
    console.log(`[${at()}] clicking "new doc"`);
    let started = Date.now();
    const clicked = await driver.perform("click", { ref });
    console.log(`[${at()}] click answered after ${Date.now() - started} ms: ${JSON.stringify(clicked).slice(0, 220)}`);
    const landed = await Promise.race([
      driver.perform("run_js", { code: "document.title + ' controlled=' + !!navigator.serviceWorker.controller" }).then((r) => r, (e) => ({ value: undefined, note: String(e) })),
      sleep(45_000).then(() => ({ value: undefined, note: "no answer in 45s" })),
    ]);
    console.log(`[${at()}] then: ${JSON.stringify(landed).slice(0, 260)}`);
    check("with a silent second client on the site, the tab a click opens loads", clicked.ok === true && /opened http/.test(clicked.note ?? "")
      && (landed as { value?: unknown }).value === "doc controlled=true" && Date.now() - started < 10_000, `${Date.now() - started} ms`);
    check("...and no client was handed the service worker to resume",
      !second.events.some((e) => e.method === "Target.attachedToTarget" && e.params.targetInfo.type === "service_worker"),
      JSON.stringify(second.events.filter((e) => e.method === "Target.attachedToTarget").map((e) => e.params.targetInfo.type)));
    check("the line is up", server.extensionConnected());
    if (!server.extensionConnected()) {
      // What the unfixed bridge does next, for the record: every new line stalls on the same tab.
      for (let round = 1; round <= 2; round++) {
        await server.ensureExtension().catch((e) => console.log(`[${at()}] reconnect failed: ${e}`));
        console.log(`[${at()}] reconnected (round ${round}): extension connected = ${server.extensionConnected()}`);
        const until = Date.now() + 40_000;
        while (server.extensionConnected() && Date.now() < until) await sleep(500);
        console.log(`[${at()}] round ${round}: extension connected = ${server.extensionConnected()}`);
      }
      throw new Error("the line was lost in part 1; part 2 cannot run");
    }
    second.close();
    second = null;
    await driver.close().catch(() => {});

    // ── 2. A debugger that is not ours does the same ───────────────────────────────────────
    const driver2 = newDriver();
    const plain = await driver2.perform("new_tab", { url: site.url("/plain") });
    check("the session opens a tab of its own", plain.ok === true, JSON.stringify(plain).slice(0, 160));
    check("the site's worker is stopped again", (await stopSiteWorker()) === "stopped");
    const foreign = await own.send("Target.attachToTarget", { targetId: other.targetId, flatten: true });
    await own.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, foreign.sessionId);
    const slowBefore = bridgeLog.length;
    started = Date.now();
    console.log(`[${at()}] new_tab onto the site, with a foreign debugger holding its worker`);
    const stuck = await driver2.perform("new_tab", { url: site.url("/doc?stuck=1") }).then((r) => r, (e) => ({ ok: false, note: String(e) }));
    const stuckMs = Date.now() - started;
    console.log(`[${at()}] new_tab answered after ${stuckMs} ms: ${JSON.stringify(stuck).slice(0, 400)}`);
    const stalled = bridgeLog.slice(slowBefore).some((l) => /slow: Page\.navigate/.test(l));
    if (!stalled) {
      check(`a foreign debugger that resumes nothing stalls the new tab (${product})`, false, JSON.stringify(stuck).slice(0, 200));
    } else {
      // Give the bridge its whole budget, whichever of the driver's and the bridge's ended first.
      await sleep(Math.max(0, COMMAND_TIMEOUT_MS - stuckMs) + 2500);
      const stuckTab = await evalInExtension(rawCdp, `chrome.tabs.query({}).then((ts) => ts.find((t) => (t.pendingUrl || t.url || "").includes("stuck=1"))?.id ?? null)`) as number | null;
      const letGo = bridgeLog.find((l) => /^let go of tab/.test(l)) ?? "";
      check("the bridge lets go of the tab that answers nothing, naming it and its address",
        stuckTab !== null && letGo.includes(`tab ${stuckTab} (${site.url("/doc?stuck=1")})`) && /did not answer/.test(letGo), letGo || "(no line)");
      check("...taking its debugger off it", stuckTab !== null && !(await debuggerOn(stuckTab)));
      check("the line stays up", server.extensionConnected());
      started = Date.now();
      const next = await driver2.perform("run_js", { code: "document.title" }).then((r) => r, (e) => ({ ok: false, value: undefined, note: String(e) }));
      const observed = firstText(await driver2.observeElements());
      console.log(`[${at()}] next verb after ${Date.now() - started} ms: ${JSON.stringify(next).slice(0, 200)}`);
      console.log(`[${at()}] next observation: ${observed.slice(0, 700).replace(/\n/g, " ⏎ ")}`);
      check("the session carries on on another of its tabs", (next as { value?: unknown }).value === "plain", JSON.stringify(next).slice(0, 160));
      check("...and is told which tab was let go of, and why",
        new RegExp(`tab ${stuckTab} \\(${site.url("/doc?stuck=1").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) did not answer`).test(`${stuck.note ?? ""} ${(next as { note?: string }).note ?? ""} ${observed}`),
        `${stuck.note ?? ""} | ${(next as { note?: string }).note ?? ""}`.slice(0, 300));

      // A new line: the tab is still stuck, and still nobody's to wait on.
      const before = bridgeLog.length;
      (server as unknown as { extension: { close(reason: string): void } }).extension.close("test: drop the line");
      await sleep(300);
      await server.ensureExtension();
      await sleep(Math.min(COMMAND_TIMEOUT_MS, 5000) + 1500);
      const after = bridgeLog.slice(before);
      check("a new line does not send the stuck tab a single command",
        !after.some((l) => l.includes(`tab=${stuckTab}`)) && stuckTab !== null && !(await debuggerOn(stuckTab)), after.filter((l) => l.includes(`tab=${stuckTab}`)).slice(0, 3).join(" | "));
      const again = await driver2.perform("run_js", { code: "document.title" }).then((r) => r, (e) => ({ ok: false, value: undefined, note: String(e) }));
      check("...and the session's other tab is reachable on it", (again as { value?: unknown }).value === "plain" && server.extensionConnected(), JSON.stringify(again).slice(0, 200));
    }
  } finally {
    for (const d of drivers) await d.close().catch(() => {});
    second?.close();
    own?.close();
    rawCdp?.close();
    server.stop();
    chrome.cleanup();
    site.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall extension-stalled-tab checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
