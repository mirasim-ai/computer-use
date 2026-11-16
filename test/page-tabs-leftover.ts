/**
 * What the page-tabs script leaves behind, and what a reconnect brings back —
 * `node scripts/test.mjs page-tabs-leftover`.
 *
 * So that a tab a page asks for is opened by the driver, in the background, the driver puts a
 * script into every page (page-tabs.ts): it takes over `window.open` and the clicks on links and
 * forms that ask for a new tab. Two things went wrong at the edges of a session:
 *
 *   · When the session ended, the script stayed in the documents already loaded. The tabs stay
 *     open by design, so the person went on using a page where every new-tab link waited a
 *     second for a driver that was gone, and `window.open` handed the page's own code a stand-in
 *     that is no window (reading `.document` off it throws).
 *   · When the driver disconnected and connected again (every turn of a host that ends turns),
 *     the script was NOT put back: the flag that says "installed" outlived the connection it was
 *     about. From the second turn on Chrome opened those tabs itself.
 *
 * Both are pinned against a throwaway headless Chrome, the person played by a second, plain CDP
 * connection whose clicks are real input.
 */

import { createServer } from "node:http";
import { chromium, type Page } from "playwright-core";
import { sleep, spawnChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Result = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const allText = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").split("\nAPI reference")[0]!;
const line = (s: string, re: RegExp) => (s.split("\n").find((l) => re.test(l)) ?? s.split("\n")[0] ?? "").slice(0, 280);

const page = (title: string, body: string) => `<!doctype html><title>${title}</title>${body}`;

function serve(): Promise<{ base: string; close: () => void }> {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if ((req.url ?? "").startsWith("/app")) {
      // The button keeps what window.open gave it and uses it as a window, as a page that
      // writes into, or talks to, the window it opened does.
      res.end(page("App", `<h1>App</h1><a id="link" href="/doc?from=link" target="_blank">Open document</a>
<button id="open" onclick="const w = window.open('/doc?from=open'); try { window.got = typeof w.document; } catch (e) { window.got = 'threw'; }">Open by script</button>`));
    } else res.end(page("Doc", "<h1>Document</h1>"));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    resolve({ base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() });
  }));
}

async function main() {
  const chrome = await spawnChrome({});
  const fixtures = await serve();
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  delete process.env.COMPUTER_USE_WINDOW;
  delete process.env.COMPUTER_USE_TAB;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const tool = Object.fromEntries(profile.tools.map((t) => [t.name, t.execute]));
  const run = async (code: string) => allText(await tool.computer_repl({ code, observation: "none" }) as Result);

  /** The person: a plain connection, a real click on `selector`, and how long until a tab opens. */
  const person = async <T>(work: (app: Page, clickFor: (selector: string) => Promise<number>) => Promise<T>): Promise<T> => {
    const browser = await chromium.connectOverCDP(chrome.cdpUrl);
    try {
      const context = browser.contexts()[0]!;
      const app = context.pages().find((p) => p.url().includes("/app"))!;
      return await work(app, async (selector) => {
        const before = context.pages().length;
        const box = (await app.locator(selector).boundingBox())!;
        const started = Date.now();
        await app.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        for (let i = 0; i < 80; i++) { if (context.pages().length > before) return Date.now() - started; await sleep(25); }
        return -1;
      });
    } finally {
      await browser.close();
    }
  };

  /** The page the session left open, as the person finds it. */
  const leftAsItWas = (when: string) => person(async (app, clickFor) => {
    const state = await app.evaluate("({ patched: !!window.__computerUsePageTabs, native: /\\[native code\\]/.test(String(window.open)) })") as { patched: boolean; native: boolean };
    check(`${when}, the script is taken out of the page it leaves open`, !state.patched && state.native, JSON.stringify(state));
    const linkMs = await clickFor("#link");
    check("...the person's click on a new-tab link opens its tab at once", linkMs >= 0 && linkMs < 600, `${linkMs} ms`);
    const openMs = await clickFor("#open");
    const got = await app.evaluate("window.got");
    check("...and window.open hands the page a real window again", openMs >= 0 && openMs < 600 && got === "object", `${openMs} ms, typeof w.document: ${String(got)}`);
  });

  try {
    // ── While the session drives the page, the script is there ───────────────────────────────
    await run(`const w = await computer.surface(); await w.openUrl({ url: '${fixtures.base}/app' });`);
    const first = await run(`return await w.click(await w.find('Open document', { role: 'link' }));`);
    check("while the session is connected, a tab the page asks for is opened by the driver", /the page opened a new tab/.test(first), line(first, /click|STOPPED/));

    // ── After the session ended, the page is the page's own again ────────────────────────────
    for (const driver of profile.drivers) await driver.close();
    await leftAsItWas("when the session ends");

    // ── After a disconnect and a reconnect the script is there again ─────────────────────────
    // What ending a turn does to a driver (entries/mcp.ts): close, and connect again on the next call.
    const again = await run(`const w2 = await computer.surface('App'); return await w2.click(await w2.find('Open document', { role: 'link' }));`);
    check("after the driver disconnected and connected again, such a tab is still opened by the driver",
      /the page opened a new tab/.test(again), line(again, /click|STOPPED/));

    // ...and taken out again when that connection ends, from a document loaded under it.
    await run(`await w2.openUrl({ url: '${fixtures.base}/app' });`);
    for (const driver of profile.drivers) await driver.close();
    await leftAsItWas("when the second connection ends");
  } finally {
    await Promise.all(profile.drivers.map((d) => d.close().catch(() => {})));
    fixtures.close();
    chrome.cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall page-tabs-leftover checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
