/**
 * `type` — real keystrokes at the app's keyboard focus, through the helper's `type` op
 * (`CGEventPostToPid`, one event pair per character; ax-input.swift `typeText`).
 *
 * For fields AXSetValue does not reach: Finder's name cell mid-rename (reads the new name back and
 * renames nothing) and SwiftUI search fields (value lands, nothing filters). Used after the field
 * has been focused. Background delivery establishes a protected key window; apps may still reject
 * or reformat input, so the field is read back. Remote panel input keeps its owning-process route.
 */

import { cutText } from "../text-cut.ts";
import { Type } from "typebox";
import type { ActResult, VerbSpec } from "../types.ts";
import type { AxCall } from "./act-element.ts";
import { AxRequestError } from "./ax-errors.ts";

export const TYPE_VERB: VerbSpec = {
  kind: "type",
  schema: Type.Object({
    kind: Type.Literal("type"),
    text: Type.String({ description: "Text to type, character by character" }),
  }, { description: "Type text with key events at the app's keyboard focus — for a field that takes typed input only (a file being renamed, a search field that filters as you type). set_text fills a field by ref; type is for where that does not stick. Focus the field first (click, or select_text with caret)." }),
};

/**
 * How long a key posted just before this one is given to finish moving the focus.
 *
 * A field that commits on Enter hands its focus on asynchronously: typing at once after
 * `keys('Enter')` silently loses the FIRST character (Excel: "Q2" arrives as "2"). The boundary
 * measured near 200 ms. Charged only inside that window: an observation between a key and a type
 * already costs more than this.
 */
export const TYPE_AFTER_KEY_MS = 250;

/**
 * Characters posted per helper request when the text goes in parts. The helper posts one character
 * about every 5 ms (measured: 1000 in 4.6 s), and on the foreground route nothing bounds a request
 * from inside — while a request that outlasts 15 s gets the helper stopped (ax-client.ts),
 * mid-text, and with it every ref of the session: about 3300 characters as one request. In parts,
 * a long text is several requests of under five seconds each.
 */
export const TYPE_PART = 1000;

/** `text` in parts of `size` user-perceived characters, as the helper counts them: a boundary
 *  inside one (a surrogate pair, a letter and its combining mark) would post it as two keys. */
function inPartsOf(text: string, size: number): string[] {
  const out: string[] = [];
  let part = "";
  let count = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    part += segment;
    count += 1;
    if (count === size) { out.push(part); part = ""; count = 0; }
  }
  if (part) out.push(part);
  return out;
}

interface TypeReceipt {
  postedCount?: number;
  typedKey?: string;
  typedValue?: string;
  /** AX ranges and JavaScript string offsets both count UTF-16 code units. */
  typedRange?: { start: number; length: number };
}

/** The native helper captures this AFTER establishing the key window, immediately before input.
 * Never infer a caret from the old value or fall back to whichever field is focused afterwards.
 * Read-back is evidence about content, not a delivery guarantee (apps may transform input). */
async function readsBackAsTyped(
  call: AxCall, text: string, receipt: TypeReceipt,
): Promise<{ note: string; verified?: boolean }> {
  const { typedKey, typedValue, typedRange } = receipt;
  if (!typedKey || typeof typedValue !== "string" || !typedRange) {
    return { note: "unverified — the target field, original text or selection could not be read before input" };
  }
  const { start, length } = typedRange;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0
    || start > typedValue.length || length > typedValue.length - start) {
    return { note: "unverified — the original selection was outside the readable text" };
  }
  const expected = typedValue.slice(0, start) + text + typedValue.slice(start + length);
  try {
    // Give delayed edits and automatic corrections a bounded settling window. Always read the
    // captured element, including after background cleanup restores another document's focus.
    const deadline = Date.now() + 200;
    for (;;) {
      // Unlike the display-oriented `value` op, unreadable/non-text values stay null.
      const { value } = await call<{ value: unknown }>("textvalue", { key: typedKey });
      if (typeof value !== "string") break;
      if (Date.now() >= deadline) {
        // An EMPTY Chromium/Electron field reports its placeholder as its value ("Work with
        // Codex\n" in ChatGPT's composer), so the "original text" was never there: the field now
        // holding exactly the typed text, with that text gone, is the edit that was asked for.
        if (value !== expected && value === text && typedValue.trim() && !value.includes(typedValue.trim())) {
          return { verified: true, note: `matched — the field reads back exactly the typed text; what it read before input `
            + `(${JSON.stringify(cutText(typedValue.trim(), 40))}) was an empty field's placeholder, which some web fields report as their value` };
        }
        if (value === expected && expected === typedValue) {
          return { note: "unverified — the expected text was already present before input, so read-back cannot establish whether the keys took effect" };
        }
        return { verified: value === expected, note: value === expected
          ? "matched — the same field reads back exactly the expected text after inserting or replacing the original selection"
          : "content differs — the same field does not read back the expected text; automatic correction or formatting may change it. This does not establish where the keys landed; inspect it with text() before editing further, and do not automatically replay the input" };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    }
  } catch {
    // A stale/missing field or helper read failure says nothing about where the keys landed.
  }
  return { note: "unverified — the original target field could not be read after input; inspect it before editing further, and do not automatically replay the input" };
}

/**
 * `inParts`: send a long text as several requests ({@link TYPE_PART}). For the foreground route
 * only — background typing sets up and takes down its protected key window around every request
 * and stops itself at its own 10 s budget, saying how far it got.
 */
export async function typeVerb(
  call: AxCall, pid: number, appName: string, text: string, lastKeyAt = 0, inParts = false,
): Promise<ActResult> {
  if (!text) return { ok: false, note: "type needs text" };
  const since = lastKeyAt ? Math.max(0, Date.now() - lastKeyAt) : Number.POSITIVE_INFINITY;
  const waited = since < TYPE_AFTER_KEY_MS ? Math.ceil(TYPE_AFTER_KEY_MS - since) : 0;
  if (waited) await new Promise((r) => setTimeout(r, waited));
  const parts = inParts ? inPartsOf(text, TYPE_PART) : [text];
  // The field as it was before the FIRST character: what the read-back is compared against.
  let receipt: TypeReceipt | undefined;
  let posted = 0;
  for (const [i, part] of parts.entries()) {
    let answer: TypeReceipt | undefined;
    try {
      answer = await call<TypeReceipt>("type", { pid, text: part });
    } catch (e) {
      if (parts.length === 1 || !(e instanceof AxRequestError)) throw e;
      // The helper counted within its own part; the caller asked for the whole text.
      const requested = (parts.length - 1) * TYPE_PART + inPartsOf(parts[parts.length - 1]!, 1).length;
      const sofar = posted + (e.postedCount ?? 0);
      const own = /^\d+ of \d+ characters were posted before interruption\. /;
      throw new AxRequestError(e.code, own.test(e.message)
        ? e.message.replace(own, `${sofar} of ${requested} characters were posted before interruption. `)
        : `at least ${sofar} of ${requested} characters were posted before this. ${e.message}`,
        e.ax, sofar, requested, e.capture);
    }
    if (i === 0) receipt = answer;
    posted += answer?.postedCount ?? part.length;
  }
  const verification = await readsBackAsTyped(call, text, receipt ?? {});
  return {
    ok: true,
    ...verification,
    note: `posted ${posted} characters at ${appName}'s keyboard focus with key events`
      + (waited ? `, after ${waited} ms for the key before it to finish moving the focus — a field that commits on Enter hands it on asynchronously, and a character posted into that gap is lost with no error` : "")
      + `; ${verification.note}`,
  };
}
