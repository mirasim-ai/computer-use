/**
 * `run_js` — the DevTools console as a verb, for any Chromium page.
 *
 * For reading, computing and diagnosing what is not on the screen (a whole table, localStorage,
 * a page variable, an API the page exposes). NOT for simulating a user: `element.click()` from
 * here skips the visibility, occlusion and real-input checks and leaves no journal entry, verdict
 * or effect evidence.
 *
 * A browser tab is a third-party site holding the user's logged-in session; that risk is why
 * the channel is bounded, reported and opt-in, and the schema says so.
 */

import type { Page } from "playwright-core";
import type { ActResult } from "../types.ts";

/** How long a run waits for a result unless it asks for longer. Evaluation has no natural bound
 *  (an expression may await a promise that never settles), and a wedged step must not wedge the
 *  loop — so the default stays short, and code that is MEANT to run longer says so with `ms`. */
export const RUN_JS_TIMEOUT_MS = 10_000;
/** The most `ms` may ask for: the call's whole budget is 60s, and the wait spends it. */
export const RUN_JS_MAX_MS = 45_000;
export const RUN_JS_MIN_MS = 1_000;

export const RUN_JS_MS_DESC =
  `How long to wait for the value, in ms (default ${RUN_JS_TIMEOUT_MS}, ${RUN_JS_MIN_MS}–${RUN_JS_MAX_MS}). Raise it only for code `
  + "that is meant to run that long (a loop that waits for the page between steps); it spends the call's 60s, and "
  + "a promise that never settles waits the whole time.";

