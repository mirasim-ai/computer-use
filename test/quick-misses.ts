/**
 * A miss must cost what it takes to find out, not a timeout — and must say what IS there.
 *
 * Each case here was measured in a front-end benchmark as seconds of nothing: a select asked for
 * an option it does not have (three timeouts in a row, ~20 s), a clipboard read waiting on a
 * permission prompt nobody answers (10 s), a wait or an expect for a control under a slightly
 * different name, and a find() handle whose node was re-rendered or reloaded underneath it.
 * Against a real throwaway Chrome, through the test harness: these are the notes the model reads.
 */

import { createServer } from "node:http";
import { spawnChrome } from "./helpers.ts";
import { createHarness } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const page = (body: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>quick misses fixture</title>${body}`)}`;

/** A native select with a disabled option, a text field that is not a dropdown at all, and a
 *  custom dropdown: a button that reveals role=option rows. */
const FIXTURE_SELECT = page(`
<select aria-label="Status">
  <option value="paid">Paid</option><option value="pending">Pending</option><option value="void" disabled>Void</option>
</select>
<input aria-label="Amount">
<button aria-haspopup="listbox" onclick="document.getElementById('list').hidden = false">Fruit</button>
<div id="list" role="listbox" hidden>
  <div role="option" onclick="document.getElementById('picked').textContent = 'picked Apple'">Apple</div>
  <div role="option" onclick="document.getElementById('picked').textContent = 'picked Banana'">Banana</div>
</div>
<p id="picked">nothing picked</p>`);

/** A control whose name is close to, but not, the one a script will wait for. */
const FIXTURE_NEAR_NAME = page(`
<button>Filter by Date</button>
<button>Reset all filters</button>
<input aria-label="Coupon" value="SPRING-10">
<p>Orders, newest first</p>
<p>In progress</p><p>1</p>`);

/** A form that re-renders itself: same names, new nodes, so every ref from before is dead while
 *  the controls are all still there. */
const FIXTURE_RERENDER = page(`
<div id="root"></div>
<script>
  let renders = 0;
  function render() {
    renders++;
    document.getElementById('root').innerHTML =
      '<input aria-label="Due date" value="2026-11-2' + renders + '">'
      + '<button onclick="render()">Save</button>'
      + '<p id="count">render ' + renders + '</p>';
  }
  render();
</script>`);

/** A tall page whose controls re-mount LATE: Save empties the form at once and draws it again
 *  300 ms later, the way a list does while its request is out. "Rename" draws it under another
 *  name, and "Cover" lays a dialog over everything. */
const FIXTURE_LATE = page(`
<div id="root"></div>
<div style="height:3000px"></div>
<button id="far">Far away</button>
<script>
  let label = 'Due date';
  function draw() {
    document.getElementById('root').innerHTML =
      '<input aria-label="' + label + '" value="2026-11-21">'
      + '<button onclick="save()">Save</button>'
      + '<button onclick="rename()">Rename</button>'
      + '<button onclick="cover()">Cover</button>';
  }
  function rename() { label = 'Deadline date'; save(); }
  function save() { document.getElementById('root').innerHTML = ''; setTimeout(draw, 300); }
  function cover() {
    draw();
    const veil = document.createElement('div');
    veil.setAttribute('role', 'dialog');
    veil.setAttribute('aria-label', 'Unsaved changes');
    veil.style.cssText = 'position:fixed;inset:0;background:#fff';
    veil.textContent = 'Unsaved changes';
    document.body.appendChild(veil);
  }
  draw();
</script>`);

/** Three cards, each with its own Share button, told apart only by what is NOT a control: a
 *  heading, a region's label, and a line of plain text split across two elements. */
const FIXTURE_CARDS = page(`
<style>section { height: 200px; position: relative } section button { position: absolute; right: 20px; top: 20px }</style>
<section><h3>Orders by region</h3><button>Share</button></section>
<section aria-label="Revenue by day"><canvas width="300" height="100"></canvas><button>Share</button></section>
<section><p><b>QA</b> entry 85</p><button>Share</button></section>`);

/** The clipboard exists only in a secure context, which a data: URL is not: one page on localhost. */
function serve(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // A headless Chrome denies the read at once; a window on someone's desk asks them, and the
      // promise waits for an answer. That is what this page stands in for: the permission still
      // at "prompt", and a read that never settles.
      res.end(`<!doctype html><title>clipboard fixture</title><button>Copy order number</button>
<script>
  navigator.permissions.query = async () => ({ state: "prompt" });
  Clipboard.prototype.readText = () => new Promise(() => {});
  Clipboard.prototype.read = () => new Promise(() => {});
</script>`);
    });
    srv.listen(0, "127.0.0.1", () => resolve({
      url: `http://localhost:${(srv.address() as { port: number }).port}/`,
      close: () => srv.close(),
    }));
  });
}

