/**
 * Form filling verb by verb — a login form, a signup form with mixed verbs (write, select an
 * option, tick a box, submit), a field that silently truncates — against a real throwaway
 * Chrome, through the test harness: these are the notes the model reads.
 *
 * Sequences are JS statements in the repl; a refused verb throws and stops the run
 * (test/repl.ts). What is pinned here is what each DRIVER verb does: set_text reads back and
 * says when the value did not take, select_option picks, click ticks and submits, and a single
 * write carries the field's read-back note.
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
  `data:text/html,${encodeURIComponent(`<!doctype html><title>forms fixture</title>${body}`)}`;

/** A link whose click NAVIGATES, plus a field, on one page: writing to the link must not reach
 *  the click (a name search for "Search" can match a link titled "research"). */
const FIXTURE_NOT_A_FIELD = page(`
<a id="away" href="#gone" onclick="document.title = 'NAVIGATED'">A research workspace</a>
<input aria-label="Real field">`);

/** A two-field login form that reports its own submit. */
const FIXTURE_LOGIN = page(`
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'signed in as ' + document.getElementById('user').value">
  <input id="user" aria-label="Username">
  <input id="pass" type="password" aria-label="Password">
  <button type="submit">Sign in</button>
</form>
<p id="out">signed out</p>`);

/** A real signup form: text, textarea, typed date, a native select, a checkbox, a button. */
const FIXTURE_SIGNUP = page(`
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'created ' + document.getElementById('plan').value + ' for ' + document.getElementById('name').value">
  <input id="name" aria-label="Full name">
  <input id="when" type="date" aria-label="Start date">
  <textarea id="bio" aria-label="Bio"></textarea>
  <select id="plan" aria-label="Plan"><option>Free</option><option>Pro</option></select>
  <input id="tos" type="checkbox" aria-label="Accept terms">
  <button type="submit">Create</button>
</form>
<p id="out">idle</p>`);

/** A field that silently truncates: the read-back rejects the value. */
const FIXTURE_TRUNCATE = page(`
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'sent'">
  <input id="pin" maxlength="3" aria-label="Pin">
  <button type="submit">Send</button>
</form>
<p id="out">idle</p>`);

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  delete process.env.COMPUTER_USE_OBS_DELTA;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);
  const driver = profile.driver;
  const open = async (url: string) => firstText(await h.act("open_url", { url }));
  const refOf = (obs: string, label: string) => obs.match(new RegExp(`(e\\d+): \\w+ "${label}"`))?.[1];

  try {
    // ── A whole login form, verb by verb ──────────────────────────────────────
    const login = await open(FIXTURE_LOGIN);
    const userRef = refOf(login, "Username");
    const passRef = refOf(login, "Password");
    check("login fields listed", !!userRef && !!passRef, login.split("\n").slice(0, 4).join(" | "));

    await h.act("set_text", { ref: userRef, text: "alice" });
    await h.act("set_text", { ref: passRef, text: "s3cret" });
    const filled = firstText(await h.act("keys", { chord: "Enter" }));
    check("the form really submitted", filled.includes("signed in as alice"), filled.split("\n")[0]);

    // ── Mixed verbs: write, pick an option, tick a box, click submit ──────────
    const signup = await open(FIXTURE_SIGNUP);
    await h.act("set_text", { ref: refOf(signup, "Full name"), text: "Ada Lovelace" });
    await h.act("set_text", { ref: refOf(signup, "Start date"), text: "2026-09-01" });
    await h.act("set_text", { ref: refOf(signup, "Bio"), text: "Mathematician." });
    const picked = firstText(await h.act("select_option", { ref: refOf(signup, "Plan"), option: "Pro" }));
    check("the option was selected", picked.includes("selected:Pro"), picked.split("\n").find((l) => l.includes("Plan")) ?? "");
    const ticked = firstText(await h.act("click", { ref: refOf(signup, "Accept terms") }));
    // Read the resulting state; a delta also contains the previous unchecked state.
    const terms = (await h.api.observe()).elements.find(e => e.role === "checkbox" && e.name === "Accept terms");
    check("the checkbox was ticked", !!terms?.state?.split(", ").includes("checked"),
      ticked.split("\n").find((l) => /checkbox "Accept/.test(l)) ?? "");
    const seq = firstText(await h.act("click", { ref: refOf(signup, "Create") }));
    check("the form submitted with the picked values", seq.includes("created Pro for Ada Lovelace"), seq.split("\n")[0]);

    // ── A write that does not read back says so ───────────────────────────────
    const trunc = await open(FIXTURE_TRUNCATE);
    const pinRef = refOf(trunc, "Pin");
    const rejected = firstText(await h.act("set_text", { ref: pinRef, text: "abcdef" }));
    check("read-back rejection is stated", rejected.includes("it did not take"), rejected.split("\n")[0]);

    // ── A write to something that is not a field must not act at all ─────────
    // The fallback chain exists for inputs that are readonly or swapped out until clicked. A
    // fill refused because the element is not an input at all is structural — clicking cannot
    // fix it, and the click lands on an unknown control (a link navigates off the site).
    const notField = await open(FIXTURE_NOT_A_FIELD);
    const linkRef = refOf(notField, "A research workspace");
    const refusal = firstText(await h.act("set_text", { ref: linkRef, text: "hello" }));
    check("writing to a non-field is refused by name", /not a text field/.test(refusal), refusal.split("\n")[0]);
    // The fixture's own source is in the data: URL every observation prints, so the proof that
    // nothing was clicked is the TITLE the click would have set, read separately.
    const stillThere = (await h.api.observe()).title;
    check("...and it neither clicked nor typed", stillThere !== "NAVIGATED" && /Nothing was clicked/.test(refusal), `title: ${stillThere}`);

    // ── One write carries the field's read-back note ──────────────────────────
    const solo = await open(FIXTURE_LOGIN);
    const one = firstText(await h.act("set_text", { ref: refOf(solo, "Username"), text: "carol" }));
    check("single action keeps the read-back note", one.includes("NOTE: the field now contains «carol»"), one.split("\n")[0]);

    await driver.close();
  } finally {
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nFORMS FILL OK" : `\nFORMS FILL FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
