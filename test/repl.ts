/**
 * computer_repl against a real throwaway Chrome, at the tool surface.
 *
 * What it pins is what a persistent code-execution tool promises and what makes it safe:
 * the API reference comes with the FIRST result and never again · top-level declarations
 * survive to the next call · bare verbs drive the active surface · surface HANDLES switch to
 * their target before acting, and work through two of them lands on two pages · a ref read on
 * one surface is refused on another, by name, before dispatch · a handle whose tab closed says
 * so and tells the code to re-acquire · reset drops the bindings and nothing else · a second verb
 * in flight is refused · two CALLS in flight are serialized by the tool layer · a handle found by name
 * survives its list re-rendering · a stale ref stops the run before dispatch · the journal is bounded ·
 * a verb left un-awaited cannot take the process down · and the caps and the sealed sandbox are real.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Result = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const allText = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
const line = (s: string, re: RegExp) => s.split("\n").find((l) => re.test(l)) ?? s.split("\n")[0];

/** Page A opens page B in a real second tab (data: URLs cannot open windows). */
const PAGE_A = `<!doctype html><title>Alpha</title><h1>Alpha page</h1>
<input aria-label="alpha field">
<button onclick="const w = window.open('about:blank'); w.location = '/b.html';">Open page B</button>
${Array.from({ length: 3 }, (_, i) => `<label><input type="checkbox" aria-label="Row ${i + 1}"> Row ${i + 1}</label>`).join("")}`;
const PAGE_B = `<!doctype html><title>Beta</title><h1>Beta page</h1>
<input aria-label="beta field"><button onclick="window.close()">Close me</button>`;
/** A list that REBUILDS itself on every click: every ref is re-minted underneath the loop. */
const PAGE_CHURN = `<!doctype html><title>Churn</title><div id="list"></div><p id="done">done: 0</p>
<script>
let done = 0;
function render() {
  document.getElementById('list').innerHTML = '';
  for (let i = 1; i <= 3; i++) {
    const b = document.createElement('button');
    b.textContent = 'Item ' + i;
    b.onclick = function () { done++; document.getElementById('done').textContent = 'done: ' + done; render(); };
    document.getElementById('list').appendChild(b);
  }
}
render();
</script>`;
/** Two named fields — the shape that shows what two interleaved callers do to one caret. */
const PAGE_FIELDS = `<!doctype html><title>Fields</title><input aria-label="Field A"><br><input aria-label="Field B">`;

function serve(): Promise<{ base: string; close: () => void }> {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url === "/b.html" ? PAGE_B : req.url === "/churn.html" ? PAGE_CHURN : req.url === "/fields.html" ? PAGE_FIELDS : PAGE_A);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    resolve({ base: `http://127.0.0.1:${port}`, close: () => srv.close() });
  }));
}

