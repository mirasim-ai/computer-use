/**
 * The post-action wait, through the test harness, against a real throwaway Chrome.
 *
 * A CONTROLLED component does not change when the click lands — it changes when the round trip
 * the click started comes back. An observation taken at the former instant and worded as a
 * verdict about the latter reports a switch that worked as "moved the focus but changed nothing
 * else on the page".
 *
 * What is pinned here:
 *  - a delayed, property-only state flip is waited for, and no accusation is made;
 *  - the OPPOSITE failure: a click that really does nothing must still be accused — the wait
 *    must not swallow the signal that stops re-click loops;
 *  - a click that lands immediately pays nothing (measured), nor one whose effect is already on
 *    screen as geometry, focus or scroll — unless it is a toggle whose state is still in flight;
 *  - `wait({})`: a quiet page settles in well under its old 300 ms floor, a render that waits on
 *    a request is waited for (the old text-only rule returned before it), and a page that keeps
 *    changing is not taken as done;
 *  - the FORMAT the wait depends on: `collect.ts` puts `focused` outermost in the state string, and
 *    `substantiveElementSignature` cancels it by that shape. If that changes, the wait stops
 *    firing silently and nothing else in the repo would notice.
 *
 * It is `node scripts/test.mjs settle-controlled`.
 */

import { createServer } from "node:http";
import { spawnChrome } from "./helpers.ts";
import { disclosureClosed, elementSignature, onlyRefsLost, substantiveElementSignature } from "../src/platform/driver-settle.ts";
import type { Element } from "../src/platform/types.ts";
import { createHarness } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";

