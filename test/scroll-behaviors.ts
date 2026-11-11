/**
 * Behavior tests for the scroll rewrite, sticky refs, incremental observations,
 * overlay pre-check and set_text fallbacks — against a real throwaway Chrome,
 * driven both through the harness (the notes the model reads) and at the driver
 * surface (ActResult.journal facts an auditor replays).
 *
 * Covers: inner-container scroll really moves (measured px + ledger note) · honest
 * "did not scroll" at the end · ref-targeted container choice · window scrolling ·
 * lazy-load growth warning · sticky refs across observes (and COMPUTER_USE_OBS_DELTA=0
 * escape hatch) · delta rendering with +/− lines · covered-element removal + notice ·
 * readonly-input click-to-activate fallback.
 */

import { spawnChrome } from "./helpers.ts";
import { createHarness } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";

const page = (body: string, title = "scroll fixture") =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title>${body}`)}`;

/** The page scrolls AND holds a named pane that scrolls on its own: a bare scroll cannot tell
 * which one is meant, so it refuses and names each as the argument that picks it. */
const FIXTURE_PAGE_PLUS_PANE = page(`
<style>
  body { margin: 0; }
  #log { height: 220px; overflow-y: auto; border: 1px solid #999; margin: 8px; }
  li { height: 30px; list-style: none; }
</style>
<section id="log" aria-label="Build log"><ul>
  ${Array.from({ length: 40 }, (_, i) => `<li>Log line ${i}</li>`).join("")}
</ul></section>
<ul>${Array.from({ length: 80 }, (_, i) => `<li><a href="#p${i}">Page row ${i}</a></li>`).join("")}</ul>`);

/** Three columns: left/right are inner scroll containers (body does not scroll).
 * Control density must not choose between the two scroll regions. */
const FIXTURE_COLUMNS = page(`
<style>
  body { margin: 0; display: flex; height: 100vh; overflow: hidden; }
  #folders { width: 200px; overflow-y: auto; border-right: 1px solid #999; }
  #mid { flex: 1; padding: 8px; }
  #messages { width: 380px; overflow-y: auto; border-left: 1px solid #999; }
  li { height: 30px; list-style: none; }
</style>
<div id="folders" aria-label="folders"><ul>
  ${Array.from({ length: 40 }, (_, i) => `<li><a href="#f${i}">Folder ${i}</a></li>`).join("")}
</ul></div>
<div id="mid">
  <p id="status">quiet</p>
  <button onclick="document.getElementById('status').textContent='row added'; const a=document.createElement('a'); a.href='#new'; a.textContent='Fresh row'; document.getElementById('mid').appendChild(a)">Add row</button>
</div>
<div id="messages" aria-label="messages"><ul>
  ${Array.from({ length: 80 }, (_, i) => `<li><a href="#m${i}">Message ${i}</a></li>`).join("")}
</ul></div>`);

/**
 * The shape of most real sites, and the one a naive auto-pick loses: the main list
 * scrolls the DOCUMENT while a narrow rail has a scroller of its own. The rail must not win
 * on the strength of having a scroller — the document holds far more of the list.
 */
const FIXTURE_MAIN_PLUS_RAIL = page(`
<style>
  body { margin: 0; display: flex; align-items: flex-start; }
  #feed { flex: 1; }
  #rail { width: 260px; height: 320px; overflow-y: auto; border-left: 1px solid #999; }
  li { height: 30px; list-style: none; }
</style>
<div id="feed" aria-label="feed">
  ${Array.from({ length: 80 }, (_, i) => `<p><a href="#p${i}">Post ${i}</a></p>`).join("")}
</div>
<div id="rail" aria-label="rail"><ul>
  ${Array.from({ length: 30 }, (_, i) => `<li><a href="#w${i}">Who ${i}</a></li>`).join("")}
</ul></div>`);

/** A plain tall page — the document itself scrolls. */
const FIXTURE_TALL = page(`
<main>
  <h1>Tall page</h1>
  ${Array.from({ length: 60 }, (_, i) => `<p><a href="#s${i}">Section ${i}</a></p>`).join("")}
</main>`);

/** Deep enough that a harvest — read a screen, scroll, repeat — runs past the advisory's
 *  threshold several times without ever reaching the end. */
const FIXTURE_DEEP = page(`
<main>
  <h1>Deep page</h1>
  ${Array.from({ length: 400 }, (_, i) => `<p><a href="#d${i}">Entry ${i}</a></p>`).join("")}
</main>`);

/** A sticky header that covers the rows scrolled under it. The rows stay CLICKABLE — the
 *  counterpart to FIXTURE_OVERLAY, where the coverer really does swallow the click. */
const FIXTURE_STICKY = page(`
<style>header{position:sticky;top:0;height:120px;background:#fff;border-bottom:1px solid #333} body{margin:0}</style>
<header><h2>Sticky header</h2></header>
<main>${Array.from({ length: 60 }, (_, i) => `<p><button onclick="document.title='clicked ${i}'">Row ${i}</button></p>`).join("")}</main>`, "sticky");

/** The W3Schools shape: a sticky header, and a button that loads under a fixed strip along the
 *  bottom. A screen of scrolling carries it under the header; `scroll({into})` centres it. */