/** Notes ride an observation prefix, so an enormous result must not drown the observation. */
function clipResult(s: string, max = 2000): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} chars)`;
}

/** How much of a successful result the journal line repeats: the whole value goes back to the
 *  script as `value`, so the line is only a receipt. */
const RESULT_PREVIEW_CHARS = 200;

/** The shared description for the `code` property; each driver writes its own framing around it. */
export const RUN_JS_CODE_DESC =
  "JavaScript evaluated in the page, like typing into the DevTools console — an expression, or a function body "
  + "using `return` (either form works). An expression returning a Promise "
  + "is awaited. Only a JSON-safe value comes back — a string, number, array or plain object; a DOM node, a "
  + "function or a circular structure does not survive, so map what you want out of it in the expression. "
  + "READ, COMPUTE, DIAGNOSE with it: a whole table or list in one call, localStorage, the scroll position, a "
  + "page variable, an API the page already exposes. To ACT — click, type, select — use the interaction verbs: "
  + "element.click() from here skips the visibility and real-input checks and leaves no record that the page "
  + "was changed. If you do change state with it, say so in your report.";

/**
 * A top-level `return` is a SyntaxError for an expression, but `computer_repl`'s own `code` is a
 * function body and the model writes both in one call; on this error the source is re-run
 * wrapped. Safe: a SyntaxError means the page ran NOTHING. Narrow on purpose — any other failure
 * is the answer.
 */
const ILLEGAL_RETURN = /Illegal return statement/;

/**
 * The source as the body of an async function. Joined from pieces, not written as one template
 * string: the build minifies every multi-line string that parses as a script and puts
 * parentheses around what fills its `${…}` (scripts/build.mjs), which is right for a value and
 * breaks statements — `(return 1)` is a SyntaxError of its own.
 */
const asFunctionBody = (src: string) => ["(async () => {", src, "})()"].join("\n");

/** Code that READS the clipboard — the one page API measured to hang a run: the browser asks
 *  the person for permission, and in a tab nobody is watching nobody answers. */
const READS_CLIPBOARD = /clipboard\s*(\?\.|\.)\s*read(Text)?\b/;

/**
 * For the length of one evaluate, make a clipboard read that WOULD raise a permission prompt
 * reject instead. Only when the permission is still `prompt`: granted reads run, denied ones
 * reject by themselves. Only the read is replaced, so code that merely mentions it is untouched,
 * and {@link CLIPBOARD_UNGUARD_JS} puts the page's own methods back.
 */
const CLIPBOARD_GUARD_JS = `(async () => {
  try {
    const c = navigator.clipboard;
    if (!c || window.__mfClipboardGuard) return "none";
    const state = await navigator.permissions.query({ name: "clipboard-read" }).then((p) => p.state, () => "unknown");
    if (state !== "prompt") return state;
    const refuse = () => Promise.reject(new DOMException(
      "reading the clipboard needs a permission prompt, and nobody is at this tab to answer it, so the read was refused "
      + "instead of left waiting. To check what a button copied, replace navigator.clipboard.writeText with a recorder "
      + "before the click and read what it was handed", "NotAllowedError"));
    c.readText = refuse;
    c.read = refuse;
    window.__mfClipboardGuard = () => { delete c.readText; delete c.read; delete window.__mfClipboardGuard; };
    return "guarded";
  } catch (e) { return "unknown"; }
})()`;
const CLIPBOARD_UNGUARD_JS = "window.__mfClipboardGuard && window.__mfClipboardGuard()";

/**
 * Evaluate in `page` and report the result — or the exception, or the timeout, each as itself.
 *
 * Never throws: a page-side exception IS the answer here (the console would show it too), and a
 * run that stops the whole script on a typo is not a debug channel.
 */
export async function performRunJs(page: () => Page, code: unknown, ms?: unknown, budgetMs?: unknown): Promise<ActResult> {
  const src = typeof code === "string" ? code.trim() : "";
  if (!src) return { ok: false, note: "run_js needs code — the JavaScript to evaluate" };
  const asked = typeof ms === "number" && Number.isFinite(ms)
    ? Math.min(Math.max(Math.trunc(ms), RUN_JS_MIN_MS), RUN_JS_MAX_MS)
    : RUN_JS_TIMEOUT_MS;
  // The wait runs by its own clock, past the call's time cap (checked only before a verb): it
  // takes no more than the call has left, so a long wait late in a call cannot hold it past its
  // budget and the host's timeout.
  const left = typeof budgetMs === "number" && Number.isFinite(budgetMs) ? Math.max(RUN_JS_MIN_MS, Math.trunc(budgetMs)) : Infinity;
  const limit = Math.min(asked, left);
  const timedOut = Symbol("run_js-timeout");
  let timer: NodeJS.Timeout | undefined;
  // A timed-out evaluate keeps running; its late rejection is safe because race attaches a
  // handler to every contender.
  const race = (js: string) => Promise.race([
    page().evaluate(js) as Promise<unknown>,
    new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), limit); }),
  ]);
  // A read that would only raise a prompt is made to answer now (CLIPBOARD_GUARD_JS); the guard
  // itself must never be what fails or delays the run.
  const guarded = READS_CLIPBOARD.test(src)
    && await Promise.race([page().evaluate(CLIPBOARD_GUARD_JS).catch(() => ""), new Promise((r) => setTimeout(() => r(""), 1000))]) === "guarded";
  try {
    let result: unknown;
    try {
      result = await race(src);
    } catch (e) {
      if (!ILLEGAL_RETURN.test((e as Error).message || "")) throw e;
      result = await race(asFunctionBody(src));
    }
    if (result === timedOut) {
      return { ok: false, note: `run_js gave no result within ${limit / 1000}s — `
        + "the code may still be running in the page; observe to see its effect. "
        + (limit < asked
          ? `That was all this call had left of its 60s — run it first thing in a fresh call. `
          : limit < RUN_JS_MAX_MS ? `Code meant to run longer can pass ms (up to ${RUN_JS_MAX_MS / 1000}s). ` : "")
        + "A promise waiting on a permission or a user gesture (navigator.clipboard.readText, Notification.requestPermission, "
        + "geolocation) can wait forever in a tab nobody is looking at, however long ms is — to check what a button "
        + "copied, replace navigator.clipboard.writeText with a recorder before the click and read what it was handed" };
    }
    const json = result === undefined ? "undefined" : JSON.stringify(result) ?? String(result);
    return { ok: true, value: result, note: `result: ${clipResult(json, RESULT_PREVIEW_CHARS)}` };
  } catch (e) {
    return { ok: true, note: `threw: ${clipResult(((e as Error).message || String(e)).split("\n")[0] ?? "")}` };
  } finally {
    if (timer) clearTimeout(timer);
    if (guarded) await page().evaluate(CLIPBOARD_UNGUARD_JS).catch(() => {});
  }
}
