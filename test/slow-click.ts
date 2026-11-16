/**
 * A click the page is slow to handle is still a click — `node scripts/test.mjs slow-click`.
 *
 * A click is tried in attempts of 2 s, so that a cover over the target is named early. But 2 s
 * was also all a click got once it had been SENT: a Save whose handler works for 3 s came back
 * as "the click was sent but not confirmed within 2s", thrown, and the run stopped on a click
 * that had worked. And a page that was merely busy after a click was told apart from nothing: it
 * was reported as "started a navigation that was still loading", on a page that goes nowhere.
 *
 * Pinned here against a throwaway headless Chrome:
 *
 *   · a click whose handler runs for 3 s succeeds, the run goes on, and it says the page was busy;
 *   · a page busy AFTER a click that does not navigate is not said to be navigating;
 *   · a click that does start a slow navigation still says so;
 *   · a page that answers nothing for the whole budget is refused as before, with the real wait.
 */

import { createServer } from "node:http";
import { spawnChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Result = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const allText = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").split("\nAPI reference")[0]!;
const line = (s: string, re: RegExp) => (s.split("\n").find((l) => re.test(l)) ?? s.split("\n")[0] ?? "").slice(0, 280);
const returned = <T>(s: string): T | null => {
  try { return JSON.parse(/Returned: (.*)/.exec(s)?.[1] ?? "null") as T; } catch { return null; }
};

const page = (title: string, body: string) => `<!doctype html><title>${title}</title>${body}`;
/** Occupy the main thread for `ms`. */
const BUSY = "function busy(ms) { const end = Date.now() + ms; while (Date.now() < end) {} }";

function serve(): Promise<{ base: string; close: () => void }> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (body: string) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
    switch (url.pathname) {
      case "/save.html": {
        // The handler itself is the slow part: the page answers nothing until it returns.
        const ms = Number(url.searchParams.get("ms") ?? 3000);
        return html(page("Save", `<h1>Editor</h1><button onclick="busy(${ms}); document.getElementById('o').textContent = 'saved'">Save</button><p id="o">idle</p><script>${BUSY}</script>`));
      }
      case "/export.html":
        // The handler returns at once; the work it queued keeps the page busy afterwards, in
        // stretches, and nothing navigates.
        return html(page("Export", `<h1>Report</h1><button onclick="document.getElementById('o').textContent = 'started'; let n = 0; const step = () => { busy(900); if (++n < 5) setTimeout(step, 4); else document.getElementById('o').textContent = 'exported'; }; setTimeout(step, 0)">Export</button><p id="o">idle</p><script>${BUSY}</script>`));
      case "/pay.html":
        return html(page("Checkout", `<form action="/paid" method="post"><button type="submit">Pay</button></form>`));
      case "/paid":
        // A server slow to answer: the navigation is under way long after the click returned.
        setTimeout(() => html(page("Paid", "<h1>Payment received</h1>")), 3500);
        return;
      default:
        return html(page("404", "nope"));
    }
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
  /** Click the page's one button, then read what the page shows: the click's own words, how long
   *  it took, and that the code after it ran. */
  const CLICK = (name: string) => `const t = Date.now(); let said; try { said = String(await w.click(await w.find('${name}', { role: 'button' }))); } catch (e) { said = 'threw: ' + e.message; }`
    + ` const ms = Date.now() - t; return { said, ms, shows: await w.runJs({ code: "document.getElementById('o')?.textContent ?? document.title" }) };`;
  type Clicked = { said: string; ms: number; shows: string };

  try {
    await run(`const w = await computer.surface(); await w.openUrl({ url: '${fixtures.base}/save.html?ms=3000' });`);
    const save = await run(CLICK("Save"));
    const saved = returned<Clicked>(save);
    check("a click the page takes 3 s to handle succeeds, and the code after it runs",
      !!saved && !/threw/.test(saved.said) && saved.shows === "saved" && !/STOPPED/.test(save), line(save, /Returned|STOPPED/));
    check("...saying the page was busy handling it, and for about how long",
      !!saved && /the page was busy for 3(\.\d)?s handling it/.test(saved.said) && saved.ms >= 2900 && saved.ms < 6000, `${saved?.ms} ms: ${saved?.said}`);
    check("...and never that a navigation started", !!saved && !/navigation/.test(save), line(save, /navigation|Returned/));

    await run(`await w.openUrl({ url: '${fixtures.base}/export.html' });`);
    const exported = await run(CLICK("Export"));
    const exporting = returned<Clicked>(exported);
    check("a page busy after a click that goes nowhere is not said to be navigating",
      !!exporting && !/threw/.test(exporting.said) && !/navigation/.test(exported) && /started|exported/.test(exporting.shows), line(exported, /Returned|STOPPED/));

    await run(`await w.openUrl({ url: '${fixtures.base}/pay.html' });`);
    const pay = await run(`const said = String(await w.click(await w.find('Pay', { role: 'button' }))); await w.wait({ text: 'Payment received', ms: 8000 }); return { said };`);
    check("a click that starts a slow navigation still says so",
      /started a navigation that was still loading/.test(returned<{ said: string }>(pay)?.said ?? "") && !/STOPPED/.test(pay), line(pay, /Returned|STOPPED/));

    await run(`await w.openUrl({ url: '${fixtures.base}/save.html?ms=12000' });`);
    const stuck = returned<Clicked>(await run(`const t = Date.now(); let said; try { said = String(await w.click(await w.find('Save', { role: 'button' }))); } catch (e) { said = 'threw: ' + e.message; } return { said, ms: Date.now() - t, shows: '' };`));
    check("a page that answers nothing for the whole budget is refused as not confirmed, with the wait it really had",
      !!stuck && /threw: .*the click was sent, and the page has not answered in the 8(\.\d)?s since — it may have landed/.test(stuck.said) && stuck.ms >= 7500 && stuck.ms < 11_000,
      `${stuck?.ms} ms: ${stuck?.said}`);
  } finally {
    await Promise.all(profile.drivers.map((d) => d.close().catch(() => {})));
    fixtures.close();
    chrome.cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall slow-click checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
