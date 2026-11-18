/**
 * The managed browser opens a session's first tab ON the page it was asked for —
 * `node scripts/test.mjs managed-first-page`.
 *
 * Before, a session put a blank window on the screen before it had anything to show: its first
 * touch (`computer.surface()`, a listing) launched the browser and claimed a blank tab, and the
 * page came only with the agent's openUrl, a call later. Under a named claim (Mirasim's managed
 * sessions) a launch left TWO windows: the launch's own blank one, which nobody ever used, and
 * the session's. Pinned here, on a real managed launch:
 *
 *   · reading before anything was opened launches no browser and claims no tab;
 *   · the first open_url launches it with ONE window, on that page;
 *   · on a browser already running, the session's tab is created on its page, never about:blank
 *     first — and nothing is opened before the open_url;
 *   · the tab still carries the session's claim (a respawned driver re-adopts it), a redirect is
 *     still reported, and a load that fails is answered with its reason, as goto answers it;
 *   · through the tool: computer.surface() hands back the stand-in and its openUrl opens the tab.
 */

import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type CDPSession } from "playwright-core";
import { browserPids, killByProfileDir, readDevToolsPort } from "../src/platform/browser/acquire.ts";
import { BrowserDriver } from "../src/platform/browser/driver.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A fallback endpoint nothing listens on: the test must never adopt a Chrome on :9222. */
const NO_ENDPOINT = "http://127.0.0.1:1";

function serve(): Promise<{ base: string; close: () => void }> {
  const srv = createServer((req, res) => {
    if (req.url === "/r") { res.writeHead(302, { location: "/b" }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Page ${req.url === "/b" ? "B" : "A"}</title><button>Go</button>`);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    resolve({ base: `http://127.0.0.1:${port}`, close: () => srv.close() });
  }));
}

/** An address nothing answers on: a port that was free a moment ago. */
function closedPort(): Promise<string> {
  const srv = createServer();
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(`http://127.0.0.1:${port}/`));
  }));
}

/** A driver born with this claim on this profile (both are read at construction). */
function driver(profile: string, tab: string | undefined): BrowserDriver {
  process.env.COMPUTER_USE_PROFILE_DIR = profile;
  if (tab === undefined) delete process.env.COMPUTER_USE_TAB;
  else process.env.COMPUTER_USE_TAB = tab;
  return new BrowserDriver(undefined, NO_ENDPOINT);
}

/** Every page target of the managed browser on `profile`: its url and window. */
async function pages(profile: string): Promise<{ url: string; windowId: number }[]> {
  const port = readDevToolsPort(profile);
  if (port === null) return [];
  const probe = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const s = await probe.newBrowserCDPSession();
    const { targetInfos } = await s.send("Target.getTargets");
    const out = [];
    for (const t of targetInfos.filter((t) => t.type === "page")) {
      const { windowId } = await s.send("Browser.getWindowForTarget", { targetId: t.targetId });
      out.push({ url: t.url, windowId });
    }
    return out;
  } finally {
    await probe.close();
  }
}

/** Record the FIRST url each page target reports, from the moment it is created. */
async function watchNewTabs(profile: string): Promise<{ firstUrls: string[]; stop: () => Promise<void> }> {
  const probe = await chromium.connectOverCDP(`http://127.0.0.1:${readDevToolsPort(profile)}`);
  const s: CDPSession = await probe.newBrowserCDPSession();
  const firstUrls: string[] = [];
  const known = new Set<string>();
  s.on("Target.targetCreated", (e) => {
    if (e.targetInfo.type !== "page" || known.has(e.targetInfo.targetId)) return;
    known.add(e.targetInfo.targetId);
    firstUrls.push(e.targetInfo.url);
  });
  await s.send("Target.setDiscoverTargets", { discover: true });
  // The targets already there are announced at once; they are not new.
  await new Promise((r) => setTimeout(r, 200));
  firstUrls.length = 0;
  return { firstUrls, stop: () => probe.close() };
}

