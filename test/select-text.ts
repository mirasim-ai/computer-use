/**
 * select_text against a real throwaway Chrome, through the harness.
 *
 * The verb exists because every other write verb replaces a field wholesale. Pinned: a match
 * selects in place and a write replaces exactly it · `near` picks among repeats by nearby text,
 * not an index · a caret INSERTS · rendered text is selectable across element boundaries ·
 * missing text or a missing `near` is refused with what to do instead.
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

const page = (body: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>select fixture</title>${body}`)}`;

/** A field whose value repeats a word — the disambiguation case — beside a textarea. */
const FIXTURE_FIELD = page(`
<input id="subject" aria-label="Subject" value="ship the draft on Friday, review the draft on Monday" style="width:40em">
<textarea id="body" aria-label="Body" style="width:40em;height:6em">alpha beta gamma
second line: beta here, meeting on Tuesday.</textarea>`);

/** Rendered text, with the phrase split across two elements — a Range case, not a value case. */
const FIXTURE_TEXT = page(`
<article id="doc"><p>The <b>quick brown</b> fox jumps over the lazy dog.</p>
<p>The quick brown fox naps.</p></article>
<div id="editor" contenteditable="true">Editable: keep this line.</div>`);

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  // Full observations: a delta drops the line of a field that did not change.
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);
  const driver = profile.driver;
  const open = async (url: string) => firstText(await h.act("open_url", { url }));
  const refOf = (obs: string, label: string) => obs.match(new RegExp(`(e\\d+): \\w+ "${label}"`))?.[1];
  /** The field's `[filled:…]` state, as the model reads it (may follow `focused`; whitespace
   *  runs collapsed). */
  const valueOf = async (label: string) => {
    const obs = firstText(await h.observe({ what: "elements" }));
    return obs.match(new RegExp(`e\\d+: \\w+ "${label}" \\[(?:[^\\]]*, )?filled:(.*)\\]`))?.[1] ?? obs;
  };

  try {
    // Every ref below comes from THIS observation: a later delta omits unchanged fields.
    const fields = await open(FIXTURE_FIELD);
    const subject = refOf(fields, "Subject");
    const body = refOf(fields, "Body");
    check("the fields are listed", !!subject && !!body, fields.split("\n").slice(0, 4).join(" | "));

    // ── `near` picks the occurrence, by the words beside it ───────────────────
    const picked = firstText(await h.act("select_text", { ref: subject, text: "draft", near: "Monday" }));
    check("repeated matches are counted and the nearest to `near` is chosen",
      /match 2 of 2, the one nearest "Monday"/.test(picked), picked.split("\n")[0]);
    // `keys` goes to the focused element, so this deletes only the selected word (the gap reads
    // as one space: the state line collapses whitespace).
    await h.act("keys", { chord: "Backspace" });
    check("typing over the selection edits one word, not the field",
      (await valueOf("Subject")) === "ship the draft on Friday, review the on Monday", await valueOf("Subject"));

    // An anchor just BEFORE its match, which comparing start offsets gets wrong: "second line:"
    // starts 11 chars before its "beta", 7 from the first "beta".
    const after = firstText(await h.act("select_text", { ref: body, text: "beta", near: "second line:" }));
    check("`near` measures span to span, so an anchor before the match still picks it",
      /match 2 of 2/.test(after), after.split("\n")[0]);

    // ── A caret INSERTS: the verb's second half ───────────────────────────────
    const caret = firstText(await h.act("select_text", { ref: body, text: "Tuesday", caret: "before" }));
    check("a caret says nothing is selected and that a write inserts",
      /caret placed before "Tuesday"/.test(caret) && /INSERT/.test(caret), caret.split("\n")[0]);
    await h.act("set_text", { text: "next " });
    // The state line cuts at 60 chars, so assert the caret's neighbourhood, not either end.
    check("the write landed at the caret, inside the existing text",
      (await valueOf("Body")).includes("meeting on next Tue"), await valueOf("Body"));

    // ── Rendered text, across element boundaries ──────────────────────────────
    await open(FIXTURE_TEXT);
    const spanning = firstText(await h.act("select_text", { text: "quick brown fox jumps", near: "lazy" }));
    // The note is the page's selection READ BACK; a mismatch would print a WARNING instead.
    check("a phrase split across elements is selected as one range, and reads back as it",
      /selected "quick brown fox jumps"/.test(spanning), spanning.split("\n")[0]);

    // ── Refusals name the way out ─────────────────────────────────────────────
    const absent = await h.act("select_text", { text: "no such phrase" });
    check("text that is not there is refused, pointing at the text channel",
      !absent.ok && /is not on this page/.test(absent.note) && /text\(\)/.test(absent.note), absent.note);
    const badNear = await h.act("select_text", { text: "quick", near: "no such anchor" });
    check("a `near` that is not there says so instead of silently picking the first",
      !badNear.ok && /cannot pick between the 2 matches/.test(badNear.note), badNear.note);

    await driver.close();
  } finally {
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nSELECT TEXT OK" : `\nSELECT TEXT FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