const FIXTURE_PINNED = page(`
<style>header{position:sticky;top:0;height:100px;background:#fff} body{margin:0}
#strip{position:fixed;left:0;right:0;bottom:0;height:120px;background:#fc0}</style>
<header><h2>Sticky header</h2></header>
<div style="height:calc(100vh - 160px)"></div>
<button onclick="document.title='opened'">Section 1</button>
<div style="height:200vh"></div>
<div id="strip">Ad</div>`, "pinned");

/** Rows under a full-screen modal backdrop. A row below the fold is LISTED (nothing of it is
 *  in the viewport, so the occlusion probe has no point to sample) and only meets the backdrop
 *  when the click scrolls it into view. */
const FIXTURE_MODAL = page(`
<style>#back{position:fixed;inset:0;background:rgba(0,0,0,.5)} body{margin:0}</style>
<main>${Array.from({ length: 60 }, (_, i) => `<p><button onclick="document.title='clicked ${i}'">Row ${i}</button></p>`).join("")}</main>
<div id="back"></div>`, "modal");

/** A lazy list: every scroll of the container appends more rows (the total grows). */
const FIXTURE_LAZY = page(`
<style>#feed { height: 300px; overflow-y: auto; } li { height: 30px; list-style: none; }</style>
<div id="feed" aria-label="feed"><ul id="rows">
  ${Array.from({ length: 40 }, (_, i) => `<li><a href="#r${i}">Row ${i}</a></li>`).join("")}
</ul></div>
<script>
  let n = 40;
  document.getElementById('feed').addEventListener('scroll', () => {
    const ul = document.getElementById('rows');
    for (let i = 0; i < 60; i++) { const li = document.createElement('li'); const a = document.createElement('a'); a.href = '#r' + n; a.textContent = 'Row ' + n; n++; li.appendChild(a); ul.appendChild(li); }
  });
</script>`);

/** A list that loads LATE: reaching the end starts a fetch that lands 400ms later, and only
 * once. So the end is briefly real — a scroll there cannot move — and then it is not. That gap
 * is where "did not scroll; do not repeat" gives the wrong instruction. */
const FIXTURE_LAZY_SLOW = page(`
<style>#feed { height: 300px; overflow-y: auto; } li { height: 30px; list-style: none; }</style>
<div id="feed" aria-label="feed"><ul id="rows">
  ${Array.from({ length: 40 }, (_, i) => `<li><a href="#r${i}">Row ${i}</a></li>`).join("")}
</ul></div>
<script>
  let n = 40, loading = false, loaded = false;
  const feed = document.getElementById('feed');
  feed.addEventListener('scroll', () => {
    if (loading || loaded || feed.scrollTop + feed.clientHeight < feed.scrollHeight - 4) return;
    loading = true;
    setTimeout(() => {
      const ul = document.getElementById('rows');
      for (let i = 0; i < 60; i++) { const li = document.createElement('li'); const a = document.createElement('a'); a.href = '#r' + n; a.textContent = 'Row ' + n; n++; li.appendChild(a); ul.appendChild(li); }
      loading = false; loaded = true;
    }, 400);
  });
</script>`);

/** A button covered by a fixed overlay (with its own dismiss button on top). */
const FIXTURE_OVERLAY = page(`
<main>
  <button id="buy" onclick="void 0">Buy now</button>
  <a href="#docs">Read docs</a>
</main>
<div style="position:fixed; inset:0; background:rgba(0,0,0,.5)">
  <div style="background:#fff; margin:15vh auto; width:300px; padding:16px">
    Cookie banner
    <button onclick="this.closest('div').parentElement.remove()">Dismiss</button>
  </div>
</div>`);

/** A code editor's shape (Monaco in VS Code): the text entry it types through sits BEHIND its
 *  own rendered text (z-index -10) at the caret, and a mousedown on the text focuses it. With
 *  `notified`, a notification toast covers that point, which IS a cover. */
const EDITOR_FIXTURE = (notified: boolean) => page(`
<div id="editor" style="position:relative; z-index:0; width:600px; height:300px; overflow:hidden">
  <textarea id="proxy" aria-label="Editor content" style="position:absolute; top:20px; left:20px; width:1px; height:1px;
    z-index:-10; color:transparent; background:transparent; border:none; resize:none; padding:0; margin:0; overflow:hidden"></textarea>
  <div id="lines" style="position:absolute; inset:0; background:#fff; font:14px monospace">def greet(name):</div>
</div>
${notified ? `<div role="dialog" aria-label="Install the recommended extension?" style="position:fixed; left:0; top:0; width:200px; height:80px; background:#eee">
  <button onclick="this.parentElement.remove()">Clear notification</button></div>` : ""}
<script>
  document.getElementById('lines').onmousedown = (e) => { e.preventDefault(); document.getElementById('proxy').focus(); };
  document.getElementById('proxy').onfocus = () => { document.title = 'editing'; };
</script>`, "editor");

/** A page that DECLARES its dialog modal (role=dialog + aria-modal), the shape of a settings
 *  dialog: the background is covered on purpose and the work is inside the dialog. */
