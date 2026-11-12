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

import { Script } from "node:vm";
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
  "JavaScript evaluated in the page, like typing into the DevTools console — an expression, several statements "
  + "(the value is the last expression's), or a function body using `return`; any of them may use `await`. "
  + "An expression returning a Promise "
  + "is awaited. Only a JSON-safe value comes back — a string, number, array or plain object; a DOM node, a "
  + "function or a circular structure does not survive, so map what you want out of it in the expression. "
  + "READ, COMPUTE, DIAGNOSE with it: a whole table or list in one call, localStorage, the scroll position, a "
  + "page variable, an API the page already exposes. To ACT — click, type, select — use the interaction verbs: "
  + "element.click() from here skips the visibility and real-input checks and leaves no record that the page "
  + "was changed. If you do change state with it, say so in your report.";

/**
 * A top-level `return` or `await` is a SyntaxError for a script, but `computer_repl`'s own `code`
 * is an async function body and the model writes both in one call. Such a source is run inside
 * an async function from the start ({@link needsAsyncFunction}); this is the backstop for one
 * the page refuses all the same (its engine is not the one that compiled it here): on either
 * error the source is re-run wrapped. Safe: a SyntaxError means the page ran NOTHING. Narrow on
 * purpose — any other failure is the answer.
 */
const NEEDS_ASYNC_FUNCTION = /Illegal return statement|await is only valid in async functions/;

/**
 * The source as the body of an async function. Joined from pieces, not written as one template
 * string: the build minifies every multi-line string that parses as a script and puts
 * parentheses around what fills its `${…}` (scripts/build.mjs), which is right for a value and
 * breaks statements — `(return 1)` is a SyntaxError of its own.
 */
const asFunctionBody = (src: string) => ["(async () => {", src, "})()"].join("\n");

/** The source as the one expression an async function returns: `await fetch(u).then((r) => r.json())`
 *  has no `return` to hand its value back with, and as a body it would answer undefined. */
const asAsyncExpression = (src: string) => ["(async () => (", src, "))()"].join("\n");

/** Does `js` parse? Compiled here, by the same engine the page has, and never run: which
 *  wrapping fits is decided without evaluating anything a second time in the page. */
function parses(js: string): boolean {
  try {
    new Script(js);
    return true;
  } catch {
    return false;
  }
}

/** A line that starts like this continues the expression on the line before it (`f\n(3)` calls
 *  f), so the line break before it ends no statement. */
const CONTINUES_LINE = /^(?:[([`+\-*/%.,<>=&|^?:]|!=)/;

/** How many cuts {@link asBodyReturningLast} tries: each is a compile of the whole source. */
const LAST_EXPRESSION_TRIES = 200;

/**
 * The source as an async function's body that returns its LAST expression — what a script
 * answers with, and so what the same statements answered before an `await` was written into
 * them. Found without a parser: cut at a `;` or a line break, from the end, and take the first
 * cut whose head compiles as a function body and whose tail compiles as an expression. A cut
 * inside a string, a template or a `for (;;)` leaves a head that does not compile. Null when
 * the code does not end in an expression (a declaration, a block, a comment after the last `;`).
 */
function asBodyReturningLast(src: string): string | null {
  let tries = 0;
  for (let i = src.length - 1; i >= 0 && tries < LAST_EXPRESSION_TRIES; i--) {
    const at = src[i];
    if (at !== ";" && at !== "\n") continue;
    const head = src.slice(0, i + 1);
    const tail = src.slice(i + 1).trim().replace(/;+$/, "").trim();
    if (!tail || (at === "\n" && CONTINUES_LINE.test(tail))) continue;
    tries++;
    if (!parses(asFunctionBody(head)) || !parses(asAsyncExpression(tail))) continue;
    const js = ["(async () => {", head, "return (", tail, ");", "})()"].join("\n");
    if (parses(js)) return js;
  }
  return null;
}

/** Source the page refused as a script, inside an async function: as its returned expression
 *  when it is one, else as a body that returns its last expression, else as its body. */
function inAsyncFunction(src: string): string {
  if (parses(asAsyncExpression(src))) return asAsyncExpression(src);
  return asBodyReturningLast(src) ?? asFunctionBody(src);
}

/** The source as a class static block: the one place a script's statements compile with `await`
 *  and `return` both refused at their top level and both left alone inside nested functions. */
const asStaticBlock = (src: string) => ["(class { static {", src, "} })"].join("\n");

/**
 * Does the source use `await` or `return` at its top level — outside every function of its own?
 * Asked before anything runs, because the page's answer comes too late for one of them: a script
 * reads `await (x)` and `await [x]` as a call and an index on a variable NAMED await, so it runs
 * every statement before that one and only then throws "await is not defined". Compiled here,
 * never run. False for code that does not compile wrapped either: the page says what is wrong.
 */
function needsAsyncFunction(src: string): boolean {
  return !parses(asStaticBlock(src)) && parses(inAsyncFunction(src));
}

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
    let wrapped = needsAsyncFunction(src) ? inAsyncFunction(src) : "";
    try {
      result = await race(wrapped || src);
    } catch (e) {
      if (wrapped || !NEEDS_ASYNC_FUNCTION.test((e as Error).message || "")) throw e;
      wrapped = inAsyncFunction(src);
      result = await race(wrapped);
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
    // Run as a plain function body: no last expression was found to return for it.
    const noValue = result === undefined && wrapped !== "" && wrapped === asFunctionBody(src)
      ? " — this code does not end in an expression, so it has no value; end it with `return <value>` if you wanted one" : "";
    return { ok: true, value: result, note: `result: ${clipResult(json, RESULT_PREVIEW_CHARS)}${noValue}` };
  } catch (e) {
    return { ok: true, note: `threw: ${clipResult(((e as Error).message || String(e)).split("\n")[0] ?? "")}` };
  } finally {
    if (timer) clearTimeout(timer);
    if (guarded) await page().evaluate(CLIPBOARD_UNGUARD_JS).catch(() => {});
  }
}
