/**
 * find(name, {why: true}) against a real throwaway Chrome, at the tool surface.
 *
 * What it pins: a miss answers WHY as data a script can branch on, in the same run — `covered`
 * (with the control and what covers it, and the cover's ref when the cover is itself a listed
 * control), `offscreen` (visible:true dropped it), `filtered` (a role excluded it), `text` (only
 * the readable text carries it), `absent` · a hit answers exactly the handle it answers without
 * `why` · without `why` a miss is still `null` · a miss passed on as a target is refused by name ·
 * and the covered branch leads to a way out that works within one run.
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
const line = (s: string, re: RegExp) => s.split("\n").find((l) => re.test(l)) ?? s.split("\n")[0];
/** The JSON a run returned, parsed; null when it stopped instead. */
const returned = (s: string): any => {
  const m = /^Returned: (.*)$/m.exec(s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return m[1]; }
};

/** A shop page: Buy now sits under a full-viewport backdrop (with its own Dismiss button on top),
 *  Save sits under a floating Chat button, a heading names something no control carries, and a
 *  button lives far below the fold. */
const PAGE_SHOP = `<!doctype html><title>Shop</title>
<style>
  body { margin: 0; font: 16px sans-serif; }
  #backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); }
  #backdrop button { position: absolute; top: 300px; left: 300px; }
  #save { position: absolute; top: 220px; left: 20px; width: 120px; height: 40px; }
  #chat { position: fixed; top: 210px; left: 10px; width: 160px; height: 60px; z-index: 5; }
  #far { position: absolute; top: 3000px; left: 20px; }
</style>
<h1>Quarterly report</h1>
<button id="buy" style="position:absolute; top: 120px; left: 20px;">Buy now</button>
<button id="save">Save</button>
<button id="chat">Chat with us</button>
<button id="far">Far away</button>
<div id="backdrop"><button onclick="document.getElementById('backdrop').remove()">Dismiss</button></div>`;

function serve(): Promise<{ base: string; close: () => void }> {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_SHOP);
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
  delete process.env.COMPUTER_USE_WINDOW;
  delete process.env.COMPUTER_USE_TAB;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const tool = Object.fromEntries(profile.tools.map((t) => [t.name, t.execute]));
  const run = async (code: string) => allText(await tool.computer_repl({ code }) as Result);

  try {
    await run(`w = await computer.surface(); await w.openUrl({ url: '${fixtures.base}/shop.html' }); await w.wait({});`);
    const ref = await run(`return computer.help();`);
    check("the reference documents why and its reasons",
      /near\?, why\?\}/.test(ref) && /'covered'/.test(ref) && /'offscreen'/.test(ref) && /'filtered'/.test(ref)
        && /'text'/.test(ref) && /'absent'/.test(ref));

    // ── Without why, nothing changed ─────────────────────────────────────────
    const plain = await run(`return (await w.find('Buy now')) === null;`);
    check("without why a covered miss is still null", returned(plain) === true, line(plain, /Returned|STOPPED/));
    const plainAbsent = await run(`return (await w.find('Nothing named this anywhere')) === null;`);
    check("without why an absent miss is still null", returned(plainAbsent) === true, line(plainAbsent, /Returned|STOPPED/));

    // ── A hit answers the same handle either way ─────────────────────────────
    const sameFar = await run(`const a = await w.find('Far away'); const b = await w.find('Far away', {why: true});`
      + ` return JSON.stringify(a) === JSON.stringify(b) && typeof a.ref === 'string' ? 'same' : JSON.stringify([a, b]);`);
    check("a hit with why is exactly the handle without it", returned(sameFar) === "same", line(sameFar, /Returned|STOPPED/));

    // ── covered ──────────────────────────────────────────────────────────────
    const covered = returned(await run(`return await w.find('Buy now', {why: true});`));
    check("a covered control answers reason 'covered' with ref null",
      covered?.ref === null && covered?.reason === "covered", JSON.stringify(covered));
    check("…naming the control it found under the cover",
      /^e\d+$/.test(covered?.match?.ref ?? "") && covered?.match?.name === "Buy now" && covered?.match?.role === "button",
      JSON.stringify(covered?.match));
    check("…and what covers it, by the label the journal uses",
      /fixed layer over the whole viewport/.test(covered?.by?.name ?? "") && /covers it/.test(covered?.note ?? ""),
      JSON.stringify(covered?.by));
    check("…with no ref for a cover that is not a listed control", covered?.by && !("ref" in covered.by), JSON.stringify(covered?.by));

    // A miss handed on as a target is refused by name, before anything is pressed.
    const clicked = await run(`await w.click(await w.find('Buy now', {why: true}));`);
    check("a miss passed to click is refused with its reason and note",
      /find\(\) miss \(reason: covered\)/.test(clicked) && /covers it/.test(clicked), line(clicked, /miss|STOPPED/));
    const scrolled = await run(`await w.scroll({into: await w.find('Buy now', {why: true})});`);
    check("…and so is one passed to scroll({into})", /find\(\) miss \(reason: covered\)/.test(scrolled), line(scrolled, /miss|STOPPED/));

    // ── offscreen / filtered / text / absent ─────────────────────────────────
    const off = returned(await run(`return await w.find('Far away', {visible: true, why: true});`));
    check("visible:true dropping an off-viewport control answers 'offscreen' and names it",
      off?.ref === null && off?.reason === "offscreen" && off?.match?.name === "Far away", JSON.stringify(off));
    const filtered = returned(await run(`return await w.find('Far away', {role: 'link', why: true});`));
    check("a role that excludes the control answers 'filtered' and names it",
      filtered?.reason === "filtered" && filtered?.match?.role === "button", JSON.stringify(filtered));
    const text = returned(await run(`return await w.find('Quarterly report', {why: true});`));
    check("a name only the readable text carries answers 'text'", text?.reason === "text" && !text?.match, JSON.stringify(text));
    const absent = returned(await run(`return await w.find('Nothing named this anywhere', {why: true});`));
    check("a name nothing carries answers 'absent'",
      absent?.ref === null && absent?.reason === "absent" && !absent?.match && typeof absent?.note === "string", JSON.stringify(absent));

    // ── The way out, in one run ──────────────────────────────────────────────
    const branched = await run(`
      let m = await w.find('Buy now', {role: 'button', why: true});
      const first = m.reason;
      if (!m.ref && m.reason === 'covered') { await w.click(await w.find('Dismiss')); await w.wait({}); m = await w.find('Buy now', {role: 'button', why: true}); }
      if (!m.ref) throw new Error(m.note);
      await w.click(m);
      return first + ' then ' + m.name;`);
    check("covered → dismiss → find again → click, within one run",
      returned(branched) === "covered then Buy now", line(branched, /Returned|STOPPED/));

    // ── A cover that is itself a listed control carries its ref ──────────────
    const under = returned(await run(`return await w.find('Save', {why: true});`));
    const chat = returned(await run(`return await w.find('Chat with us');`));
    check("a control under a floating button answers 'covered', with that button's ref in by",
      under?.reason === "covered" && /Chat with us/.test(under?.by?.name ?? "") && under?.by?.ref === chat?.ref,
      `${JSON.stringify(under)} · chat ${chat?.ref}`);
  } finally {
    fixtures.close();
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nFIND-WHY OK" : `\nFIND-WHY FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
