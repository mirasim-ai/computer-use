/**
 * Putting a VALUE into a control — set_text's fallback ladder, select_option, select_text and
 * paste. actions.ts acts on the PAGE; what is here writes into one field and reads it back,
 * because for these verbs the read-back, not the dispatch, is the answer.
 *
 * Pure page-level logic, like actions.ts: no driver state, the caller passes its locate() in.
 */

import type { Locator, Page } from "playwright-core";
import { Type } from "typebox";
import type { ActResult, VerbSpec } from "../types.ts";
import { pageFn } from "./collect.ts";
import { refuseIfGated } from "./actions.ts";

/** A refusal that says the person took over, or that the action never started, ends the verb:
 *  a fallback would only retry what the browser just declined. */
function stopForInputInterruption(error: unknown): void {
  if (/Human input resumed|connection closed while waiting for input|was not started/.test(String(error))) throw error;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * set_text with two fallbacks, for inputs that refuse a plain fill:
 *   1. fill — the fast path for ordinary inputs;
 *   2. click-to-activate, re-locate, fill — inputs readonly (or swapped out) until clicked
 *      (date/search pickers); `relocate` re-runs the caller's full locate;
 *   3. keyboard typing — custom editors that only listen to key events.
 * The note says which level succeeded.
 *
 * - The first fill's rejection reason RIDES the fallback note: it often says exactly what to
 *   fix (a native date input's "Malformed value").
 * - The field is READ BACK after writing: a keyboard fallback can type into nothing.
 *   `verified` carries the verdict to the observation layer so a frozen screen is not blamed
 *   on a write that worked.
 */
export async function setTextWithFallbacks(page: Page, loc: Locator, a: Record<string, any>, relocate: () => Promise<Locator | null>): Promise<ActResult & { verified?: boolean }> {
  const done = (target: Locator, how: string | null) => confirmSetText(target, a.text, how);
  let fillError = "";
  try {
    await loc.fill(a.text, { timeout: 8000 });
    return await done(loc, null);
  } catch (e) {
    stopForInputInterruption(e);
    fillError = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
    // Playwright prefixes "locator.fill: " and appends call-log noise; keep the reason.
    fillError = fillError.replace(/^locator\.fill:?\s*/i, "").slice(0, 140);
  }
  const rejected = fillError ? ` (fill rejected: ${fillError})` : "";
  // Not a FIELD is structural: the fallbacks cannot help, and their click is itself an action
  // on an unknown control (a link navigates away, then "ok" because it has no value to read
  // back). Every widget the fallbacks exist for is a real input refusing fill for another reason.
  if (/is not an? <input>/i.test(fillError)) {
    return { ok: false, note: `set_text did nothing: this element is not a text field (${fillError}). `
      + "Nothing was clicked and nothing was typed. Locate the field itself — find(name, {role: 'textbox'}) — "
      + "and if the handle came from a find() marked incidental, nothing on this surface is named that" };
  }
  try {
    await loc.click({ timeout: 4000 });
    await sleep(350);
    const again = await relocate();
    if (again) {
      await again.fill(a.text, { timeout: 4000 });
      return await done(again, "filled after click-to-activate");
    }
  } catch (error) { stopForInputInterruption(error); }
  try {
    await page.keyboard.type(a.text, { delay: 20 });
    return await done(loc, `typed via keyboard fallback${rejected}`);
  } catch (e) {
    return { ok: false, note: `set_text failed${rejected}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
}

/** Read the field back and say what it holds now — the model's only direct proof the
 * write landed. Unreadable targets (canvas editors) get the plain how-note; never fail
 * a dispatched write over a failed read-back. */
async function confirmSetText(loc: Locator, want: string, how: string | null): Promise<ActResult & { verified?: boolean }> {
  let now: string | null = null;
  try {
    now = await loc.evaluate((el: any) => {
      if (typeof el.value === "string") return el.value;
      if (el.isContentEditable) return el.innerText ?? "";
      return null;
    }, undefined, { timeout: 2000 }) as string | null;
  } catch { /* read-back is best-effort */ }
  if (now === null) return how ? { ok: true, note: how } : { ok: true };
  const cut = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
  if (now === want) {
    const note = `the field now contains «${cut(now)}»`;
    return { ok: true, note: how ? `${how}; ${note}` : note, verified: true };
  }
  const state = now ? `now shows «${cut(now)}»` : "is still empty";
  const note = `WARNING: the field ${state}, not the text you sent — it did not take; try a different format or element`;
  return { ok: true, note: how ? `${how}; ${note}` : note, verified: false };
}

/**
 * select_option — a native <select> from its own option list (label, then value), anything else
 * by the custom-dropdown road: open the control and click the option by visible name.
 */
/** The select_option verb's schema. Ref-only — a native <select>'s option list is not in the
 * DOM, so there is no coordinate to aim at. Ref fields are spelled out here because the tool layer is downstream
 * of every driver. */
export const SELECT_OPTION_VERB: VerbSpec = {
  kind: "select_option",
  schema: Type.Object({
    kind: Type.Literal("select_option"),
    ref: Type.String({ description: "Element ref from the latest observe() (e.g. e12)" }),
    name: Type.Optional(Type.String({ description: "Visible name of the element — identity check + fallback locator" })),
    option: Type.String({ description: "Option label or value. Native <select> must use this, not click/fill." }),
  }),
};

/**
 * paste — hand content to the page the way a person's ⌘V does, WITHOUT going near the user's
 * clipboard.
 *
 * Unlike `set_text`, a rich editor gets `text/html` and renders it formatted, and the insertion
 * happens AT THE CARET over any selection — so `select_text` then `paste` replaces one phrase.
 *
 * The clipboard is deliberately untouched (the event carries its own DataTransfer): overwriting
 * it destroys something an agent cannot restore. Not covered: a page that reads
 * `navigator.clipboard` from its own button — the note says so.
 */
export const PASTE_VERB: VerbSpec = {
  kind: "paste",
  schema: Type.Object({
    kind: Type.Literal("paste"),
    text: Type.String({ description: "The content as plain text (Markdown goes here too — editors that understand it read this)" }),
    html: Type.Optional(Type.String({ description: "The same content as HTML, for editors that accept rich text; they take this and everything else falls back to text" })),
    ref: Type.Optional(Type.String({ description: "Paste into this element. Omit to paste at the page's current caret — where select_text left it." })),
    name: Type.Optional(Type.String({ description: "Visible name of that element — identity check + fallback locator" })),
  }, { description: "Paste content at the caret, over any selection — the way ⌘V does, including rich text via html. Does NOT touch the user's real clipboard." }),
};

/** The page half of paste; page SOURCE for the reasons in {@link SELECT_TEXT_JS}. */
const PASTE_JS = String.raw`(a) => {
  const host = a[0], o = a[1];
  const el = host || document.activeElement;
  if (!el || el === document.body && !o.intoBody) return { noTarget: true };
  if (typeof el.focus === "function") el.focus();
  function readBack(node) {
    if (typeof node.value === "string") return node.value;
    if (node.isContentEditable) return node.innerText || "";
    return null;
  }
  const before = readBack(el);
  const dt = new DataTransfer();
  dt.setData("text/plain", o.text);
  if (o.html) dt.setData("text/html", o.html);
  // A synthetic paste event is untrusted, so the browser runs NO default action for it: an
  // editor that listens gets exactly what it would from ⌘V, and anything else needs the manual
  // insertion below. preventDefault (dispatchEvent returning false) is how the editor says it
  // took the job.
  const ran = el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  if (!ran) return { handled: "the editor's own paste handler", after: readBack(el), before: before };
  // Field: splice at the caret through the PROTOTYPE's setter, which is what a framework's
  // value tracker listens on (setting the instance property leaves React showing the old value).
  if (typeof el.value === "string" && typeof el.setSelectionRange === "function") {
    const start = el.selectionStart == null ? el.value.length : el.selectionStart;
    const end = el.selectionEnd == null ? start : el.selectionEnd;
    const next = el.value.slice(0, start) + o.text + el.value.slice(end);
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    if (desc && desc.set) desc.set.call(el, next); else el.value = next;
    const caret = start + o.text.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { handled: "inserted at the caret", after: readBack(el), before: before, plainOnly: !!o.html };
  }
  // Editable content: the browser's own insert, which respects the current Range.
  //
  // Gated on the TARGET being editable, and that gate is the whole point rather than a tidy-up.
  // execCommand acts on the document's SELECTION, not on this element: measured against a button
  // while a text field elsewhere still held the selection, it returned true and put the content
  // in that field — a paste reported as landing on the named ref while it silently edited
  // something the model never named. Refusing is the only honest answer here.
  if (!el.isContentEditable) return { refused: true, editable: false };
  const ok = document.execCommand(o.html ? "insertHTML" : "insertText", false, o.html || o.text);
  if (!ok) return { refused: true, editable: true };
  return { handled: o.html ? "inserted as HTML" : "inserted at the caret", after: readBack(el), before: before };
}`;

export async function performPaste(
  page: Page,
  a: Record<string, any>,
  locate: () => Promise<Locator | null>,
): Promise<ActResult & { verified?: boolean }> {
  const text = String(a.text ?? "");
  if (!text && !a.html) return { ok: false, note: "paste needs text (and optionally html)" };
  let root: unknown = null;
  if (a.ref) {
    const loc = await locate();
    if (!loc) return { ok: false, note: `no element for ref ${a.ref}` };
    const gated = await refuseIfGated(loc, a.ref, a.name);
    if (gated) return gated;
    root = await loc.elementHandle().catch(() => null);
    if (!root) return { ok: false, note: `${a.ref} is no longer in the page — re-observe` };
  }
  const arg = { text, html: typeof a.html === "string" ? a.html : "" };
  const out: any = await page.evaluate(pageFn(PASTE_JS) as any, [root, arg] as any)
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));

  if (out.error) return { ok: false, note: `paste failed: ${String(out.error).split("\n")[0]}` };
  if (out.noTarget) {
    return { ok: false, note: "nothing is focused to paste into — pass ref for the field or editor, "
      + "or click into it first" };
  }
  if (out.refused) {
    return { ok: false, note: out.editable
      ? "the editor refused the insert — click into it, then paste again"
      : "this element is not editable, so there is nowhere for the content to land — pass ref for a field or an editor" };
  }
  // No read-back is not failure (a canvas editor has no value); a dropped paste must never be
  // claimed as landed.
  const after: string | null = out.after ?? null;
  const landed = after === null ? undefined : after !== (out.before ?? null) && after.includes(text.slice(0, 40));
  const how = String(out.handled ?? "pasted");
  const richNote = out.plainOnly ? " (this field takes plain text only, so the html was not used)" : "";
  if (landed === false) {
    return { ok: true, verified: false, note: `WARNING: ${how}, but the content is not in the field afterwards — `
      + "the page may have rejected or reformatted it; read it back before relying on it" };
  }
  return {
    ok: true,
    ...(landed === true ? { verified: true } : {}),
    note: `${how}${richNote}. The user's own clipboard was not touched — if the page pastes from `
      + "its own button instead, this content will not be there",
  };
}

/** A native <select>'s own options and whether the control takes input, read in ONE evaluate —
 *  null for anything that is not a <select>. What makes a miss cost a read instead of a timeout. */
const SELECT_OPTIONS_JS = `(el) => {
  if (!el || el.tagName !== "SELECT") return null;
  return {
    disabled: !!el.disabled,
    options: Array.from(el.options).map((o) => ({
      label: (o.label || o.text || "").replace(/\\s+/g, " ").trim(),
      value: o.value,
      disabled: o.disabled || (o.parentElement && o.parentElement.tagName === "OPTGROUP" && o.parentElement.disabled) || false,
    })),
  };
}`;

/** How many option names a refusal lists before it counts the rest. */
const LISTED_OPTIONS = 12;
const listed = (names: string[]) =>
  names.slice(0, LISTED_OPTIONS).map((n) => `"${n.slice(0, 40)}"`).join(", ")
  + (names.length > LISTED_OPTIONS ? `, +${names.length - LISTED_OPTIONS} more` : "");

/**
 * Pick an option. A native <select> is answered from its OWN option list: the pick, or a refusal
 * naming what it does offer — never a wait for an option that is not there. Playwright's
 * selectOption waits its whole timeout for a missing label, and the old ladder paid that three
 * times over (by label, by value, open-and-click: about 20 s for one wrong name, measured).
 * Anything else is a custom dropdown: open it, then click the option by visible name.
 */
export async function performSelectOption(
  page: Page,
  a: Record<string, any>,
  locate: () => Promise<Locator | null>,
): Promise<ActResult> {
  const loc = await locate();
  if (!loc) return { ok: false, note: `no select for ref ${a.ref}` };
  const want = String(a.option ?? "");
  const native = await loc.evaluate(pageFn(SELECT_OPTIONS_JS) as any).catch(() => null) as
    { disabled: boolean; options: Array<{ label: string; value: string; disabled: boolean }> } | null;
  if (native) {
    const norm = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();
    const opts = native.options;
    // The label as written, then the value, then either with case and spacing set aside.
    let at = opts.findIndex((o) => o.label === want.trim());
    if (at < 0) at = opts.findIndex((o) => o.value === want);
    if (at < 0) at = opts.findIndex((o) => norm(o.label) === norm(want));
    if (at < 0) at = opts.findIndex((o) => norm(o.value) === norm(want));
    const enabled = opts.filter((o) => !o.disabled).map((o) => o.label || o.value);
    if (at < 0) {
      return { ok: false, note: `"${want}" is not one of this select's options, by label or by value — nothing was selected. `
        + (opts.length ? `It offers: ${listed(opts.map((o) => (o.label || o.value) + (o.disabled ? " (disabled)" : "")))}` : "It has no options at all right now") };
    }
    if (native.disabled) return { ok: false, note: "this select is disabled, so no option can be picked — nothing was selected" };
    if (opts[at]!.disabled) {
      return { ok: false, note: `the option "${opts[at]!.label || opts[at]!.value}" is disabled, so it cannot be picked — nothing was selected. `
        + (enabled.length ? `The enabled options are: ${listed(enabled)}` : "No option of this select is enabled") };
    }
    try {
      await loc.selectOption({ index: at }, { timeout: 8000 });
      return { ok: true };
    } catch (error) {
      stopForInputInterruption(error);
      return { ok: false, note: `could not select "${want}": ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}` };
    }
  }
  // Custom (non-<select>) dropdowns: open it, then click the option by visible name. Only what
  // is DRAWN counts: every native <select> on the page keeps its <option>s in the role tree too.
  const options = page.getByRole("option");
  const named = page.getByRole("option", { name: want, exact: false });
  const drawn = (l: Locator) => l.evaluateAll((els: any[]) => els.map((el) =>
    el.tagName === "OPTION" || !el.getClientRects().length ? null : String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
  )).catch(() => [] as Array<string | null>);
  const firstDrawn = async (l: Locator) => (await drawn(l)).findIndex((t) => t !== null);
  try {
    await loc.click({ timeout: 4000 });
    await sleep(400);
    // Options already showing without the wanted one is an answer; none showing yet may be a
    // list still loading, so the named option gets a short wait before the miss is called.
    let at = await firstDrawn(named);
    for (const until = Date.now() + 2000; at < 0 && Date.now() < until && (await firstDrawn(options)) < 0;) {
      await sleep(200);
      at = await firstDrawn(named);
    }
    if (at < 0) {
      const names = (await drawn(options)).filter((t): t is string => !!t);
      return { ok: false, note: `could not select "${want}": this control is not a <select>, and clicking it `
        + (names.length
          ? `revealed no option with that name — the options showing are: ${listed(names)}. The list is still open`
          : "revealed no options at all — it may not be a dropdown, or its list is not made of options; observe to see what the click did") };
    }
    await named.nth(at).click({ timeout: 4000 });
    return { ok: true, note: "selected via open-and-click (custom dropdown)" };
  } catch (e) {
    stopForInputInterruption(e);
    return {
      ok: false,
      note: `could not select "${want}": this control is not a <select>, and opening it to click the option failed — `
        + `${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`,
    };
  }
}
