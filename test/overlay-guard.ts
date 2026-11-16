/**
 * The extension-mode overlay guard tells a layer in the way from a layer being acted on —
 * `node scripts/test.mjs overlay-guard`.
 *
 * In the user's own browser another extension can put a layer over the page with no trace in an
 * observation (a password manager's panel), so before a verb the driver looks at what sits over
 * the middle of the viewport and refuses to act through a fixed layer at the top of the stacking
 * order. It refused the same way when the verb's target was INSIDE that layer: a site's own
 * consent dialog at z-index 2147483647 could not be answered, and the refusal said to close the
 * layer first, which is what the refused click was for.
 *
 * Against a throwaway headless Chrome, driven as extension mode drives a browser (the guard is
 * on in that mode only): a control inside such a layer is acted on, and so is a key press while
 * the focus is in it; a control under it is still refused, and so is a click at a point outside it.
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
const line = (s: string, re: RegExp) => (s.split("\n").find((l) => re.test(l)) ?? s.split("\n")[0] ?? "").slice(0, 300);
const returned = <T>(s: string): T | null => {
  try { return JSON.parse(/Returned: (.*)/.exec(s)?.[1] ?? "null") as T; } catch { return null; }
};

/** A page with a consent dialog of its own at the very top of the stacking order, over the middle
 *  of the viewport, and a control of the page under it. */
const CONSENT = `<!doctype html><title>Consent</title><h1>Shop</h1>
<button style="position:absolute;left:45%;top:45%" onclick="document.title = 'bought'">Buy now</button>
<div id="consent" role="dialog" aria-label="Cookies" style="position:fixed;left:20%;top:20%;width:60%;height:60%;z-index:2147483647;background:#fff;border:1px solid #333">
<p>We use cookies.</p><input aria-label="Email for updates">
<button onclick="document.getElementById('consent').remove(); document.title = 'accepted'">Accept all</button></div>`;

function serve(): Promise<{ base: string; close: () => void }> {
  const srv = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(CONSENT); });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    resolve({ base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() });
  }));
}

async function main() {
  const chrome = await spawnChrome({});
  const fixtures = await serve();
  // Extension mode, with the endpoint named as a host that runs the bridge names it.
  process.env.COMPUTER_USE_BROWSER = "extension";
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  delete process.env.COMPUTER_USE_WINDOW;
  delete process.env.COMPUTER_USE_TAB;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const tool = Object.fromEntries(profile.tools.map((t) => [t.name, t.execute]));
  const run = async (code: string) => allText(await tool.computer_repl({ code, observation: "none" }) as Result);
  const attempt = (verb: string) => `let said; try { said = String(await ${verb}); } catch (e) { said = 'threw: ' + e.message; } return { said, title: await w.runJs({ code: 'document.title' }) };`;
  type Tried = { said: string; title: string };

  try {
    await run(`const w = await computer.surface(); await w.openUrl({ url: '${fixtures.base}/' });`);

    const typed = await run(attempt(`w.setText(await w.find('Email for updates'), 'a@b.c')`));
    check("a field inside the page's own top layer is written to", !/threw|overlay is over the page/.test(returned<Tried>(typed)?.said ?? "threw"), line(typed, /Returned|STOPPED/));

    const under = await run(`const buy = (await w.find('Buy now', { why: true })); ${attempt(`w.click(buy.match ? buy.match.ref : buy)`)}`);
    const u = returned<Tried>(under);
    check("a control under that layer is still not clicked", !!u && /threw/.test(u.said) && u.title === "Consent", line(under, /Returned|STOPPED/));

    const point = await run(attempt(`w.click({ x: 30, y: 30 })`));
    const p = returned<Tried>(point);
    check("a click at a point outside the layer is still refused while the layer is up",
      !!p && /another extension or overlay is over the page/.test(p.said), line(point, /Returned|STOPPED/));

    const keyed = await run(attempt(`w.keys('Tab')`));
    check("a key press goes ahead while the focus is inside the layer", !/threw/.test(returned<Tried>(keyed)?.said ?? "threw"), line(keyed, /Returned|STOPPED/));

    const accepted = await run(attempt(`w.click(await w.find('Accept all', { role: 'button' }))`));
    const a = returned<Tried>(accepted);
    check("the layer's own button is clicked, which is how it is dismissed", !!a && !/threw/.test(a.said) && a.title === "accepted", line(accepted, /Returned|STOPPED/));

    const after = await run(attempt(`w.click(await w.find('Buy now', { role: 'button' }))`));
    check("...and with the layer gone the page's control is clicked", returned<Tried>(after)?.title === "bought", line(after, /Returned|STOPPED/));
  } finally {
    await Promise.all(profile.drivers.map((d) => d.close().catch(() => {})));
    fixtures.close();
    chrome.cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall overlay-guard checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
