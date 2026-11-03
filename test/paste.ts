/**
 * paste against a real throwaway Chrome, through the harness (the repl's API + the driver's renderings).
 *
 * Two things no other verb here can do, and both are pinned: an editor that listens for a paste
 * receives `text/html` and renders FORMATTED content (set_text can only ever deliver characters),
 * and an insertion happens AT THE CARET over any selection — so select_text + paste replaces one
 * phrase inside a value, where set_text replaces the value. Plus the honesty rules: the user's
 * real clipboard is never touched and the note says so, a field that cannot take rich text says
 * the html went unused, and a target that is not editable is refused rather than reported as
 * pasted.
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
  `data:text/html,${encodeURIComponent(`<!doctype html><title>paste fixture</title>${body}`)}`;

/** A plain field, an editor that handles its own paste, and a button — a real ref that has
 *  nowhere for text to land. */
const FIXTURE = page(`
<input id="one" aria-label="Subject" value="hello world" style="width:30em">
<div id="rich" contenteditable="true" aria-label="Body" style="border:1px solid;width:30em;min-height:3em">start</div>
<button id="btn">Save</button>
<pre id="log">no paste yet</pre>
<script>
document.getElementById('rich').addEventListener('paste', function (e) {
  document.getElementById('log').textContent = 'handler saw html: ' + e.clipboardData.getData('text/html');
  e.preventDefault();
  document.execCommand('insertHTML', false, e.clipboardData.getData('text/html'));
});
</script>`);

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  // Full observations: these assertions read a field's value back out of the element list.
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);
  const driver = profile.driver;
  const refOf = (obs: string, label: string) => obs.match(new RegExp(`(e\\d+): \\w+ "${label}"`))?.[1];
  const pageText = async () => firstText(await h.observe({ what: "text" }));
  const valueOf = async (label: string) => {
    const obs = firstText(await h.observe({ what: "elements" }));
    return obs.match(new RegExp(`e\\d+: \\w+ "${label}" \\[(?:[^\\]]*, )?filled:(.*)\\]`))?.[1] ?? obs;
  };

  try {
    const opened = firstText(await h.act("open_url", { url: FIXTURE }));
    const subject = refOf(opened, "Subject");
    const body = refOf(opened, "Body");
    check("the field and the editor are listed", !!subject && !!body, opened.split("\n").slice(0, 5).join(" | "));

    // ── An editor's own handler gets the rich half ────────────────────────────
    const rich = firstText(await h.act("paste", { ref: body, text: "bold thing", html: "<b>bold thing</b>" }));
    check("the page's own paste handler runs, and the note credits it",
      /the editor's own paste handler/.test(rich), rich.split("\n")[0]);
    const log = await pageText();
    check("...and it received the html, not just the text",
      log.includes("handler saw html: <b>bold thing</b>"), log.split("\n").find((l) => l.startsWith("handler")) ?? log);
    // Focus alone leaves the caret at the start of the editor, so the insert goes in front of
    // "start" — a paste lands where the caret IS, and nothing here has moved it yet.
    check("the editor now holds the pasted content", log.includes("bold thingstart"),
      log.split("\n").find((l) => l.includes("start")) ?? log);

    // ── A field takes the plain half, at the caret ────────────────────────────
    // The caret sits where select_text put it, so this INSERTS mid-value — the thing set_text
    // structurally cannot do.
    await h.act("select_text", { ref: subject, text: "world", caret: "before" });
    const inField = firstText(await h.act("paste", { text: "big ", html: "<b>big </b>" }));
    check("a field insert lands at the caret", (await valueOf("Subject")) === "hello big world", await valueOf("Subject"));
    check("...and says the html went unused rather than pretending it applied",
      /takes plain text only, so the html was not used/.test(inField), inField.split("\n")[0]);
    check("every paste states that the real clipboard was left alone",
      /user's own clipboard was not touched/.test(inField), inField.split("\n")[0]);

    // ── paste over a SELECTION replaces exactly it ────────────────────────────
    await h.act("select_text", { ref: subject, text: "big" });
    await h.act("paste", { text: "small" });
    check("pasting over a selection replaces exactly that phrase",
      (await valueOf("Subject")) === "hello small world", await valueOf("Subject"));

    // ── Refusals ──────────────────────────────────────────────────────────────
    const btn = refOf(firstText(await h.observe({ what: "elements" })), "Save");
    const nowhere = await h.act("paste", { ref: btn, text: "nope" });
    check("a real ref with nowhere for text to land is refused, not reported as pasted",
      !nowhere.ok && /not editable, so there is nowhere for the content to land/.test(nowhere.note), nowhere.note);

    await driver.close();
  } finally {
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nPASTE OK" : `\nPASTE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
