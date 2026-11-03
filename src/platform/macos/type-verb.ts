/**
 * `type` — real keystrokes at the app's keyboard focus, through the helper's `type` op
 * (`CGEventPostToPid`, one event pair per character; ax-input.swift `typeText`).
 *
 * For fields AXSetValue does not reach: Finder's name cell mid-rename (reads the new name back and
 * renames nothing) and SwiftUI search fields (value lands, nothing filters). Used after the field
 * has been focused. Background delivery establishes a protected key window; apps may still reject
 * or reformat input, so the field is read back. Remote panel input keeps its owning-process route.
 */

import { Type } from "typebox";
import type { ActResult, VerbSpec } from "../types.ts";
import type { AxCall } from "./act-element.ts";

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

export async function typeVerb(
  call: AxCall, pid: number, appName: string, text: string, lastKeyAt = 0,
): Promise<ActResult> {
  if (!text) return { ok: false, note: "type needs text" };
  const since = lastKeyAt ? Math.max(0, Date.now() - lastKeyAt) : Number.POSITIVE_INFINITY;
  const waited = since < TYPE_AFTER_KEY_MS ? Math.ceil(TYPE_AFTER_KEY_MS - since) : 0;
  if (waited) await new Promise((r) => setTimeout(r, waited));
  const receipt = await call<TypeReceipt>("type", { pid, text });
  const verification = await readsBackAsTyped(call, text, receipt ?? {});
  return {
    ok: true,
    ...verification,
    note: `posted ${receipt?.postedCount ?? text.length} characters at ${appName}'s keyboard focus with key events`
      + (waited ? `, after ${waited} ms for the key before it to finish moving the focus — a field that commits on Enter hands it on asynchronously, and a character posted into that gap is lost with no error` : "")
      + `; ${verification.note}`,
  };
}