async function main() {
  const site = await serve();
  const A = `${site.base}/a`;
  const B = `${site.base}/b`;
  const named = mkdtempSync(join(tmpdir(), "cu-first-page-named-"));
  const plain = mkdtempSync(join(tmpdir(), "cu-first-page-plain-"));
  const viaTool = mkdtempSync(join(tmpdir(), "cu-first-page-tool-"));
  process.env.COMPUTER_USE_WINDOW = "offscreen";
  const open: BrowserDriver[] = [];
  const track = (d: BrowserDriver) => { open.push(d); return d; };

  try {
    // ── A named claim (Mirasim's managed sessions), nothing running yet ──
    const a = track(driver(named, "name:first-a"));
    const listed = await a.listTargets();
    check("a listing before anything was opened lists nothing", listed.length === 0, JSON.stringify(listed));
    check("…and holds no tab yet", (await a.heldNothing()) === "not-yet");
    const looked = await a.observeElements();
    const lookedText = looked.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    check("an observation before anything was opened says the session holds no tab yet", /holds no tab yet/.test(lookedText), lookedText.slice(0, 160));
    check("none of that launched a browser", readDevToolsPort(named) === null && (await browserPids(named)).length === 0);

    const first = await a.perform("open_url", { url: A });
    check("the first open_url opens the page", first.ok && first.note === `opened ${A}`, JSON.stringify(first));
    const launched = await pages(named);
    check("the launch opened ONE tab, in one window, on that page — no blank window beside it",
      launched.length === 1 && launched[0]!.url === A, JSON.stringify(launched));
    check("the session is on it", (await a.currentUrl()) === A, await a.currentUrl());
    await a.close();

    // The claim survives the open: a respawned driver with the same key finds that tab.
    const again = track(driver(named, "name:first-a"));
    const back = await again.listTargets();
    check("a respawned driver re-adopts the tab by its claim", back.length === 1 && back[0]!.title === "Page A", JSON.stringify(back));
    check("…without opening another", (await pages(named)).length === 1);
    await again.close();

    // ── A second session on the running browser ──
    const watch = await watchNewTabs(named);
    const b = track(driver(named, "name:first-b"));
    check("a second session's listing opens nothing", (await b.listTargets()).length === 0 && (await pages(named)).length === 1);
    const redirected = await b.perform("open_url", { url: `${site.base}/r` });
    check("its open_url reports the redirect, as goto does", redirected.ok && redirected.note === `${site.base}/r redirected to ${B}`, JSON.stringify(redirected));
    await new Promise((r) => setTimeout(r, 200));
    check("its tab was created on the page, never on about:blank first",
      watch.firstUrls.length === 1 && watch.firstUrls[0] === `${site.base}/r`, JSON.stringify(watch.firstUrls));
    await watch.stop();
    const bText = await b.readText().catch((e) => String(e));
    check("the session reads the page it opened", /Go/.test(bText), bText.slice(0, 120));
    await b.close();

    // A load that fails is answered with its reason, as on a tab that already existed.
    const c = track(driver(named, "name:first-c"));
    const refused = await c.perform("open_url", { url: await closedPort() });
    check("a load that fails says why", !refused.ok && /ERR_CONNECTION_REFUSED/.test(refused.note ?? ""), JSON.stringify(refused));
    await c.close();
    const c2 = track(driver(named, "name:first-c"));
    const cBack = await c2.listTargets();
    check("…and its tab keeps the claim", cBack.length === 1, JSON.stringify(cBack));
    await c2.close();

    // ── No claim (the open-source server's default), nothing running yet ──
    const p = track(driver(plain, undefined));
    check("default mode: a listing launches nothing", (await p.listTargets()).length === 0 && readDevToolsPort(plain) === null);
    const opened = await p.perform("open_url", { url: A });
    const plainPages = await pages(plain);
    check("default mode: the first open_url launches the browser on that page, one tab",
      opened.ok && plainPages.length === 1 && plainPages[0]!.url === A, `${JSON.stringify(opened)} ${JSON.stringify(plainPages)}`);
    await p.close();

    // ── Through the tool, as an agent writes it ──
    process.env.COMPUTER_USE_PROFILE_DIR = viaTool;
    process.env.COMPUTER_USE_TAB = "name:first-tool";
    delete process.env.COMPUTER_USE_CDP_URL;
    process.env.COMPUTER_USE_OBS_DELTA = "0";
    const { resolveProfile } = await import("../src/platform/profile.ts");
    const profile = resolveProfile({ driver: "browser" });
    const tool = Object.fromEntries(profile.tools.map((t) => [t.name, t.execute]));
    type Result = { content: Array<{ type: string; text?: string }> };
    const run = async (code: string) => (await tool.computer_repl({ code }) as Result).content.map((x) => x.text ?? "").join("\n");
    const bound = await run(`const w = await computer.surface(); return w.id;`);
    check("computer.surface() before any page hands back the stand-in, and launches nothing",
      /Returned: new\b/.test(bound) && readDevToolsPort(viaTool) === null, bound.split("\n").find((l) => /Returned|STOPPED/.test(l)));
    const went = await run(`await w.openUrl({ url: '${A}' }); return w.title;`);
    const toolPages = await pages(viaTool);
    check("its openUrl opens the one tab, on the page", /Returned: Page A\b/.test(went) && toolPages.length === 1 && toolPages[0]!.url === A,
      `${went.split("\n").find((l) => /Returned|STOPPED/.test(l))} ${JSON.stringify(toolPages)}`);
    await profile.driver.close();
  } finally {
    for (const d of open) await d.close().catch(() => {});
    for (const dir of [named, plain, viaTool]) await killByProfileDir(dir);
    site.close();
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