const FIXTURE_ARIA_MODAL = page(`
<main><button>Background one</button><button>Background two</button></main>
<div style="position:fixed; inset:0; background:rgba(0,0,0,.5)"></div>
<div role="dialog" aria-modal="true" aria-label="Settings"
     style="position:fixed; inset:0; margin:auto; width:300px; height:120px; background:#fff; padding:16px">
  <button>Save changes</button>
</div>`);

/** A sidebar shape: a scrolling list with a sticky group heading, above a footer
 *  pinned below it. Rows scrolled past the list's bottom edge are still inside the viewport,
 *  right where the footer paints — clipped by their container, not covered by anything. */
const FIXTURE_CLIPPED = page(`
<style>
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  #list { height: 200px; overflow-y: auto; }
  h3 { position: sticky; top: 0; margin: 0; height: 30px; background: #eee; }
  li { height: 30px; list-style: none; }
  #foot { flex: 1; background: #ddd; }
</style>
<div id="list"><h3>Pinned group</h3><ul>
  ${Array.from({ length: 30 }, (_, i) => `<li><a href="#r${i}">Row ${i}</a></li>`).join("")}
</ul></div>
<div id="foot"><button style="width: 100%; height: 100%">Add workspace</button></div>
<script>document.getElementById('list').scrollTop = 150;</script>`);

/** Two drag ends side by side, with the page scrolled past them; and the same pair a
 *  screen apart, which no scroll position can hold together. The title records what the
 *  page actually received, so a drag that goes nowhere cannot pass on its own note. */
const DRAG_FIXTURE = (gap: string) => page(`
<button id="knob">knob</button>${gap}<button id="bin">bin</button>
<div style="height:2400px"></div>
<script>document.getElementById('bin').onmouseup = () => { document.title = 'drag [drop]'; };</script>`, "drag");
const FIXTURE_DRAG_NEAR = DRAG_FIXTURE("");
const FIXTURE_DRAG_FAR = DRAG_FIXTURE(`<div style="height:2400px"></div>`);

/** A resize handle whose box follows the pointer only down to a minimum width — the shape of
 *  a settings dialog, where a drag past the limit stops short of the release point. */
const FIXTURE_DRAG_CLAMP = page(`
<div id="box" style="position:absolute; left:0; top:0; width:500px; height:200px; background:#eee">
  <button id="grip" aria-label="Resize" style="position:absolute; right:0; bottom:0; width:20px; height:20px"></button>
</div>
<script>
  const box = document.getElementById('box');
  let on = false;
  document.getElementById('grip').onmousedown = () => { on = true; };
  onmousemove = (e) => { if (on) box.style.width = Math.max(300, e.clientX + 10) + 'px'; };
  onmouseup = () => { on = false; };
</script>`, "resize");

/** A board whose cards are re-rendered on drop: the card that was grabbed is removed and a new
 *  node takes its place in the other column, as a framework's keyed list does when an item
 *  changes lists. The grabbed element no longer exists once the mouse is up. */
const FIXTURE_DRAG_REMOUNT = page(`
<style>body { margin: 0; } .col { position: absolute; top: 0; width: 200px; height: 300px; background: #eee; } button { display: block; width: 180px; height: 30px; margin: 10px; }</style>
<div class="col" id="todo" style="left: 0"><button>Write report</button></div>
<div class="col" id="done" style="left: 220px"><button>Old card</button></div>
<script>
  let held = null;
  onmousedown = (e) => { held = e.target.closest('button'); };
  onmouseup = (e) => {
    const col = document.elementFromPoint(e.clientX, e.clientY)?.closest('.col');
    if (held && col && held.parentElement !== col) {
      const fresh = document.createElement('button');
      fresh.textContent = held.textContent;
      held.remove();
      col.append(fresh);
    }
    held = null;
  };
</script>`, "board");

/** A list reordered by dragging rows that are not controls: the drag moves text only and never
 *  moves the focus, and a landed reorder must not read as "likely swallowed". The status line is
 *  what makes the text diff see it (a pure reorder keeps the same set of lines). */
const FIXTURE_DRAG_REORDER = page(`
<style>body { margin: 0; } li { height: 30px; list-style: none; }</style>
<ol id="l" style="margin: 0; padding: 0"><li>alpha</li><li>beta</li><li>gamma</li></ol>
<p id="s">order: alpha,beta,gamma</p>
<script>
  const s = document.getElementById('s');
  let held = null;
  onmousedown = (e) => { held = e.target.closest('li'); };
  onmouseup = (e) => {
    const to = e.target.closest('li');
    if (held && to && to !== held) to.before(held);
    held = null;
    s.textContent = 'order: ' + [...document.querySelectorAll('li')].map((l) => l.textContent).join(',');
  };
</script>`, "reorder");

/** A card inside a scrolling pane — a settings dialog's shape. Scrolling the pane moves the
 *  card's heading and its toggle together, so their difference is the layout and the rest is
 *  the scroller. A heading behind a modal is the control check. */
