/**
 * A tab the PAGE asks for is a real tab, at the tool surface.
 *
 * A `target=_blank` link, a `window.open(url)` and a GET form with a tab target each open a
 * second tab that the session owns and can list, and the page they were clicked on stays as it
 * was: the same in the top document and inside a cross-origin iframe (the partner-embed case:
 * the page is on `localhost`, the frame on `127.0.0.1`). Before, the driver rewrote every such
 * open into a navigation of the clicking frame, so "does this open in a new tab?" could not be
 * checked, and a correct `target=_blank` inside an iframe looked exactly like the bug of
 * loading the destination in the frame.
 *
 * What must NOT become a tab is pinned too: a click the page cancelled, a target that names a
 * frame on the page, a frame sandboxed without allow-popups, an open with no user activation
 * (Chrome's popup blocker refuses it), and a POST form, which stays in its tab and says so.
 */

import { createServer } from "node:http";
import { spawnChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Result = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const allText = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
const line = (s: string, re: RegExp) => (s.split("\n").find((l) => re.test(l)) ?? s.split("\n")[0] ?? "").slice(0, 300);
const returned = <T>(s: string): T | null => {
  try { return JSON.parse(/Returned: (.*)/.exec(s)?.[1] ?? "null") as T; } catch { return null; }
};

const page = (title: string, body: string) => `<!doctype html><title>${title}</title>${body}`;

function serve(): Promise<{ port: number; close: () => void }> {
  const srv = createServer((req, res) => {
    const port = (srv.address() as { port: number }).port;
    const url = new URL(req.url ?? "/", "http://x");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    switch (url.pathname) {
      case "/partner.html":
        // The embed is on another origin (127.0.0.1 against this page's localhost), as a chart
        // shared with a partner site is.
        res.end(page("Partner", `<h1>Partner page</h1>
<iframe src="http://127.0.0.1:${port}/widget.html" width="600" height="160" title="Shared chart"></iframe>
<p><a id="top" href="/orders.html?from=top-link" target="_blank" rel="noopener">Top blank link</a></p>
<p><a id="cancelled" href="/orders.html?from=cancelled" target="_blank">Cancelled link</a></p>
<p><a id="framed" href="/orders.html?from=named" target="inner">Named frame link</a></p>
<button onclick="window.opened = window.open('/orders.html?from=top-open')">Top open</button>
<button onclick="window.opened.close()">Close opened</button>
<form action="/orders.html" target="_blank"><input type="hidden" name="from" value="get-form"><button>Search in a tab</button></form>
<form action="/orders.html?from=post-form" method="post" target="_blank"><button>Post in a tab</button></form>
<iframe name="inner" src="/blank.html" width="300" height="60" title="Inner"></iframe>
<iframe src="/boxed.html" sandbox="allow-scripts allow-same-origin" width="300" height="60" title="Boxed"></iframe>
<iframe src="/loose.html" sandbox="allow-scripts allow-popups" width="300" height="60" title="Loose"></iframe>
<script>document.getElementById('cancelled').addEventListener('click', (e) => e.preventDefault());</script>`));
        return;
      case "/widget.html":
        res.end(page("Widget", `<h2>Revenue by day</h2>
<a class="details" href="/orders.html?from=frame-link" target="_blank" rel="noopener">View details</a>
<button onclick="window.open('/orders.html?from=frame-open')">Frame open</button>`));
        return;
      case "/eager.html":
        // Opened while the document loads: no click, so no user activation.
        res.end(page("Eager", `<h1>Eager page</h1><script>window.early = window.open('/orders.html?from=eager');</script>`));
        return;
      case "/boxed.html":
        // Sandboxed without allow-popups: Chrome opens no tab for this frame.
        res.end(page("Boxed", `<a href="/orders.html?from=boxed" target="_blank">Boxed link</a>`));
        return;
      case "/loose.html":
        // Sandboxed with allow-popups and no allow-same-origin: an opaque origin, where the
        // Navigation API fires no navigate event.
        res.end(page("Loose", `<a href="/orders.html?from=loose" target="_blank">Loose link</a>`));
        return;
      case "/blank.html":
        res.end(page("Blank", "<p>empty frame</p>"));
        return;
      default:
        res.end(page(`Orders ${url.searchParams.get("from") ?? ""}`.trim(), `<h1>Orders page</h1><p>${req.method} ${url.search}</p>`));
    }
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    resolve({ port: (srv.address() as { port: number }).port, close: () => srv.close() });
  }));
}