async function main() {
  const chrome = await spawnChrome({});
  const fixtures = await serve();
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  delete process.env.COMPUTER_USE_WINDOW; // real second tabs must open
  delete process.env.COMPUTER_USE_TAB;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const tool = Object.fromEntries(profile.tools.map((t) => [t.name, t.execute]));
  const run = async (code: string) => allText(await tool.computer_repl({ code }) as Result);

  try {
    check("the session's tool set is the repl and its reset",
      Object.keys(tool).join(",") === "computer_repl,computer_repl_reset", Object.keys(tool).join(", "));

    // ── The reference comes with the first result, and only the first ────────
    const first = await run(`return 1;`);
    check("the first result carries the API reference", /API reference — computer_repl/.test(first) && /Returned: 1/.test(first), line(first, /^Run/));
    const second = await run(`return 2;`);
    check("the second result does not", !/API reference — computer_repl/.test(second) && /Returned: 2/.test(second), line(second, /^Run/));
    check("computer.help() returns it on demand", /Rules that are enforced/.test(await run(`return computer.help();`)));

    // ── Verbs come from a bound surface, and only from one ───────────────────
    // A throwaway Chrome already holds two about:blank tabs that are not this session's, beside
    // the one it opened for itself: the no-argument form binds THAT one, never one of the others.
    // The refusal (several surfaces, none of them this session's) is pinned over Electron below;
    // the single-surface form in test/macos-ui.ts.
    const mineFirst = await run(`const w0 = await computer.surface(); const all = await computer.surfaces();`
      + ` return {mine: w0.mine, active: w0.active, others: all.filter((s) => s !== w0).map((s) => s.mine)};`);
    check("computer.surface() binds the tab this session opened while other tabs are open",
      /Returned: \{"mine":true,"active":true,"others":\[false(,false)*\]\}/.test(mineFirst), line(mineFirst, /Returned|STOPPED/));
    const bound = await run(`w = (await computer.surfaces()).find(s => s.active) ?? (await computer.surfaces())[0]; return w.kind;`);
    check("a surface picked out of the listing is a working handle", /Returned: /.test(bound), line(bound, /Returned/));
    const loose = await run(`await click('e1');`);
    check("a top-level verb is gone, and the refusal says where verbs went",
      /click is not defined/.test(loose) && /verbs live on a surface handle/.test(loose) && /computer\.surface\(/.test(loose),
      line(loose, /is not defined/));
    const byUrl = await run(`await computer.surface('localhost:9');`);
    check("a URL given to computer.surface() is answered as a page to open, with the openUrl that opens it",
      /no surface matches "localhost:9"/.test(byUrl) && /never by URL — and opens nothing/.test(byUrl)
        && /w\.openUrl\(\{url: "http:\/\/localhost:9"\}\)/.test(byUrl), line(byUrl, /opens nothing|no surface matches/));
    const byName = await run(`await computer.surface('Gamma');`);
    check("…while a missed title gets the listing alone", /no surface matches "Gamma"/.test(byName) && !/opens nothing/.test(byName),
      line(byName, /no surface matches/));
    const typo = await run(`await clck('e1');`);
    check("…while a real typo is left alone", /clck is not defined/.test(typo) && !/verbs live on a surface handle/.test(typo),
      line(typo, /is not defined/));

    // The other side of the macOS honesty check (test/macos-ui.ts): a platform whose read DOES
    // contain what is off-screen keeps the promise, and keeps `visible` as a way to narrow.
    {
      const ref = await run(`return computer.help();`);
      check("a page's reference still promises find() the whole surface",
        /whole surface/.test(ref) && /visible \(on screen only\)/.test(ref));
      check("…and find({visible}) is accepted there, not refused",
        !/narrows nothing on this platform/.test(await run(`return (await w.find('nothing-by-this-name', {visible: true})) === null;`)));
    }

    // ── `observation` hands back less than was rendered, never less than was taken ──
    {
      const raw = (code: string, observation?: string) =>
        tool.computer_repl(observation ? { code, observation } : { code }) as Promise<Result>;
      const full = allText(await raw(`return 'a';`));
      check("by default the observation carries the element list",
        /Interactive elements|Changes since last observation/.test(full));

      const brief = await raw(`return 'b';`, "brief");
      const bt = allText(brief);
      check("brief keeps the head and drops the listing",
        /Title:|Returned: b/.test(bt) && !/Interactive elements/.test(bt) && !/^e\d+: /m.test(bt),
        `${bt.split("\n").length} lines vs ${full.split("\n").length}`);
      check("…and says so in details", brief.details.observation === "brief", String(brief.details.observation));

      const none = allText(await raw(`return 'c';`, "none"));
      check("none leaves the journal and the return value alone", /Returned: c/.test(none) && !/Title:/.test(none),
        `${none.split("\n").length} lines`);

      const back = allText(await raw(`return 'd';`));
      check("the next default call renders normally — the observation was taken all along",
        /Interactive elements|Changes since last observation|unchanged since/.test(back));
    }

    // ── Top-level declarations persist ────────────────────────────────────────
    await run(`const n = 40; let { a, b } = { a: 1, b: 2 }; function twice(x) { return x * 2; } class K { v() { return 'k'; } }`);
    const later = await run(`return [twice(n) + a + b, new K().v()];`);
    check("const / destructured let / function / class from an earlier call are all still there",
      /Returned: \[83,"k"\]/.test(later), line(later, /Returned/));

    // ── A loop of verbs through one handle ────────────────────────────────────
    const looped = await run(`
      await w.openUrl({ url: '${fixtures.base}/a.html' });
      const boxes = (await w.observe()).elements.filter(e => e.role === 'checkbox');
      for (const box of boxes) await w.click(box.ref);
      return boxes.length;
    `);
    check("a loop of verbs runs and journals", /Run completed 5 steps/.test(looped) && /Returned: 3/.test(looped), line(looped, /^Run/));
    check("the observation at the end shows the effect", (looped.match(/checked/g)?.length ?? 0) >= 3);

    // ── A run is one round to the driver ──────────────────────────────────────
    // The verdict after a run that only wrote must not read as "no effect": the write landed
    // and read back. And the observations-without-acting counter resets when a run acts.
    const wrote = await run(`await w.setText(await w.find('alpha field'), 'held'); return 'ok';`);
    check("a verified write is reported as holding the text, not as having had no effect",
      /holds the text you sent|now contains «held»/.test(wrote) && !/likely had no effect|had NO effect/.test(wrote), line(wrote, /NOTE/));
    for (let i = 0; i < 3; i++) await run(`return (await w.observe()).elements.length;`);
    const nudged = await run(`return 'look';`);
    // The other half of what `none` must not hide: a note about THIS ACTION rides above the body,
    // so it survives the cut by position rather than by matching its text.
    {
      const nudged = allText(await (tool.computer_repl({ code: "return 1;", observation: "none" }) as Promise<Result>));
      check("a note about the action survives observation:'none'",
        /NOTE: /.test(nudged) && !/Interactive elements/.test(nudged),
        (nudged.match(/NOTE:[^\n]{0,70}/) ?? ["(no note)"])[0]);
    }

    check("three looks in a row draw the push-to-act nudge", /observations in a row without acting/.test(nudged), line(nudged, /NOTE/));
    await run(`await w.click(await w.find('Row 1'));`);
    const rested = await run(`return 'look';`);
    check("one acting run resets the counter", !/observations in a row without acting/.test(rested), line(rested, /NOTE/) ?? "(no NOTE)");

    // A run that acted and THEN waited is judged by its actions: here they cancel out, and the
    // wait's "condition has not arrived" reading would be wrong — its condition did arrive.
    // Baseline end: Row 2 and Row 3 ticked, focus on Row 3. The run under test toggles each twice,
    // alternating so no two neighbouring actions repeat, and lands exactly there again.
    await run(`await w.click(await w.find('Row 2')); await w.click(await w.find('Row 3'));`);
    const tripped = await run(`
      for (const r of ['Row 2', 'Row 3', 'Row 2', 'Row 3']) await w.click(await w.find(r));
      await w.wait({});
    `);
    check("actions then a wait read as a round trip, not as a pending wait",
      /ends this run where it started/.test(tripped) && !/wait whose condition/.test(tripped), line(tripped, /NOTE/) ?? "(no NOTE)");

    // ── A screenshot is a FILE the script keeps, not only a picture in the result ──
    const shotDir = mkdtempSync(join(tmpdir(), "computer-use-shot-test-"));
    try {
      const mine = join(shotDir, "after.jpg");
      const shots = await run(`
        const a = await w.screenshot();
        const b = await w.screenshot({ path: ${JSON.stringify(mine)} });
        const refused = [];
        for (const p of [${JSON.stringify(mine)}, ${JSON.stringify(join(shotDir, "x.png"))}, 'rel.jpg']) {
          try { await w.screenshot({ path: p }); refused.push('WROTE ' + p); } catch (e) { refused.push(e.message); }
        }
        return { a, b, refused };
      `);
      const got = JSON.parse(shots.split("Returned: ")[1]!.split("\n")[0]!);
      check("a screenshot with no path lands in the temp directory and says where",
        typeof got.a.path === "string" && got.a.path.startsWith(tmpdir()) && existsSync(got.a.path) && got.a.width > 0 && !!got.a.host,
        JSON.stringify(got.a));
      check("a screenshot with a path writes exactly there, as a JPEG",
        got.b.path === mine && readFileSync(mine).subarray(0, 2).toString("hex") === "ffd8", JSON.stringify(got.b));
      check("an existing file is never overwritten", /already exists/.test(got.refused[0]), got.refused[0]);
      check("the extension must match the surface's format", /must end in \.jpg/.test(got.refused[1]), got.refused[1]);
      check("a relative path is refused", /must be absolute/.test(got.refused[2]), got.refused[2]);
      check("...and nothing was written for the refused paths", !existsSync(join(shotDir, "x.png")) && !existsSync("rel.jpg"));
      writeFileSync(join(shotDir, "keep.jpg"), "user file");
      await run(`try { await w.screenshot({ path: ${JSON.stringify(join(shotDir, "keep.jpg"))} }); } catch {}`);
      check("a user's file at that path is left untouched", readFileSync(join(shotDir, "keep.jpg"), "utf8") === "user file");
    } finally {
      rmSync(shotDir, { recursive: true, force: true });
    }

    // ── Data comes back instead of costing N observations ────────────────────
    const collected = await run(`
      const rows = (await w.observe()).elements.filter(e => e.role === 'checkbox');
      return rows.map(r => r.name);
    `);
    check("a run brings back data the model would otherwise read from N observations", /Returned: \["Row 1","Row 2","Row 3"\]/.test(collected), line(collected, /Returned/));

    // ── find() handles survive the list re-rendering underneath them ──────────
    const churned = await run(`
      await w.openUrl({ url: '${fixtures.base}/churn.html' });
      for (let i = 0; i < 3; i++) await w.click(await w.find('Item 2'));
    `);
    check("a handle re-resolves after the surface re-mints its refs", /done: 3/.test(churned), line(churned, /done:/));

    // ── A bad ref stops the run before it dispatches, and the journal says where ──
    const stopped = await run(`
      await w.click(await w.find('Item 1'));
      await w.click('e99999');
      await w.click(await w.find('Item 3'));
    `);
    check("a stale ref is refused by name before dispatch, and the run stops there",
      /Run STOPPED after 2 steps/.test(stopped) && /not among the refs/.test(stopped), line(stopped, /^Run/));
    check("...and the steps that DID run are still in the journal", /1\. find Item 1/.test(stopped) && /2\. click e/.test(stopped), line(stopped, /1\. find/));

    // ── A run whose only verb was refused is not "a look" ──────────────────────
    await run(`await w.observe();`);
    const refusedOnly = await run(`return await w.dialog({ answer: false }).catch((e) => 'caught');`);
    check("a refused verb's run does not claim it was a look", /caught/.test(refusedOnly) && !/that was a look/.test(refusedOnly),
      line(refusedOnly, /^NOTE/) ?? "(no NOTE)");

    // ── The journal is bounded ────────────────────────────────────────────────
    const long = await run(`for (let i = 0; i < 40; i++) computer.log('tick ' + i);`);
    check("a long run prints both ends and counts the middle",
      /1\. log: tick 0/.test(long) && /… 16 steps not listed …/.test(long) && /40\. log: tick 39/.test(long), line(long, /not listed/));

    // ── Two calls in flight are serialized by the tool layer ──────────────────
    // A model may emit several tool calls in one turn and the loop may run them concurrently,
    // but the surface has ONE focus and ONE caret, so unchained both texts land in one field.
    // `guarded` in tools/index.ts chains every computer_repl call.
    await run(`await w.openUrl({ url: '${fixtures.base}/fields.html' });`);
    await Promise.all([
      tool.computer_repl({ code: `await w.setText(await w.find('Field A'), 'alpha');` }),
      tool.computer_repl({ code: `await w.setText(await w.find('Field B'), 'bravo');` }),
    ]);
    const fields = await run(`return (await w.observe()).elements.map(e => e.name + '=' + e.state);`);
    check("concurrent computer_repl calls do not cross fields", /Field A=[^"]*filled:alpha/.test(fields) && /Field B=[^"]*filled:bravo/.test(fields), line(fields, /Returned/));
    await run(`await w.openUrl({ url: '${fixtures.base}/a.html' });`);
    const renamed = await run(`await w.runJs({ code: "document.title = 'Alpha renamed'" }); throw new Error('stop on purpose');`);
    check("a stop's Still bound line names the tab by the title it has now, not the one it was bound with",
      /Still bound: .*w → \S+ «Alpha renamed»/.test(renamed), line(renamed, /Still bound|STOPPED/));
    await run(`await w.runJs({ code: "document.title = 'Alpha'" });`);
    const waited = await run(`return await w.runJs({ code: "new Promise((r) => setTimeout(() => r(7), 1500))", ms: 3000 });`);
    check("runJs({code, ms}) reaches the page with its wait", /Returned: 7/.test(waited), line(waited, /Returned|STOPPED/));

    // ── Handles: two tabs, one run ────────────────────────────────────────────
    const opened = await run(`
      tabA = await computer.surface('Alpha');
      await tabA.click(await tabA.find('Open page B'));
      await tabA.wait({ ms: 900 });
      const all = await computer.surfaces();
      tabB = all.find(s => s.title === 'Beta');
      return all.map(s => s.title);
    `);
    // By property, never by the whole list: a throwaway Chrome always holds its own start page,
    // which "not tabA" would pick.
    check("a second surface appeared and both are handles",
      /"Alpha"/.test(line(opened, /Returned/) ?? "") && /"Beta"/.test(line(opened, /Returned/) ?? ""), line(opened, /Returned/));

    const named = await run(`const beta = await computer.surface('Beta'); await beta.focus(); return beta.title;`);
    check("a surface binds by a piece of its title", /Returned: Beta/.test(named), line(named, /Returned/));

    const crossed = await run(`
      const alpha = (await tabA.observe()).elements.find(e => e.name === 'alpha field');
      await tabB.setText(alpha.ref, 'wrong tab');
    `);
    check("a ref read on A is refused on B, by name, before dispatch",
      /Run STOPPED/.test(crossed) && /was read on surface/.test(crossed) && !/set_text/.test(line(crossed, /^\s+\d+\. set_text/) ?? ""),
      line(crossed, /^Run/));
    check("...and switching to A for the read was journaled as a focus", /\d+\. focus .*→ Alpha/.test(crossed), line(crossed, /focus/));

    const both = await run(`
      await tabA.setText(await tabA.find('alpha field'), 'from A');
      await tabB.setText(await tabB.find('beta field'), 'from B');
      const sA = (await tabA.observe()).elements.find(e => e.name === 'alpha field').state;
      const sB = (await tabB.observe()).elements.find(e => e.name === 'beta field').state;
      return [sA, sB];
    `);
    check("work through two handles lands on two pages", /Returned: \[".*filled:from A",".*filled:from B"\]/.test(both), line(both, /Returned/));
    check("each switch is one journaled focus", (both.match(/\d+\. focus /g)?.length ?? 0) >= 3, `${both.match(/\d+\. focus /g)?.length ?? 0} focus lines`);

    // ── A handle whose surface closed says so ─────────────────────────────────
    const gone = await run(`
      await tabB.click(await tabB.find('Close me'));
      await tabB.wait({ ms: 600 });
      await tabB.observe();
    `);
    check("a closed tab's handle is refused with a re-acquire instruction", /Run STOPPED/.test(gone) && /is gone/.test(gone) && /computer\.surfaces\(\)/.test(gone), line(gone, /^Run/));
    const survivors = await run(`return (await computer.surfaces()).map(s => s.title);`);
    check("the other surface is still there and usable",
      /"Alpha"/.test(survivors) && !/"Beta"/.test(survivors), line(survivors, /Returned/));

    // ── One verb in flight ────────────────────────────────────────────────────
    const raced = await run(`
      const f = await tabA.find('alpha field');
      const r = await Promise.allSettled([
        (async () => { await tabA.click(f); await tabA.keys('a', 2); })(),
        (async () => { await tabA.click(f); await tabA.keys('b', 2); })(),
      ]);
      return r.filter(x => x.status === 'rejected').length;
    `);
    check("a second verb in flight is refused, by name", /was started while/.test(raced) && /Returned: [1-9]/.test(raced), line(raced, /was started/));

    // ── An un-awaited failing verb cannot take the process down ───────────────
    const dangling = await run(`w.click('e99999'); return 'alive';`);
    check("a verb left un-awaited fails quietly instead of ending the process", /Returned: alive/.test(dangling), line(dangling, /^Run/));
    check("...and the next call still runs", /Returned: 7/.test(await run(`return 7;`)));

    // ── Caps and sandbox ──────────────────────────────────────────────────────
    const capped = await run(`for (let i = 0; i < 500; i++) computer.log(i);`);
    check("the step cap stops a runaway loop", /Run STOPPED/.test(capped) && /step cap reached/.test(capped), line(capped, /^Run/));
    const sealed = await run(`return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof console].join(',');`);
    check("no Node reaches the runtime", /Returned: undefined,undefined,undefined,undefined,undefined/.test(sealed), line(sealed, /Returned/));
    const parsed = await run(`const u = new URL('http://localhost:5173/board?q=rel&sort=title'); return [u.pathname, u.searchParams.get('sort'), new URLSearchParams('a=1&b=2').get('b')].join(',');`);
    check("URL and URLSearchParams are there to check a page's address", /Returned: "?\/board,title,2"?/.test(parsed), line(parsed, /Returned|STOPPED/));
    const broken = await run(`this is not javascript`);
    check("a syntax error is an answer", /Run STOPPED/.test(broken) && /SyntaxError/.test(broken), line(broken, /^Run/));

    // ── Reset drops the bindings, and only the bindings ───────────────────────
    check("a binding is there before reset", /Returned: number/.test(await run(`return typeof n;`)));
    // What reset must leave alone is the surfaces, however many the browser happens to hold.
    const surfacesBefore = (await run(`return (await computer.surfaces()).length;`)).match(/Returned: (\d+)/)?.[1] ?? "?";
    const resetText = allText(await tool.computer_repl_reset({}) as Result);
    check("reset says what it did and did not do", /reset/.test(resetText) && /No surface was touched/.test(resetText), resetText.split("\n")[0]);
    const after = await run(`return [typeof n, typeof tabA, typeof w, (await computer.surfaces()).length];`);
    check("after reset the bindings are gone, the tab is not",
      new RegExp(`Returned: \\["undefined","undefined","undefined",${surfacesBefore}\\]`).test(after) && /API reference — computer_repl/.test(after),
      line(after, /Returned/));

    await profile.driver.close();

    // ── A ref from the closing observation works once the handle is bound ────────
    // `computer.surfaces()` alone ends on an observation of the window the driver is on; binding
    // that window in the next call must not throw away the refs that observation handed out.
    // Over the Electron driver, which attaches to any Chromium (here a second throwaway Chrome
    // holding one page, so there is exactly one window).
    {
      const solo = await spawnChrome({});
      try {
        await fetch(`${solo.cdpUrl}/json/new?${fixtures.base}/fields.html`, { method: "PUT" });
        for (const t of await (await fetch(`${solo.cdpUrl}/json/list`)).json() as Array<{ id: string; type: string; url: string }>) {
          if (t.type === "page" && t.url === "about:blank") await fetch(`${solo.cdpUrl}/json/close/${t.id}`);
        }
        const { ElectronDriver } = await import("../src/platform/electron/driver.ts");
        const { createComputerUseTools } = await import("../src/platform/tools/index.ts");
        const electron = new ElectronDriver({ cdpUrl: solo.cdpUrl });
        const ownership = { claim: async () => {}, release: async () => {}, releaseAll: async () => {} };
        const etool = Object.fromEntries(createComputerUseTools([{ driver: electron }], { ownership }).map((t) => [t.name, t.execute.bind(t)]));
        const erun = async (code: string) => allText(await etool.computer_repl!({ code }) as Result);
        const listed = await erun(`return (await computer.surfaces()).map(s => s.id);`);
        const ref = listed.match(/(e\d+): textbox "Field A"/)?.[1];
        const used = await erun(`const w = await computer.surface('w1'); await w.setText('${ref}', 'seen'); return await w.value('${ref}');`);
        check("a ref read in the previous call's closing observation is accepted after binding that window",
          !!ref && /Returned: "?seen"?$/m.test(used) && !/not among the refs/.test(used), `${ref} · ${line(used, /Returned|STOPPED/)}`);
        // A second window, and neither is this runtime's (an attached app has none of its own):
        // the no-argument form has nothing to prefer, so it refuses and lists them.
        await fetch(`${solo.cdpUrl}/json/new?${fixtures.base}/b.html`, { method: "PUT" });
        // Playwright learns of the new target asynchronously.
        for (let i = 0; i < 40 && !/Returned: 2/.test(await erun(`return (await computer.surfaces()).length;`)); i++) await new Promise((r) => setTimeout(r, 50));
        const ambiguous = await erun(`await computer.surface();`);
        check("computer.surface() refuses among several surfaces none of which is this session's, and lists them",
          /2 surfaces are open — name one/.test(ambiguous) && /Fields/.test(ambiguous) && /Beta/.test(ambiguous), line(ambiguous, /surfaces are open|Returned/));
        await electron.close();
      } finally {
        solo.cleanup();
      }
    }
  } finally {
    fixtures.close();
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nREPL OK" : `\nREPL FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