const FIXTURE_HEADINGS = page(`
<style>body { margin: 0; } #pane { height: 300px; overflow-y: auto; }</style>
<h1>Outside the pane</h1>
<div id="pane"><div style="height: 200px"></div>
  <section><h3>Usage over time</h3><p style="margin: 10px 0">hint</p><button>By kind</button></section>
  <div style="height: 900px"></div></div>`, "headings");
const FIXTURE_HEADING_BEHIND_MODAL = page(`
<main><h2>Behind</h2><button>Background</button></main>
<div role="dialog" aria-modal="true" aria-label="Settings" style="position:fixed; inset:0; background:#fff">
  <h2>In the dialog</h2><button>Save changes</button>
</div>`, "modal headings");

/** An input that is readonly until clicked — the classic date/search picker shape. */
const FIXTURE_READONLY = page(`
<main>
  <input id="when" placeholder="Pick date" readonly onclick="this.removeAttribute('readonly')">
</main>`);

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  delete process.env.COMPUTER_USE_OBS_DELTA;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);
  const driver = profile.driver;

  try {
    // ── Inner-container scroll: measured displacement + ledger note ───────────
    const nav = await h.act("open_url", { url: FIXTURE_COLUMNS });
    const navText = firstText(nav);
    check("columns fixture observed (full render)", nav.details?.obsKind === "full" && navText.includes('link "Message 0"'));

    const ambiguous = await h.act("scroll", { direction: "down" });
    check("multiple regions require an explicit ref", !ambiguous.ok && /multiple scrollable regions/.test(ambiguous.note));
    const messagesRef = navText.match(/(e\d+): region "messages"/)?.[1];
    const scroll1 = await h.act("scroll", { direction: "down", ref: messagesRef });
    const scroll1Text = firstText(scroll1);
    check("explicit region scrolls messages", scroll1Text.includes("«messages»"), scroll1Text.split("\n")[0]);
    check("scroll note reports measured px", /scrolled down \d+px/.test(scroll1Text));
    check("scroll note reports the container ledger", /screen \d+\/\d+ of this container/.test(scroll1Text));
    check("scroll round renders newly visible lines", scroll1Text.includes("Newly visible after scrolling:"));
    check("scrolled-out lines summarized, not listed as losses", /\d+ lines? left the viewport — scrolled out, or dismissed/.test(scroll1Text));

    // ── Delta rendering on an ordinary change (before the screen drifts further) ──
    const addRef = navText.match(/(e\d+): button "Add row"/)?.[1];
    check("button ref found", !!addRef);
    const clicked = await h.act("click", { ref: addRef, name: "Add row" });
    const clickedText = firstText(clicked);
    check("change renders as delta", clicked.details?.obsKind === "delta", String(clicked.details?.obsKind));
    check("delta shows the added line with +", /\+ e\d+: link "Fresh row"/.test(clickedText), clickedText);
    check("delta shows removed excerpt line with -", clickedText.includes("- quiet"), clickedText);
    check("delta explains omitted elements", clickedText.includes("refs from earlier observations remain valid"));

    // Driver surface: the journal facts (moved px, container) ride ActResult.journal.
    const direct = await driver.perform("scroll", { direction: "down", ref: messagesRef });
    check("journal carries measured moved px > 0", typeof direct.journal?.moved === "number" && (direct.journal.moved as number) > 0, JSON.stringify(direct.journal));
    check("journal names the container", direct.journal?.container === "messages", String(direct.journal?.container));

    // ── count: screens per call, measured against one screen of the same container ──
    await driver.perform("scroll", { to: "top", ref: messagesRef });
    const one = await driver.perform("scroll", { direction: "down", ref: messagesRef });
    await driver.perform("scroll", { to: "top", ref: messagesRef });
    const three = await driver.perform("scroll", { direction: "down", count: 3, ref: messagesRef });
    const px = (r: { journal?: Record<string, unknown> }) => Number(r.journal?.moved ?? 0);
    check("scroll count covers several screens in one call", px(three) > px(one) * 1.5, `${px(one)}px → ${px(three)}px`);
    check("…and the note still reports the MEASURED px, with the count as what was asked for",
      /scrolled down \d+px/.test(three.note ?? "") && /3 screens asked for/.test(three.note ?? ""), three.note);
    const both = await driver.perform("scroll", { to: "bottom", count: 3 });
    check("count together with to: is refused by name, never silently dropped",
      !both.ok && /not both/.test(both.note ?? ""), both.note);

    // ── Ref-targeted scroll: the ref's own container, not the densest one ─────
    const folderRef = navText.match(/(e\d+): link "Folder 5"/)?.[1];
    check("folder ref found", !!folderRef);
    const refScroll = await driver.perform("scroll", { direction: "down", ref: folderRef });
    check("ref-targeted scroll picks the holding container", refScroll.journal?.container === "folders", String(refScroll.journal?.container));
    check("ref-targeted scroll really moved", typeof refScroll.journal?.moved === "number" && (refScroll.journal.moved as number) > 0);

    // ── At the end: honest "did not scroll" ───────────────────────────────────
    const toBottom = await driver.perform("scroll", { to: "bottom", ref: folderRef });
    check("jump to bottom moves and says so", /scrolled to the bottom/.test(toBottom.note ?? "") && (toBottom.journal?.moved as number) > 0, toBottom.note);
    const atEnd = await driver.perform("scroll", { direction: "down", ref: folderRef });
    check("scroll at the end reports 'did not scroll'", (atEnd.note ?? "").includes("did not scroll"), atEnd.note);
    check("no-move journal records moved 0", atEnd.journal?.moved === 0);
    const bottomAgain = await driver.perform("scroll", { to: "bottom", ref: folderRef });
    check("jump to bottom again reports 'did not scroll'", (bottomAgain.note ?? "").includes("did not scroll"), bottomAgain.note);

    // ── Sticky refs across observes; COMPUTER_USE_OBS_DELTA=0 forces full renders ───
    process.env.COMPUTER_USE_OBS_DELTA = "0";
    const full1 = await h.observe({});
    const full2 = await h.observe({});
    delete process.env.COMPUTER_USE_OBS_DELTA;
    check("escape hatch renders full each time", full1.details?.obsKind === "full" && full2.details?.obsKind === "full");
    const ref1 = firstText(full1).match(/(e\d+): button "Add row"/)?.[1];
    const ref2 = firstText(full2).match(/(e\d+): button "Add row"/)?.[1];
    check("refs are sticky across observes", !!ref1 && ref1 === ref2 && ref1 === addRef, `${addRef} vs ${ref1} vs ${ref2}`);

    // ── Window scrolling still works on a plain page ──────────────────────────
    await h.act("open_url", { url: FIXTURE_TALL });
    const windowScroll = await driver.perform("scroll", { direction: "down" });
    check("window scroll moves the page", windowScroll.journal?.container === "window" && (windowScroll.journal?.moved as number) > 0, JSON.stringify(windowScroll.journal));

    // ── Main content vs a rail with its own scroller ──────────────────────────
    // The document must be a candidate, or any page with one inner scroller loses its main list
    // to it — and the wrong scroll still reports a real displacement, so it looks normal.
    // The rail's ref comes from open_url's OWN full render: a further observe is a delta, and
    // an element that did not change is omitted from it.
    const railText = firstText(await h.act("open_url", { url: FIXTURE_MAIN_PLUS_RAIL }));
    const railRef = railText.match(/(e\d+): link "Who 0"/)?.[1];
    check("a ref in the rail found", !!railRef, String(railRef));
    // The ref override first, while the rail is still on screen: once the document scrolls,
    // the rail leaves the viewport and the wheel would have nowhere to land.
    const railPick = await driver.perform("scroll", { direction: "down", ref: railRef });
    check("ref-targeted scroll still picks the rail, and moves it",
      railPick.journal?.container === "rail" && (railPick.journal?.moved as number) > 0, JSON.stringify(railPick.journal));
    const mainPick = await driver.perform("scroll", { direction: "down", ref: "window" });
    check("explicit window target scrolls the document",
      mainPick.journal?.container === "window" && (mainPick.journal?.moved as number) > 0, JSON.stringify(mainPick.journal));
    // to:'top' obeys the same pick, so a jump does not send some side area to its top.
    const jumpTop = await driver.perform("scroll", { to: "top", ref: "window" });
    check("to:'top' jumps the document too", jumpTop.journal?.container === "window", JSON.stringify(jumpTop.journal));

    // ── The page and a pane both scroll: the refusal names each as its argument ──
    const paneText = firstText(await h.act("open_url", { url: FIXTURE_PAGE_PLUS_PANE }));
    const logRef = paneText.match(/(e\d+): region "Build log"/)?.[1];
    const paneOrPage = await driver.perform("scroll", { to: "bottom" });
    check("page plus a pane: a bare scroll refuses and writes each choice as the ref that picks it",
      !paneOrPage.ok && (paneOrPage.note ?? "").includes("ref:'window' (the page itself)") && !!logRef && (paneOrPage.note ?? "").includes(`ref:'${logRef}' Build log`), paneOrPage.note);
    // A find() handle names the container as well as its ref string does.
    const logHandle = await h.api.find("Build log", { role: "region" });
    let byHandle = "";
    try { byHandle = await h.api.scroll({ to: "bottom", ref: logHandle }) as string; } catch (e) { byHandle = (e as Error).message; }
    check("scroll takes a find() handle as its ref, and scrolls that container",
      /«Build log»/.test(byHandle) && /scrolled to the bottom/.test(byHandle), byHandle);
    let nullRef = "";
    try { await h.api.scroll({ to: "bottom", ref: null }); } catch (e) { nullRef = (e as Error).message; }
    check("…and a find() that matched nothing (null) is refused as such, not scrolled as a bare scroll",
      /the target is null/.test(nullRef), nullRef);

    // ── Lazy list: growth warning ─────────────────────────────────────────────
    await h.act("open_url", { url: FIXTURE_LAZY });
    await h.observe({});
    await driver.perform("scroll", { direction: "down" }); // baseline total recorded
    const grew = await driver.perform("scroll", { direction: "down" });
    check("lazy growth is called out", (grew.note ?? "").includes("this list grows as you scroll"), grew.note);

    // ── The standstill at the end of a list that has not finished loading ────
    // A list can grow right after a scroll that could not move (x.com), so the standstill must
    // leave a retry open, and the growth it could not foresee is called out when it lands.
    await h.act("open_url", { url: FIXTURE_LAZY_SLOW });
    await h.observe({});
    const scrollToStandstill = async (tries: number) => {
      for (let i = 0; i < tries; i++) {
        const note = (await driver.perform("scroll", { direction: "down" })).note ?? "";
        if (note.startsWith("did not scroll")) return note;
      }
      return "";
    };
    const stalled = await scrollToStandstill(8);
    check("the first standstill leaves the retry open, and says whose end it is",
      stalled.includes("loads more on reaching its end") && /did not scroll — (the page|«[^»]+») is already/.test(stalled), stalled);
    await new Promise((r) => setTimeout(r, 700)); // the late rows land
    const afterLoad = (await driver.perform("scroll", { direction: "down" })).note ?? "";
    check("the late growth is called out", afterLoad.includes("grows as you scroll"), afterLoad);

    // ── The escalating advisory is for HUNTING, and a harvest is not hunting ──
    // An agent reading every screen while it scrolls must not be told to "report what you have".
    await h.act("open_url", { url: FIXTURE_DEEP });
    await h.observe({});
    let hunting = "";
    for (let i = 0; i < 5; i++) hunting = (await driver.perform("scroll", { direction: "down" })).note ?? "";
    check("five scrolls with nothing read in between still earn the advisory",
      /this is scroll #5 in this container/.test(hunting), hunting);
    await h.api.text();                       // reading the screen is what a harvest does
    const harvesting = (await driver.perform("scroll", { direction: "down" })).note ?? "";
    check("a scroll that follows a content read does not", !/this is scroll #/.test(harvesting), harvesting);
    check("...and the screen account it carries is unchanged", /screen \d+\/\d+ of this container/.test(harvesting), harvesting);
    await h.observe({});                      // the round ends: contentRead is consumed
    const huntingAgain = (await driver.perform("scroll", { direction: "down" })).note ?? "";
    check("the count kept climbing while exempt — a later pure-scroll spree escalates from where it was",
      /this is scroll #7 in this container/.test(huntingAgain), huntingAgain);

    // ── Covered elements: dropped from the list, named in a notice ────────────
    const overlayObs = await h.act("open_url", { url: FIXTURE_OVERLAY });
    const overlayText = firstText(overlayObs);
    check("non-modal coverage is counted without changing the window scope", /Scope: window/.test(overlayText)
      && Number((overlayObs.details.coverage as { covered: number }).covered) > 0);
    check("covered button not listed", !overlayText.includes('button "Buy now"'));
    check("a covered element cannot be found by name either — it is not in the list to search",
      (await h.api.find("Buy now")) === null);

    // An editor's input proxy is under the editor's own text by design: listed and clickable,
    // while a notification over that point still covers it.
    const notifiedText = firstText(await h.act("open_url", { url: EDITOR_FIXTURE(true) }));
    check("an editor's input proxy under a notification is covered, and the notification named",
      !notifiedText.includes('textbox "Editor content"') && notifiedText.includes('button "Clear notification"'),
      notifiedText.split("\n").find((l) => /covered|overlay/.test(l)));
    const editorText = firstText(await h.act("open_url", { url: EDITOR_FIXTURE(false) }));
    const proxyRef = editorText.match(/(e\d+): textbox "Editor content"/)?.[1];
    check("an editor's input proxy under its own text is listed, not counted as covered",
      !!proxyRef && !/controls covered by/.test(editorText), editorText.split("\n").find((l) => /textbox|covered/.test(l)));
    const clickedEditor = await driver.perform("click", { ref: proxyRef ?? "e0" });
    check("...and clicking it lands on the editor, which takes the focus",
      clickedEditor.ok !== false && (await driver.readElements()).title === "editing", JSON.stringify(clickedEditor));

    // ── headings: a fixed point that moves with the content, not with the scroller ─
    await h.act("open_url", { url: FIXTURE_HEADINGS });
    const layout = async () => {
      const o = await h.api.observe();
      const hd = o.headings?.find((x) => x.name === "Usage over time");
      const btn = o.elements.find((e) => e.name === "By kind");
      return { hd, btn, names: (o.headings ?? []).map((x) => `${x.name}/${x.level}`) };
    };
    const before = await layout();
    check("observe() returns the page's headings with their level", before.names.includes("Outside the pane/1") && before.names.includes("Usage over time/3"), before.names.join(", "));
    await h.act("run_js", { code: "document.getElementById('pane').scrollTop = 120" });
    const after = await layout();
    const off = (l: typeof before) => l.btn!.rect.y - l.hd!.rect.y;
    check("...and a control measured against its heading does not move when only the pane scrolls",
      after.btn!.rect.y !== before.btn!.rect.y && Math.abs(off(after) - off(before)) < 1, `button ${before.btn!.rect.y}→${after.btn!.rect.y}, offset ${off(before)}→${off(after)}`);
    await h.act("open_url", { url: FIXTURE_HEADING_BEHIND_MODAL });
    const inModal = ((await h.api.observe()).headings ?? []).map((x) => x.name);
    check("with a modal open, only the dialog's headings are returned", inModal.includes("In the dialog") && !inModal.includes("Behind"), inModal.join(", "));

    // Behind a DECLARED modal the notice says where the background went — no "deal with it
    // first" to a caller whose controls are the dialog's. The cookie banner above declares
    // nothing, so it keeps the overlay wording (the control for this case).
    const modalText = firstText(await h.act("open_url", { url: FIXTURE_ARIA_MODAL }));
    const modalNote = modalText.split("\n").find((l) => l.startsWith("Scope:"));
    check("controls behind a declared modal are named as behind it", /Scope: «Settings» dialog; covered background controls are omitted/.test(modalText), modalNote);
    check("...without the deal-with-it-first advice", !/deal with it first/.test(modalText), modalNote);
    check("...and the dialog's own controls stay listed", modalText.includes('button "Save changes"'));

    // Clipped is not covered: rows scrolled out of their own list — below its edge over the
    // pinned footer, or under its sticky heading — are off-screen rows to scroll to.
    const clippedText = firstText(await h.act("open_url", { url: FIXTURE_CLIPPED }));
    check("rows clipped by their scroll container raise no overlay notice", !/controls covered by/.test(clippedText),
      clippedText.split("\n").find((l) => l.includes("overlay")));
    const clipped = (await h.api.observe()).elements as Array<{ name: string; offscreen?: boolean }>;
    const row = (n: number) => clipped.find((e) => e.name === `Row ${n}`);
    check("a row below the list's edge is listed as off-screen", row(20)?.offscreen === true, JSON.stringify(row(20)));
    check("a row under the sticky heading is listed as off-screen", row(3)?.offscreen === true, JSON.stringify(row(3)));
    check("a row inside the list stays on screen", !!row(8) && !row(8)!.offscreen, JSON.stringify(row(8)));

    // The element the snapshot CANNOT warn about: off-viewport when listed, so the occlusion
    // probe skipped it (no in-viewport quad), and it meets the backdrop only when the click
    // scrolls it into view. The failure must name the overlay, not just time out.
    await h.act("open_url", { url: FIXTURE_MODAL });
    await h.observe({});
    const buried = await h.api.find("Row 3") as { ref: string } | null;
    check("a row below the fold is listed and findable — the snapshot has no complaint about it", !!buried);
    const blocked = await driver.perform("click", { ref: buried?.ref ?? "e0" });
    check("but the click that meets the backdrop says WHO swallowed it, and that the ref was right",
      blocked.ok === false && /is covered by «fixed layer over the whole viewport \(#back\)»/.test(blocked.note ?? "")
      && /close or dismiss what is on top/.test(blocked.note ?? ""),
      blocked.note);
    // The other half, and why this is not a pre-check: STICKY chrome covers elements too, and
    // a click on one of those WORKS — Playwright scrolls it out from under the header.
    const stickyOpen = firstText(await h.act("open_url", { url: FIXTURE_STICKY }));
    const stickyScroll = firstText(await h.act("scroll", { direction: "down" }));
    const stickyObservation = await h.observe({});
    const stickyText = stickyOpen + stickyScroll;
    check("a sticky header does not change the window scope", !/controls covered by/.test(stickyText)
      && Number((stickyObservation.details.coverage as { covered: number }).covered) > 0,
      stickyText.split("\n").find((l) => l.includes("overlay")));
    const underHeader = await h.api.find("Row 3") as { ref: string } | null;
    const wentThrough = await driver.perform("click", { ref: underHeader?.ref ?? "e0" });
    const title = (await driver.readElements()).title;
    check("...and clicking one of them still lands — a covered element is not an unreachable one",
      wentThrough.ok !== false && title === "clicked 3", `${JSON.stringify(wentThrough)} title=${title}`);
    check("overlay's own button still listed", overlayText.includes('button "Dismiss"'));

    // ── scroll({into}): out from under a pinned strip ─────────────────────────
    await h.act("open_url", { url: FIXTURE_PINNED });
    await h.observe({});
    const pinnedMiss = await h.api.find("Section 1");
    const pinnedNote = h.lastNote();
    const pinnedRef = pinnedNote.match(/\((e\d+)\) is here but «fixed bar along the bottom of the viewport \(#strip\)»/)?.[1];
    check("a control under a bottom strip is named with its cover and offered scroll({into})",
      pinnedMiss === null && !!pinnedRef && pinnedNote.includes(`scroll({into:'${pinnedRef}'})`), pinnedNote);
    const into = String(await h.api.scroll({ into: pinnedRef }));
    check("scroll({into}) centres it and reads it clear", /to the middle of the viewport .*nothing covers it now/.test(into), into);
    const opened = await h.api.click(pinnedRef);
    check("...and its ref is actionable in the same script", (await driver.readElements()).title === "opened", String(opened));
    let mixed = "";
    try { await h.api.scroll({ into: pinnedRef, direction: "down" }); } catch (e) { mixed = String(e); }
    check("scroll({into}) refuses a direction alongside it", /takes nothing else — drop direction/.test(mixed), mixed);

    // ── set_text fallback: readonly-until-clicked input ───────────────────────
    const roObs = await h.act("open_url", { url: FIXTURE_READONLY });
    const whenRef = firstText(roObs).match(/(e\d+): textbox "Pick date"/)?.[1];
    check("readonly input listed", !!whenRef);
    const filled = await h.act("set_text", { ref: whenRef, name: "Pick date", text: "2026-08-13" });
    const filledText = firstText(filled);
    check("fallback level reported", filledText.includes("filled after click-to-activate"), filledText.split("\n")[0]);
    // Focused right after the write ⇒ "[focused, filled:…]"; assert on the value itself.
    check("value landed in the field", filledText.includes("filled:2026-08-13"), filledText);
    check("read-back confirms the write", filledText.includes("the field now contains «2026-08-13»"), filledText.split("\n")[0]);

    // ── drag is the one verb that aims at coordinates, so scrolling is ITS job ─
    // Off the fold a drag would press at a negative y and the page receive nothing.
    const nearObs = await h.act("open_url", { url: FIXTURE_DRAG_NEAR });
    const refOf = (t: string, name: string) => t.match(new RegExp(`(e\\d+): button "${name}"`))?.[1];
    await h.act("scroll", { direction: "down" });
    const nearDrag = await h.act("drag", { ref: refOf(firstText(nearObs), "knob"), toRef: refOf(firstText(nearObs), "bin") });
    check("drag scrolls its own ends into view", nearDrag.ok && !/-\d/.test(nearDrag.note), nearDrag.note);
    check("...and the page really received the release", firstText(nearDrag).includes("drag [drop]"), firstText(nearDrag).split("\n").find((l) => l.startsWith("Title:")));

    await h.act("open_url", { url: FIXTURE_DRAG_FAR });
    // `bin` is a screen below the fold, so it is not in the viewport listing — find() is
    // the route a model has to it, and the pair it hands back cannot be dragged together.
    const farDrag = await h.act("drag", { ref: (await h.api.find("knob"))?.ref, toRef: (await h.api.find("bin"))?.ref });
    check("ends further apart than one screen refuse by name", !farDrag.ok && farDrag.note.includes("both ends on screen at once"), farDrag.note);
    check("...and nothing was pressed", !firstText(farDrag).includes("drag [drop]"), firstText(farDrag).split("\n").find((l) => l.startsWith("Title:")));

    // Where the grabbed element ended is measured into the note. Grip centre starts at x=490;
    // the box follows to x=390, and below its 300px minimum the grip stops at x=290.
    await h.act("open_url", { url: FIXTURE_DRAG_CLAMP });
    const grip = (await h.api.find("Resize"))?.ref;
    const follow = await h.act("drag", { ref: grip, toX: 390, toY: 190 });
    check("a drag the element follows says so", follow.ok && follow.note.includes("followed to the release point"), follow.note);
    const clamp = await h.act("drag", { ref: grip, toX: 100, toY: 190 });
    check("a drag stopped by the element's limit says where it ended and how far short",
      clamp.ok && /now sits at \(290,190\), 190px short of the release point/.test(clamp.note), clamp.note);
    const stuck = await h.act("drag", { ref: grip, toX: 50, toY: 190 });
    check("a drag that moves nothing says the element did not move", stuck.ok && stuck.note.includes("did not move"), stuck.note);

    // The grabbed card is removed on drop and re-created in the other column. Measuring where
    // it landed must not wait for an element that will never come back (it waited 30 s).
    await h.act("open_url", { url: FIXTURE_DRAG_REMOUNT });
    const card = (await h.api.find("Write report"))?.ref;
    const remountStart = Date.now();
    const remount = await h.act("drag", { ref: card, toX: 320, toY: 150 });
    const remountMs = Date.now() - remountStart;
    const columns = (await h.act("run_js", { code: "[...document.querySelectorAll('.col')].map((c) => c.id + ':' + [...c.children].map((b) => b.textContent).join('+')).join(' ')" })).note;
    check("a drag whose element the page re-creates on drop still lands", remount.ok && columns.includes("todo: done:Old card+Write report"), columns);
    check("...and returns promptly instead of waiting for the old element", remountMs < 3000, `${remountMs} ms`);
    check("...and says the grabbed element is gone, so its landing was not measured",
      /is no longer on the page/.test(remount.note) && !/did not move|followed to|now sits at/.test(remount.note), remount.note);

    // Rows at y 15 / 45 / 75: drag gamma onto alpha.
    await h.act("open_url", { url: FIXTURE_DRAG_REORDER });
    const reorder = await h.act("drag", { x: 20, y: 75, toX: 20, toY: 15 });
    const order = (await h.act("run_js", { code: "[...document.querySelectorAll('li')].map((l) => l.textContent).join(',')" })).note;
    check("the reorder really happened", order.includes("gamma,alpha,beta"), order);
    check("...and a text-only drag reads as a reorder, not as swallowed",
      firstText(reorder).includes("a reorder looks exactly like this") && !firstText(reorder).includes("likely swallowed"),
      firstText(reorder));

    await driver.close();
  } finally {
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nSCROLL BEHAVIORS OK" : `\nSCROLL BEHAVIORS FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