const page = (body: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>settle fixture</title>${body}`)}`;

/**
 * The controlled shape: the click is swallowed by `preventDefault` (the DOM does NOT move on its
 * own), and 400ms later the "frame" arrives and sets the state — as a PROPERTY, exactly as React
 * does for `checked={...}`, which is why nothing but a re-read can see it.
 */
const FIXTURE_CONTROLLED = page(`
<input type="checkbox" aria-label="Auto close browser"
       onclick="event.preventDefault(); var el = this; setTimeout(function () { el.checked = true; }, 400)">
<button aria-label="Inert">Do nothing</button>
<button aria-label="Writes" onclick="document.getElementById('out').textContent = 'written'">Write text</button>
<div id="out">nothing yet</div>
<input type="checkbox" aria-label="Instant">`);

/**
 * The late-mount shape: the click closes a menu at once (the DOM only LOSES elements) and the
 * dialog the menu item opens mounts a render later. An observation taken at the click shows a
 * page with a hole in it and no dialog — the model then observes again to find out what happened.
 */
const FIXTURE_LATE_MOUNT = page(`
<button aria-label="Account" aria-expanded="true"
        onclick="this.setAttribute('aria-expanded', 'false'); document.getElementById('menu').remove(); setTimeout(function () { var d = document.createElement('div'); d.innerHTML = '<button aria-label=&quot;Create workspace&quot;>Create</button>'; document.body.appendChild(d); }, 400)">Account</button>
<div id="menu">
  <button aria-label="Plugins">Plugins</button>
  <button aria-label="Other">Other</button>
</div>
<button aria-label="Close only" onclick="this.remove()">Close only</button>
<button aria-label="Anchor">Anchor</button>`);

/**
 * Removals the page reflows into — a row deleted, a list filtered — are finished effects, while
 * an OVERLAY that closes moves nothing and may hand over to something mounting a beat later.
 */
const FIXTURE_REMOVALS = page(`
<ul id="list">
  <li class="done">Ship <button aria-label="Delete Ship" onclick="this.parentNode.remove()">x</button></li>
  <li>Plan <button aria-label="Delete Plan" onclick="this.parentNode.remove()">x</button></li>
  <li class="done">Test <button aria-label="Delete Test" onclick="this.parentNode.remove()">x</button></li>
  <li>Write <button aria-label="Delete Write" onclick="this.parentNode.remove()">x</button></li>
</ul>
<button aria-label="Active only" onclick="document.querySelectorAll('li.done').forEach(function (li) { li.remove(); })">Active</button>
<button aria-label="Footer">Footer</button>
<div id="pop" style="position:absolute;top:300px;left:0">
  <button aria-label="Rename" onclick="document.getElementById('pop').remove(); setTimeout(function () { var d = document.createElement('div'); d.innerHTML = '<button aria-label=&quot;Rename dialog&quot;>OK</button>'; document.body.appendChild(d); }, 400)">Rename</button>
  <button aria-label="Pop other">Other</button>
</div>`);

/**
 * The SPA shape (x.com): the document is complete and carries the app SHELL — two chrome
 * buttons — while the content mounts a beat later. A guard that asks "is this empty?" lets it
 * straight through; a shell is not nothing.
 */
const FIXTURE_LATE_APP = page(`
<button aria-label="Grok">Grok</button><button aria-label="Chat">Chat</button>
<div id="root"></div>
<script>
  setTimeout(function () {
    document.getElementById('root').innerHTML =
      '<button aria-label="Mounted late">Go</button><a href="#x">Mounted link</a>';
  }, 900);
</script>`);

/**
 * Effects already on screen where the substantive comparison does not look: geometry, focus, the
 * viewport. Each paid the whole budget for nothing. The padded switch is the guard's other side:
 * its click moves it AND its state is still in flight, so it must still be waited for.
 */
const FIXTURE_SHOWN = page(`
<style>#grow{width:80px}</style>
<input aria-label="Name"><input aria-label="City">
<button id="grow" aria-label="Grow" onclick="this.style.width = (this.offsetWidth + 40) + 'px'">Grow</button>
<input type="checkbox" aria-label="Padded switch"
       onclick="event.preventDefault(); var el = this; el.style.margin = '12px'; setTimeout(function () { el.checked = true; }, 400)">
<button aria-label="Jump" onclick="document.getElementById('end').scrollIntoView()">Jump</button>
<div style="height:3000px"></div><p id="end">End</p>`);

/** A page that genuinely has nothing to act on: the wait must be bounded, not hopeful. */
const FIXTURE_NO_CONTROLS = page(`<main><h1>Just words</h1><p>Nothing to click here.</p></main>`);

/** Thin ON PURPOSE and never going to grow — a login wall. It must not pay the whole budget:
 *  the growth check is what lets the thin trigger be set generously. */
const FIXTURE_THIN_FOREVER = page(`
<form><input aria-label="Email"><input aria-label="Password" type="password">
<button aria-label="Sign in">Sign in</button></form>`);

/**
 * An SPA ROUTE CHANGE: no navigation verb runs at all — a click pushes state, tears the view
 * down and mounts the next one a beat later. A post-navigation wait flagged inside
 * `open_url`/`back`/`reload` would give this shape nothing (nor a plain link click, nor Enter in
 * a search box, whose results page can come back with ZERO elements).
 */
const FIXTURE_ROUTE_CHANGE = page(`
<div id="view">
  ${Array.from({ length: 10 }, (_, i) => `<a href="#h${i}">Home ${i}</a>`).join("")}
</div>
<button aria-label="Go to details" onclick="
  history.pushState({}, '', '#details');
  document.getElementById('view').innerHTML = '';
  setTimeout(function () {
    document.getElementById('view').innerHTML = '<button aria-label=&quot;Routed detail&quot;>Detail</button>';
  }, 900)">Details</button>`);

/** Real content in the FIRST document — above the thin trigger, so the wait must cost nothing.
 *  A one-button page would not prove it: that page IS thin, and a thin page pays by design. */
const FIXTURE_IMMEDIATE = page(
  `<button aria-label="Right there">Right there</button>`
  + Array.from({ length: 10 }, (_, i) => `<a href="#a${i}">Item ${i}</a>`).join(""),
);

const el = (state: string): Element =>
  ({ ref: "e1", role: "checkbox", name: "Auto close browser", state, rect: { x: 0, y: 0, w: 10, h: 10 } });

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  delete process.env.COMPUTER_USE_OBS_DELTA;
  const { resolveProfile } = await import("../src/platform/profile.ts");

  const tree = resolveProfile({ driver: "browser" });
  const hTree = createHarness(tree.driver);
  const refOf = (obs: string, label: string) => obs.match(new RegExp(`(e\\d+): \\w+ "${label}"`))?.[1];
  /**
   * The element line for `label` as it stands AFTER the action. A delta prints the BEFORE picture
   * too ("- e0: … [focused, checked]"), and reading that as evidence would let every assertion
   * below pass for the wrong reason — this drops the removed side and un-prefixes the added one.
   */
  const lineNow = (obs: string, label: string) => obs.split("\n")
    .filter((l) => !l.startsWith("- "))
    .find((l) => new RegExp(`e\\d+: \\w+ "${label}"`).test(l))?.replace(/^\+ /, "") ?? "(no line for ${label})";
  /** Every assertion about the wait is about WHEN the observation was taken, so every call is timed. */
  const timed = async (call: Promise<{ content: Array<{ type: string; text?: string }> }>) => {
    const started = Date.now();
    const out = firstText(await call);
    return { text: out, ms: Date.now() - started };
  };

  // wait({}) needs a real origin: the render it waits for comes back over the network.
  const server = createServer((req, res) => {
    if (req.url === "/data") { setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("loaded rows"); }, 500); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>wait fixture</title><div id="out">empty</div><div id="tick">0</div>
<button aria-label="Load" onclick="fetch('/data').then(function (r) { return r.text(); }).then(function (t) { document.getElementById('out').textContent = t; })">Load</button>
<button aria-label="Count" onclick="var n = 0, el = document.getElementById('tick'), id = setInterval(function () { el.textContent = String(++n); if (n === 12) clearInterval(id); }, 100)">Count</button>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

  try {
    // ── wait({}) ───────────────────────────────────────────────────────────────
    const waitPage = firstText(await hTree.act("open_url", { url: origin }));
    check("wait fixture opened", waitPage.includes("Load"), waitPage.split("\n")[0]);
    let t0 = Date.now();
    await hTree.api.wait({});
    const quietMs = Date.now() - t0;
    check("a quiet page settles under the old 300 ms floor", quietMs < 260, `${quietMs}ms`);
    await hTree.api.click(refOf(waitPage, "Load")!);
    t0 = Date.now();
    await hTree.api.wait({});
    const loadMs = Date.now() - t0;
    const loaded = await hTree.api.text();
    check("a render that waits on a request is waited for", loaded.includes("loaded rows") && loadMs >= 400, `${loadMs}ms`);
    await hTree.api.click(refOf(waitPage, "Count")!);
    t0 = Date.now();
    await hTree.api.wait({});
    const countMs = Date.now() - t0;
    check("a page that keeps changing is not taken as done", countMs >= 1000 && (await hTree.api.text()).includes("12"), `${countMs}ms`);

    // ── A delayed, property-only flip ──────────────────────────────────────────
    const opened = firstText(await hTree.act("open_url", { url: FIXTURE_CONTROLLED }));
    const swRef = refOf(opened, "Auto close browser");
    check("the controlled switch is listed", !!swRef, opened.split("\n").slice(0, 3).join(" | "));

    const controlled = await timed(hTree.act("click", { ref: swRef }));
    const switchNow = lineNow(controlled.text, "Auto close browser");
    check("the delayed state is in the observation", switchNow.endsWith("[focused, checked]"), switchNow);
    check("no accusation for a click that worked", !controlled.text.includes("changed nothing else on the page"),
      controlled.text.split("\n")[0]);
    check("it waited for the frame, and no longer", controlled.ms >= 350 && controlled.ms < 1200, `${controlled.ms}ms`);
    // The state string the wait reads: `focused` outermost, the real state behind it.
    check("focus is still rendered outermost (collect.ts format)", switchNow.includes("[focused, "),
      "if this line changed shape, substantiveElementSignature stops cancelling focus");

    // ── The opposite failure: a click that really does nothing must still be accused ──
    const inert = await timed(hTree.act("click", { ref: refOf(opened, "Inert") }));
    check("an inert click is still accused", inert.text.includes("moved the focus but changed nothing else"),
      inert.text.split("\n")[0]);
    check("the accusation is made only after the wait", inert.ms >= 1000, `${inert.ms}ms`);

    // ── …and a click that changed TEXT is not "nothing else" ─────────────────
    // The branch above compares only ELEMENT lines, so a click whose handler writes into the
    // page must not get the inert wording that the excerpt in the same observation contradicts.
    // The wording stops at "text moved, which is not evidence": this driver cannot tell a
    // handler's write from a clock.
    const wrote = await timed(hTree.act("click", { ref: refOf(opened, "Writes") }));
    check("a click that only changed page text says so", /Page text moved too/.test(wrote.text),
      wrote.text.split("\n").find((l) => l.startsWith("NOTE")) ?? wrote.text.split("\n")[0]);
    check("...and is NOT accused of changing nothing", !wrote.text.includes("changed nothing else on the page"));
    check("...while the text itself is in the observation", wrote.text.includes("written"),
      wrote.text.split("\n").slice(-3).join(" | "));

    // ── A click that lands immediately pays nothing ───────────────────────────
    const instant = await timed(hTree.act("click", { ref: refOf(opened, "Instant") }));
    const instantNow = lineNow(instant.text, "Instant");
    check("an immediate flip is observed", instantNow.endsWith("[focused, checked]"), instantNow);
    check("an immediate flip costs no re-check", instant.ms < 800, `${instant.ms}ms`);

    // ── Removal-only: a menu closes now (its trigger flips expanded→collapsed), the dialog
    //    mounts later. The state flip on the survivor must NOT read as an arrival. ───────────
    const menuPage = firstText(await hTree.act("open_url", { url: FIXTURE_LATE_MOUNT }));
    const late = await timed(hTree.act("click", { ref: refOf(menuPage, "Account") }));
    check("the late-mounted dialog is in the act result", late.text.includes('"Create workspace"'),
      late.text.split("\n").filter((l) => l.startsWith("+ ")).join(" | ") || late.text.split("\n")[0]);
    check("it waited for the mount, and no longer", late.ms >= 350 && late.ms < 1200, `${late.ms}ms`);
    // A control that removes itself, the page reflowing into the gap: done, nothing to wait for.
    const closeOnly = await timed(hTree.act("click", { ref: refOf(menuPage, "Close only") }));
    check("a pure close is not accused of doing nothing", !closeOnly.text.includes("changed nothing else on the page"),
      closeOnly.text.split("\n")[0]);
    check("a close the page reflowed into pays no re-check", closeOnly.ms < 800, `${closeOnly.ms}ms`);

    // ── Rows removed vs an overlay closed ─────────────────────────────────────
    const rows = firstText(await hTree.act("open_url", { url: FIXTURE_REMOVALS }));
    const deleted = await timed(hTree.act("click", { ref: refOf(rows, "Delete Plan") }));
    // The observation reports the row as removed (a "- " line), never as still there.
    const listed = (t: string, name: string) => t.split("\n").some((l) => !l.startsWith("- ") && l.includes(`"${name}"`));
    check("deleting a row pays no re-check", deleted.ms < 800 && !listed(deleted.text, "Delete Plan"), `${deleted.ms}ms`);
    const filtered = await timed(hTree.act("click", { ref: refOf(rows, "Active only") }));
    check("filtering rows away pays no re-check", filtered.ms < 800 && !listed(filtered.text, "Delete Ship"), `${filtered.ms}ms`);
    const renamed = await timed(hTree.act("click", { ref: refOf(rows, "Rename") }));
    check("an overlay that closes still waits for what it opens", renamed.text.includes('"Rename dialog"') && renamed.ms >= 350,
      `${renamed.ms}ms · ${renamed.text.split("\n").filter((l) => l.startsWith("+ ")).join(" | ")}`);

    // ── An effect already on screen ends the wait at once ─────────────────────
    const shown = firstText(await hTree.act("open_url", { url: FIXTURE_SHOWN }));
    const grew = await timed(hTree.act("click", { ref: refOf(shown, "Grow") }));
    check("a click that resized the page pays no re-check", grew.ms < 800 && grew.text.includes("geometry changed"), `${grew.ms}ms`);
    await hTree.act("click", { ref: refOf(shown, "Name") });
    const tabbed = await timed(hTree.act("keys", { chord: "Tab" }));
    check("a key that moved the focus pays no re-check", tabbed.ms < 800 && lineNow(tabbed.text, "City").includes("focused"),
      `${tabbed.ms}ms · ${lineNow(tabbed.text, "City")}`);
    const padded = await timed(hTree.act("click", { ref: refOf(shown, "Padded switch") }));
    const paddedNow = lineNow(padded.text, "Padded switch");
    check("a toggle that moved is still waited for", paddedNow.endsWith("[focused, checked]") && padded.ms >= 350,
      `${padded.ms}ms · ${paddedNow}`);
    const jumped = await timed(hTree.act("click", { ref: refOf(shown, "Jump") }));
    check("a click that scrolled the page pays no re-check", jumped.ms < 800, `${jumped.ms}ms`);

    // ── The format dependency, stated as an assertion ─────────────────────────
    check("focus cancels out of the substantive signature",
      substantiveElementSignature([el("focused, checked")]) === substantiveElementSignature([el("checked")])
      && substantiveElementSignature([el("focused")]) === substantiveElementSignature([el("")]));
    check("a real state change does NOT cancel out",
      substantiveElementSignature([el("focused, checked")]) !== substantiveElementSignature([el("focused, unchecked")]));
    // ── The post-NAVIGATION wait: an app's controls arrive after its document ──
    const lateApp = await timed(hTree.act("open_url", { url: FIXTURE_LATE_APP }));
    check("controls mounted after the document are waited for, not reported as absent",
      lateApp.text.includes('"Mounted late"') && lateApp.text.includes('"Mounted link"'),
      `${lateApp.ms}ms · ${lateApp.text.split("\n")[1] ?? ""}`);

    // The wait it must NOT become: a page with nothing to act on answers, bounded.
    const bare = await timed(hTree.act("open_url", { url: FIXTURE_NO_CONTROLS }));
    check("a page with no controls is answered, not waited on forever", bare.ms < 6_000, `${bare.ms}ms`);
    check("and its text is still read", bare.text.includes("Just words"), bare.text.split("\n").slice(0, 2).join(" | "));

    // Thin and staying thin: growth is the stop condition, so this pays ONE step — not the
    // budget. That is what lets the thin trigger be set above any real shell.
    const wall = await timed(hTree.act("open_url", { url: FIXTURE_THIN_FOREVER }));
    check("a genuinely thin page answers within the quiet window, not the whole budget",
      wall.text.includes('"Sign in"') && wall.ms < 2_000, `${wall.ms}ms`);

    // A route change nobody asked a verb for: the wait must engage on the navigation itself.
    const routeText = firstText(await hTree.act("open_url", { url: FIXTURE_ROUTE_CHANGE }));
    const goRef = refOf(routeText, "Go to details");
    check("the route button is listed", !!goRef, String(goRef));
    const routed = await timed(hTree.act("click", { ref: goRef }));
    check("content mounted after an SPA route change is waited for",
      routed.text.includes('"Routed detail"'), `${routed.ms}ms · ${routed.text.split("\n").slice(0, 2).join(" | ")}`);

    // The cost when there is nothing to wait for: none. An always-on settle would show here.
    const now = await timed(hTree.act("open_url", { url: FIXTURE_IMMEDIATE }));
    check("controls in the first document cost no wait at all",
      now.text.includes('"Right there"') && now.ms < 3_000, `${now.ms}ms`);

    // onlyRefsLost: judged on refs — strictly fewer, none that were not there before.
    const was = new Set(["e1", "e2", "e3"]);
    const at = (ref: string, state = "", name = "x"): Element => ({ ref, role: "button", name, state, rect: { x: 0, y: 0, w: 1, h: 1 } });
    check("onlyRefsLost: fewer of the same refs", onlyRefsLost(was, [at("e1"), at("e3")]));
    check("onlyRefsLost: the same refs are not a loss", !onlyRefsLost(was, [at("e1"), at("e2"), at("e3")]));
    check("onlyRefsLost: a new ref means something arrived", !onlyRefsLost(was, [at("e1"), at("e9")]));
    check("onlyRefsLost: a survivor's state flip does not mask a menu closing", onlyRefsLost(was, [at("e1", "collapsed")]));
    check("onlyRefsLost: a survivor's live label ticking does not mask it either", onlyRefsLost(was, [at("e1", "", "7m")]));
    check("onlyRefsLost: everything gone counts", onlyRefsLost(was, []));
    const before = elementSignature([{ ...at("e1"), role: "button", name: "Account", state: "focused, expanded" }]);
    check("disclosureClosed: an expanded trigger now collapsed", disclosureClosed(before, [{ ...at("e1"), role: "button", name: "Account", state: "collapsed" }]));
    check("disclosureClosed: a different control collapsed is not it", !disclosureClosed(before, [{ ...at("e1"), role: "button", name: "Other", state: "collapsed" }]));
    check("disclosureClosed: nothing before, nothing closed", !disclosureClosed(null, [{ ...at("e1"), state: "collapsed" }]));

    await tree.driver.close();
  } finally {
    server.close();
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nSETTLE OK" : `\nSETTLE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