async function main() {
  const chrome = await spawnChrome({});
  const fixtures = await serve();
  const partner = `http://localhost:${fixtures.port}/partner.html`;
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  delete process.env.COMPUTER_USE_WINDOW;
  delete process.env.COMPUTER_USE_TAB;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const tool = Object.fromEntries(profile.tools.map((t) => [t.name, t.execute]));
  const run = async (code: string) => allText(await tool.computer_repl({ code }) as Result);
  /** This session's tabs by title, and the partner page's own state, read in one run. */
  const STATE = `{ tabs: (await computer.surfaces()).filter((s) => s.mine).map((s) => s.title).sort(),`
    + ` partner: (await w.observe()).url,`
    + ` chart: !!(await w.find('View details', { role: 'link' })) }`;
  type State = { tabs: string[]; partner: string; chart: boolean };
  /** Close every tab but the partner page's, so each case counts from one. */
  const reset = async () => {
    await run(`for (const s of await computer.surfaces()) if (s.mine && s.id !== w.id) await w.closeTab({ id: s.id });`
      + ` await w.openUrl({ url: '${partner}' });`);
  };
  const intact = (s: State | null) => s?.partner === partner && s.chart === true;

  try {
    const first = await run(`const w = await computer.surface(); await w.openUrl({ url: '${partner}' }); return ${STATE};`);
    const start = returned<State>(first);
    check("the partner page shows the embedded chart's link", start?.chart === true && start.tabs.length === 1, line(first, /Returned|STOPPED/));

    // ── target=_blank inside the cross-origin frame ───────────────────────────
    // Click and list in ONE run: a model checks "did a tab open?" right after the click.
    const frameLink = await run(`await w.click(await w.find('View details', { role: 'link' })); return ${STATE};`);
    const afterFrameLink = returned<State>(frameLink);
    check("a _blank link in a cross-origin frame opens a second tab, listed in the same run",
      JSON.stringify(afterFrameLink?.tabs) === JSON.stringify(["Orders frame-link", "Partner"]), line(frameLink, /Returned|STOPPED/));
    check("…and the partner page still shows the chart in its frame", intact(afterFrameLink), line(frameLink, /Returned|STOPPED/));
    const said = frameLink.match(/the page opened a new tab, (t\d+) \(opened ([^)]+)\)/g) ?? [];
    check("…and the click's own line names the new tab, where it landed and how to bind it, once",
      said.length === 1 && said[0]!.includes(`http://127.0.0.1:${fixtures.port}/orders.html?from=frame-link`) && /computer\.surface\('t\d+'\) binds the new one/.test(frameLink),
      line(frameLink, /the page opened a new tab/));
    const where = await run(`const t = await computer.surface((await computer.surfaces()).find((s) => s.title === 'Orders frame-link').id);`
      + ` return { url: (await t.observe()).url, text: await t.text() };`);
    const landed = returned<{ url: string; text: string }>(where);
    check("…and the new tab is the link's destination, on the frame's origin",
      landed?.url === `http://127.0.0.1:${fixtures.port}/orders.html?from=frame-link` && /Orders page/.test(landed.text), line(where, /Returned|STOPPED/));

    // ── window.open inside the cross-origin frame ─────────────────────────────
    await reset();
    const frameOpen = await run(`await w.click(await w.find('Frame open', { role: 'button' })); return ${STATE};`);
    const afterFrameOpen = returned<State>(frameOpen);
    check("window.open in a cross-origin frame opens a second tab",
      JSON.stringify(afterFrameOpen?.tabs) === JSON.stringify(["Orders frame-open", "Partner"]), line(frameOpen, /Returned|STOPPED/));
    check("…and the partner page still shows the chart in its frame", intact(afterFrameOpen), line(frameOpen, /Returned|STOPPED/));

    // ── The same two in the top document ──────────────────────────────────────
    await reset();
    const topLink = await run(`await w.click(await w.find('Top blank link', { role: 'link' }));`
      + ` const s = ${STATE}; return { ...s, target: await w.runJs({ code: "document.getElementById('top').getAttribute('target')" }) };`);
    const afterTopLink = returned<State & { target: string }>(topLink);
    check("a _blank link in the top document opens a second tab",
      JSON.stringify(afterTopLink?.tabs) === JSON.stringify(["Orders top-link", "Partner"]) && intact(afterTopLink), line(topLink, /Returned|STOPPED/));
    check("…and the link still carries its target afterwards", afterTopLink?.target === "_blank", String(afterTopLink?.target));

    await reset();
    const topOpen = await run(`await w.click(await w.find('Top open', { role: 'button' })); const s = ${STATE};`
      + ` return { ...s, handle: await w.runJs({ code: "!!window.opened && window.opened.closed === false" }) };`);
    const afterTopOpen = returned<State & { handle: boolean }>(topOpen);
    check("window.open in the top document opens a second tab",
      JSON.stringify(afterTopOpen?.tabs) === JSON.stringify(["Orders top-open", "Partner"]) && intact(afterTopOpen), line(topOpen, /Returned|STOPPED/));
    check("…and hands the page a window it reads as open", afterTopOpen?.handle === true, line(topOpen, /Returned|STOPPED/));
    const closedIt = await run(`await w.click(await w.find('Close opened', { role: 'button' })); await w.wait({ ms: 300 }); return ${STATE};`);
    check("…which the page can close again", JSON.stringify(returned<State>(closedIt)?.tabs) === JSON.stringify(["Partner"]), line(closedIt, /Returned|STOPPED/));

    // ── A GET form with a tab target ──────────────────────────────────────────
    await reset();
    const getForm = await run(`await w.click(await w.find('Search in a tab', { role: 'button' })); return ${STATE};`);
    const afterGetForm = returned<State>(getForm);
    check("a GET form with target=_blank opens its result in a second tab",
      JSON.stringify(afterGetForm?.tabs) === JSON.stringify(["Orders get-form", "Partner"]) && intact(afterGetForm), line(getForm, /Returned|STOPPED/));

    // ── What must not become a tab ────────────────────────────────────────────
    await reset();
    const cancelled = await run(`await w.click(await w.find('Cancelled link', { role: 'link' })); await w.wait({ ms: 300 }); const s = ${STATE};`
      + ` return { ...s, target: await w.runJs({ code: "document.getElementById('cancelled').getAttribute('target')" }) };`);
    const afterCancelled = returned<State & { target: string }>(cancelled);
    check("a _blank link whose click the page cancelled opens nothing and goes nowhere",
      JSON.stringify(afterCancelled?.tabs) === JSON.stringify(["Partner"]) && intact(afterCancelled), line(cancelled, /Returned|STOPPED/));
    check("…and keeps its target", afterCancelled?.target === "_blank", String(afterCancelled?.target));

    const named = await run(`await w.click(await w.find('Named frame link', { role: 'link' })); await w.wait({ ms: 500 }); const s = ${STATE};`
      + ` return { ...s, inner: await w.runJs({ code: "document.querySelector('iframe[name=inner]').contentDocument.title" }) };`);
    const afterNamed = returned<State & { inner: string }>(named);
    check("a link that targets a frame on the page loads in that frame, not in a tab",
      JSON.stringify(afterNamed?.tabs) === JSON.stringify(["Partner"]) && intact(afterNamed) && afterNamed?.inner === "Orders named", line(named, /Returned|STOPPED/));

    await reset();
    const boxed = await run(`await w.click(await w.find('Boxed link', { role: 'link' })); await w.wait({ ms: 500 }); const s = ${STATE};`
      + ` return { ...s, still: !!(await w.find('Boxed link', { role: 'link' })) };`);
    const afterBoxed = returned<State & { still: boolean }>(boxed);
    check("a _blank link in a frame sandboxed without allow-popups opens nothing, as in Chrome",
      JSON.stringify(afterBoxed?.tabs) === JSON.stringify(["Partner"]) && intact(afterBoxed) && afterBoxed?.still === true, line(boxed, /Returned|STOPPED/));
    check("…and the run says the sandbox blocked it", /sandbox attribute has no allow-popups/.test(boxed), line(boxed, /allow-popups|Returned|STOPPED/));

    const loose = await run(`await w.click(await w.find('Loose link', { role: 'link' })); return ${STATE};`);
    const afterLoose = returned<State>(loose);
    check("a _blank link in an opaque-origin frame that allows popups opens a second tab",
      JSON.stringify(afterLoose?.tabs) === JSON.stringify(["Orders loose", "Partner"]) && intact(afterLoose), line(loose, /Returned|STOPPED/));

    await reset();
    const post = await run(`await w.click(await w.find('Post in a tab', { role: 'button' })); await w.wait({ ms: 500 });`
      + ` return { tabs: (await computer.surfaces()).filter((s) => s.mine).map((s) => s.title).sort(), text: await w.text() };`);
    const afterPost = returned<{ tabs: string[]; text: string }>(post);
    check("a POST form with target=_blank is submitted, in its own tab",
      JSON.stringify(afterPost?.tabs) === JSON.stringify(["Orders post-form"]) && /POST/.test(afterPost?.text ?? ""), line(post, /Returned|STOPPED/));
    check("…and the run says the form asked for a new tab", /asked for a new tab/.test(post), line(post, /asked for a new tab|Returned|STOPPED/));

    const eager = await run(`await w.openUrl({ url: 'http://localhost:${fixtures.port}/eager.html' }); await w.wait({ ms: 500 });`
      + ` return { tabs: (await computer.surfaces()).filter((s) => s.mine).map((s) => s.title).sort(), early: await w.runJs({ code: "String(window.early)" }), url: (await w.observe()).url };`);
    const afterEager = returned<{ tabs: string[]; early: string; url: string }>(eager);
    check("window.open with no click behind it is left to Chrome's popup blocker",
      JSON.stringify(afterEager?.tabs) === JSON.stringify(["Eager"]) && afterEager?.early === "null" && /eager\.html$/.test(afterEager.url), line(eager, /Returned|STOPPED/));
  } finally {
    chrome.cleanup();
    fixtures.close();
    delete process.env.COMPUTER_USE_OBS_DELTA;
  }

  console.log(failures === 0 ? "\nPAGE-OPENED TABS OK" : `\nPAGE-OPENED TABS FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
