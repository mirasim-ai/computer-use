/**
 * A site with a Service Worker, driven by two sessions that share one browser —
 * `node scripts/test.mjs service-worker-site`.
 *
 * The shape of the site where a tab once stopped answering for good: every page is controlled
 * by the site's Service Worker, the list page opens a document in a new tab with `window.open`,
 * and the worker has been stopped for idleness, so the new tab's navigation has to start it
 * again. Every debugging session on the site is attached to a worker Chrome starts, and the
 * navigation waits until each of them has let it run.
 *
 * On the extension bridge that is pinned by `bridge-stalled-tab` and `extension-stalled-tab`.
 * This is the same site straight over CDP, the way the managed browser is driven, with what a
 * host that runs several sessions has: two sessions, a named tab each, on two pages of the site.
 * Round after round, the worker is stopped, one session clicks, and its new tab has to load under
 * the worker while the other session goes on answering.
 */

import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { BrowserDriver } from "../src/platform/browser/driver.ts";
import { sleep, spawnChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const ROUNDS = 4;
const firstText = (r: { content: Array<{ type: string; text?: string }> }) => r.content.find((c) => c.type === "text")?.text ?? "";

/** A site whose Service Worker controls every page, and whose list pages open a document in a new tab. */
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
    else res.end(`<title>${path === "/other" ? "other" : "list"}</title><h1>LIST</h1>
<button onclick="window.open('/doc?n=' + Date.now())">new doc</button>
<script>navigator.serviceWorker.register('/sw.js');</script>`);
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as { port: number }).port;
  return { url: (path) => `http://localhost:${port}${path}`, close: () => srv.close() };
}

/** A driver born with this COMPUTER_USE_TAB value (the field is captured at construction). */
function driverWithTab(tab: string, cdpUrl: string): BrowserDriver {
  process.env.COMPUTER_USE_TAB = tab;
  return new BrowserDriver(cdpUrl);
}

/** `work`'s answer, or null when it had none within `ms`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return await Promise.race([work.catch(() => null), sleep(ms).then(() => null)]);
}

async function main() {
  const chrome = await spawnChrome({});
  const site = await serveSite();
  delete process.env.COMPUTER_USE_WINDOW;
  const alpha = driverWithTab("name:alpha", chrome.cdpUrl);
  const beta = driverWithTab("name:beta", chrome.cdpUrl);
  const value = async (driver: BrowserDriver, code: string) => (await driver.perform("run_js", { code }) as { value?: unknown }).value;

  /** Stop the site's worker, as Chrome does to an idle one, from a connection of its own that is
   *  gone again before anybody clicks. Answers the worker's status afterwards. */
  const stopSiteWorker = async (): Promise<string> => {
    const probe = await chromium.connectOverCDP(chrome.cdpUrl);
    try {
      const page = probe.contexts()[0]!.pages().find((p) => p.url().startsWith(site.url("/")))!;
      const session = await probe.contexts()[0]!.newCDPSession(page);
      const versions = new Map<string, { versionId: string; scriptURL: string; runningStatus: string }>();
      session.on("ServiceWorker.workerVersionUpdated", (e) => { for (const v of e.versions) versions.set(v.versionId, v); });
      await session.send("ServiceWorker.enable");
      await sleep(300);
      for (const v of [...versions.values()]) {
        if (v.scriptURL.startsWith(site.url("")) && v.runningStatus !== "stopped") await session.send("ServiceWorker.stopWorker", { versionId: v.versionId });
      }
      await sleep(500);
      await session.send("ServiceWorker.disable");
      return [...versions.values()].filter((v) => v.scriptURL.startsWith(site.url(""))).map((v) => v.runningStatus).join(",");
    } finally {
      await probe.close();
    }
  };

  try {
    check("the first session opens the site's list page", (await alpha.perform("open_url", { url: site.url("/") })).ok);
    check("the second session opens another page of the site", (await beta.perform("open_url", { url: site.url("/other") })).ok);
    for (const [name, driver] of [["first", alpha], ["second", beta]] as const) {
      let controlled: unknown = false;
      for (let i = 0; i < 80 && controlled !== true; i++) { controlled = await value(driver, "!!navigator.serviceWorker.controller"); if (controlled !== true) await sleep(100); }
      check(`the ${name} session's page is controlled by the site's worker`, controlled === true);
    }

    for (let round = 1; round <= ROUNDS; round++) {
      const stopped = await stopSiteWorker();
      const listing = await alpha.listTargets();
      const list = listing.find((t) => t.title === "list");
      if (list && !list.active) await alpha.focusTarget(list.id);
      const ref = firstText(await alpha.observeElements()).split("\n").find((l) => /"new doc"/.test(l))?.match(/^e\d+/)?.[0];
      const started = Date.now();
      const clicked = await within(alpha.perform("click", { ref }), 30_000);
      const landed = await within(value(alpha, "document.title + ' controlled=' + !!navigator.serviceWorker.controller"), 15_000);
      const ms = Date.now() - started;
      check(`round ${round}: with the worker ${stopped || "unknown"}, the tab a click opens loads under the worker`,
        clicked?.ok === true && /the page opened a new tab/.test(clicked.note ?? "") && landed === "doc controlled=true" && ms < 10_000,
        `${ms} ms: ${JSON.stringify(clicked ?? "no answer in 30 s").slice(0, 140)} → ${String(landed)}`);
      const other = await within(value(beta, "document.title"), 5_000);
      check(`round ${round}: ...and the other session's page on the site still answers`, other === "other", String(other));
      await alpha.perform("close_tab", {});
    }
  } finally {
    await alpha.close().catch(() => {});
    await beta.close().catch(() => {});
    site.close();
    chrome.cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall service-worker-site checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