/** How long `f` took, with what it answered. */
async function timed<T>(f: () => Promise<T>): Promise<{ out: T; ms: number }> {
  const t0 = Date.now();
  const out = await f();
  return { out, ms: Date.now() - t0 };
}

async function main() {
  const chrome = await spawnChrome({});
  const site = await serve();
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  delete process.env.COMPUTER_USE_OBS_DELTA;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);
  const driver = profile.driver;
  const firstText = (r: { content: Array<{ type: string; text?: string }> }) => r.content.find((c) => c.type === "text")?.text ?? "";
  const open = async (url: string) => firstText(await h.act("open_url", { url }));
  const refOf = (obs: string, label: string) => obs.match(new RegExp(`(e\\d+): \\w+ "${label}"`))?.[1];
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  try {
    // ── select_option: an option the control does not have ────────────────────
    const sel = await open(FIXTURE_SELECT);
    const status = refOf(sel, "Status");
    const absent = await timed(() => h.act("select_option", { ref: status, option: "Refunded" }));
    check("an absent option is refused without waiting out the timeouts", !absent.out.ok && absent.ms < 3000, `${sec(absent.ms)}: ${absent.out.note.slice(0, 160)}`);
    check("...and the refusal lists the options the select does have", /Paid/.test(absent.out.note) && /Pending/.test(absent.out.note), absent.out.note.slice(0, 200));

    const byValue = await h.act("select_option", { ref: status, option: "pending" });
    const picked = (await h.api.observe()).elements.find((e) => e.name === "Status");
    check("an option is still picked by its value", byValue.ok && /Pending/.test(picked?.state ?? ""), `${byValue.note} | ${picked?.state}`);
    const byCase = await h.act("select_option", { ref: status, option: "PAID" });
    check("...and by its label whatever the case", byCase.ok && /Paid/.test((await h.api.observe()).elements.find((e) => e.name === "Status")?.state ?? ""), byCase.note);

    const disabled = await timed(() => h.act("select_option", { ref: status, option: "Void" }));
    check("a disabled option is refused as disabled, at once", !disabled.out.ok && disabled.ms < 3000 && /disabled/.test(disabled.out.note), `${sec(disabled.ms)}: ${disabled.out.note.slice(0, 160)}`);

    const amount = refOf(await open(FIXTURE_SELECT), "Amount");
    const notSelect = await timed(() => h.act("select_option", { ref: amount, option: "Refunded" }));
    check("a text field asked for an option answers quickly", !notSelect.out.ok && notSelect.ms < 4000, `${sec(notSelect.ms)}: ${notSelect.out.note.slice(0, 200)}`);
    check("...and says it is not a select", /not a <select>/.test(notSelect.out.note), notSelect.out.note.slice(0, 200));

    const custom = await open(FIXTURE_SELECT);
    const fruit = refOf(custom, "Fruit");
    const opened = await h.act("select_option", { ref: fruit, option: "Banana" });
    check("a custom dropdown is still opened and clicked", opened.ok && (await h.api.text()).includes("picked Banana"), opened.note);
    const fruit2 = refOf(await open(FIXTURE_SELECT), "Fruit");
    const customMiss = await timed(() => h.act("select_option", { ref: fruit2, option: "Cherry" }));
    check("a custom dropdown without the option answers quickly", !customMiss.out.ok && customMiss.ms < 4000, `${sec(customMiss.ms)}: ${customMiss.out.note.slice(0, 200)}`);
    check("...and lists the options it revealed", /Apple/.test(customMiss.out.note) && /Banana/.test(customMiss.out.note), customMiss.out.note.slice(0, 200));

    // ── run_js: a clipboard read that waits on a permission prompt ────────────
    await open(site.url);
    const clip = await timed(() => h.act("run_js", { code: "navigator.clipboard.readText()" }));
    check("a clipboard read does not wait out the whole run_js budget", clip.ms < 4000, `${sec(clip.ms)}: ${clip.out.note.slice(0, 200)}`);
    check("...and the answer says why, and what to do instead", /permission prompt/.test(clip.out.note) && /recorder/.test(clip.out.note), clip.out.note.slice(0, 240));
    const own = await h.api.act("run_js", { code: "Object.prototype.hasOwnProperty.call(navigator.clipboard, 'readText')" });
    check("...and nothing is left on navigator.clipboard once the call is over", (own as unknown) === false, String(own));
    const mention = await timed(() => h.act("run_js", { code: "(() => { const read = () => navigator.clipboard.readText(); return typeof read; })()" }));
    check("code that only mentions the clipboard read still runs", mention.out.ok && /function/.test(mention.out.note), mention.out.note.slice(0, 120));

    // ── wait / expect: the control is there under a slightly different name ───
    await open(FIXTURE_NEAR_NAME);
    await h.act("wait", { control: "Filter Date", ms: 600 });
    check("a wait that gave up names the closest controls", /Filter by Date/.test(h.lastNote()), h.lastNote().slice(0, 260));
    const expectFailure = async (opts: Record<string, unknown>) => {
      try { await (h.api.expect as (o: unknown) => Promise<boolean>)(opts); return ""; } catch (e) { return (e as Error).message; }
    };
    const expected = await expectFailure({ control: "Filter Date", ms: 400 });
    check("a failed expect names the closest controls", /Filter by Date/.test(expected), expected.slice(0, 260));
    await h.act("wait", { control: "Orders, newest first", ms: 400 });
    check("a wait for a name only the TEXT carries says so", /TEXT/.test(h.lastNote()), h.lastNote().slice(0, 260));
    const valueMiss = await expectFailure({ value: await h.api.find("Coupon"), equals: "SPRING-20", ms: 300 });
    check("a failed value expect says what the field holds", /SPRING-10/.test(valueMiss), valueMiss.slice(0, 200));
    const textMiss = await expectFailure({ text: "Orders, oldest first", ms: 300 });
    check("a failed text expect quotes the closest line", /Orders, newest first/.test(textMiss), textMiss.slice(0, 240));
    const spaced = await expectFailure({ text: "In progress 1", ms: 300 });
    check("...and says when only the spacing differs", /spacing or line breaks/.test(spaced), spaced.slice(0, 240));
    await h.act("wait", { text: "Orders, oldest first", ms: 300 });
    check("a text wait that gave up quotes the closest line too", /Orders, newest first/.test(h.lastNote()), h.lastNote().slice(0, 260));
    await h.act("wait", { control: "Zzyzx", ms: 400 });
    check("a wait with nothing close says nothing is close", !/closest/.test(h.lastNote()) && /no control named/.test(h.lastNote()), h.lastNote().slice(0, 200));

    // ── a handle whose node was re-rendered underneath it ─────────────────────
    await open(FIXTURE_RERENDER);
    const due = await h.api.find("Due date");
    const save = await h.api.find("Save", { role: "button" });
    await h.api.click(save);
    let value = "";
    try { value = await h.api.value(due); } catch (e) { value = `threw: ${(e as Error).message}`; }
    check("value() follows a handle to the re-rendered field", value === "2026-11-22", value.slice(0, 200));
    await h.api.click(save);
    let clicked = "";
    try { clicked = await h.api.click(due); } catch (e) { clicked = `threw: ${(e as Error).message}`; }
    check("click() follows a handle to a re-rendered field (not only buttons and links)", !/threw/.test(clicked), clicked.slice(0, 200));

    const kept = await h.api.find("Due date");
    await h.api.act("reload", {});
    let afterReload = "";
    try { afterReload = await h.api.value(kept); } catch (e) { afterReload = `threw: ${(e as Error).message}`; }
    check("a handle survives a reload made in the same run", afterReload === "2026-11-21", afterReload.slice(0, 200));

    // ── a bare ref from before a reload ───────────────────────────────────────
    const before = await open(FIXTURE_RERENDER);
    const dueRef = refOf(before, "Due date");
    await h.act("reload", {});
    const stale = await h.act("click", { ref: dueRef });
    const now = (await h.api.observe()).elements.find((e) => e.name === "Due date")?.ref;
    check("a ref from before a reload is still refused", !stale.ok && /reload/.test(stale.note), stale.note.slice(0, 200));
    check("...and the refusal names what it was and its ref now", /Due date/.test(stale.note) && !!now && stale.note.includes(now), `${now}: ${stale.note.slice(0, 300)}`);

    // ── a handle given to scroll({into}), and a bare ref given to scroll ─────
    await open(FIXTURE_LATE);
    const far = await h.api.find("Far away");
    const farRef = (far as { ref: string }).ref;
    await h.api.act("reload", {});
    let into = "";
    try { into = await h.api.scroll({ into: far }); } catch (e) { into = `threw: ${(e as Error).message}`; }
    check("scroll({into}) follows a handle across a reload", !/threw/.test(into), into.slice(0, 200));
    const farNow = (await h.api.observe()).elements.find((e) => e.name === "Far away")?.ref;
    let bareInto = "";
    try { bareInto = await h.api.scroll({ into: farRef }); } catch (e) { bareInto = (e as Error).message; }
    check("a bare ref from before the reload is still refused by scroll({into})…", /no element for ref/.test(bareInto), bareInto.slice(0, 200));
    check("...and the refusal says which ref the control carries now", !!farNow && bareInto.includes(`which is ${farNow} now`), `${farNow}: ${bareInto.slice(0, 300)}`);
    let bareScroll = "";
    try { bareScroll = await h.api.scroll({ direction: "down", ref: farRef }); } catch (e) { bareScroll = (e as Error).message; }
    check("...and so does scroll({ref})", !!farNow && bareScroll.includes(`which is ${farNow} now`), bareScroll.slice(0, 300));

    // ── a handle used while its control is being drawn again ──────────────────
    await open(FIXTURE_LATE);
    const lateDue = await h.api.find("Due date");
    await h.api.click(await h.api.find("Save", { role: "button" }));
    const late = await timed(async () => {
      try { return await h.api.value(lateDue); } catch (e) { return `threw: ${(e as Error).message}`; }
    });
    check("a handle waits out a control that is drawn again a moment later", late.out === "2026-11-21", `${sec(late.ms)}: ${late.out.slice(0, 200)}`);

    // ── a handle whose control is really gone says what is there instead ─────
    const renamed = await h.api.find("Due date");
    await h.api.click(await h.api.find("Rename", { role: "button" }));
    await h.api.wait({ control: "Deadline date" });
    const gone = await timed(async () => {
      try { return await h.api.value(renamed); } catch (e) { return (e as Error).message; }
    });
    check("a handle whose control is gone still stops the run", /its ref e\d+ is gone/.test(gone.out), gone.out.slice(0, 200));
    check("...within about a second", gone.ms < 1500, sec(gone.ms));
    check("...and names the closest controls there are now", /Deadline date/.test(gone.out), gone.out.slice(0, 300));

    await open(FIXTURE_LATE);
    const hidden = await h.api.find("Due date");
    await h.api.click(await h.api.find("Cover", { role: "button" }));
    let coveredNote = "";
    try { await h.api.click(hidden); } catch (e) { coveredNote = (e as Error).message; }
    check("a handle whose re-drawn control is under a dialog says what covers it", /Unsaved changes/.test(coveredNote) && /covers it/.test(coveredNote), coveredNote.slice(0, 300));

    // ── near: what it names is a heading, a region's label, or plain text ────
    await open(FIXTURE_CARDS);
    const shares = (await h.api.observe()).elements.filter((e) => e.name === "Share").sort((a, b) => a.rect.y - b.rect.y).map((e) => e.ref);
    const nearOf = async (near: unknown) => {
      try { return (await h.api.find("Share", { role: "button", near }))?.ref ?? "null"; }
      catch (e) { return `threw: ${(e as Error).message}`; }
    };
    check("three same-named buttons to tell apart", shares.length === 3, JSON.stringify(shares));
    const byHeading = await nearOf("Orders by region");
    check("near a heading picks the button in that card", byHeading === shares[0], byHeading.slice(0, 200));
    const byLabel = await nearOf("Revenue by day");
    check("near a region's label picks the button in that region", byLabel === shares[1], byLabel.slice(0, 200));
    const byText = await nearOf("QA entry 85");
    check("near a line of plain text picks the button beside it", byText === shares[2], byText.slice(0, 200));
    const nowhere = await nearOf("Refunds by week");
    check("near a name nothing shows is still refused, listing the matches",
      /nothing on the surface is named/.test(nowhere) && shares.every((r) => nowhere.includes(r)), nowhere.slice(0, 400));
    // The handle keeps the name, not the box: after the page is drawn again it is found afresh.
    const kept85 = await h.api.find("Share", { role: "button", near: "QA entry 85" });
    await h.api.act("reload", {});
    let keptClick = "";
    try { keptClick = await h.api.click(kept85); } catch (e) { keptClick = `threw: ${(e as Error).message}`; }
    const third = (await h.api.observe()).elements.filter((e) => e.name === "Share").sort((a, b) => a.rect.y - b.rect.y)[2]?.ref;
    check("a handle found near text is found again there after a reload", !!third && keptClick.includes(third), `${third}: ${keptClick.slice(0, 200)}`);

    await driver.close();
  } finally {
    site.close();
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nQUICK MISSES OK" : `\nQUICK MISSES FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
