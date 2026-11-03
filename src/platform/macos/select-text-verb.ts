/**
 * `select_text` — selecting part of ONE field's value, or placing the caret in it, so `keys` edits
 * exactly that where `set_text` always replaces the whole field. Reads the value back, finds the
 * occurrence the caller meant (`near` picks between several), and sets `AXSelectedTextRange`.
 */

import { Type } from "typebox";
import type { ActResult, VerbSpec } from "../types.ts";
import { AxRequestError } from "./ax-client.ts";
import type { ElementActs } from "./act-element.ts";

/**
 * select_text's schema. Unlike the browser's, `ref` is REQUIRED: a selection here is an attribute
 * OF a text control (AXSelectedTextRange), so there is no page-wide text to search.
 */
export const SELECT_TEXT_VERB: VerbSpec = {
  kind: "select_text",
  schema: Type.Object({
    kind: Type.Literal("select_text"),
    ref: Type.String({ description: "The text field or text area to select inside (from the latest observe())" }),
    name: Type.Optional(Type.String({ description: "Visible name of that element — identity check + fallback locator" })),
    // OPTIONAL, unlike the browser's: `caret` alone is this platform's way to focus a field for
    // keys, empty field included. The repl validates against this schema (tools/validate.ts).
    text: Type.Optional(Type.String({ description: "The exact text to select (copy it verbatim from what you read); omit it to place the caret at the start / end of the field with caret alone" })),
    near: Type.Optional(Type.String({ description: "Nearby text that tells one occurrence from another; the match closest to it wins" })),
    caret: Type.Optional(Type.Union(
      [Type.Literal("select"), Type.Literal("before"), Type.Literal("after")],
      { description: "select (default) leaves it selected — keys then replaces it; before / after place the caret there instead" },
    )),
  }, { description: "Select part of a text field's value, or place the caret in it, so keys edits exactly that — set_text always replaces the whole field." }),
};

/**
 * Distance between two SPANS, not between their start offsets — how `near` picks an occurrence.
 * Comparing starts favours a match BEFORE a long anchor, whose start sits far from the text it
 * names. Zero when they overlap.
 */
function gapBetween(hitAt: number, hitLen: number, anchorAt: number, anchorLen: number): number {
  return Math.max(0, anchorAt - (hitAt + hitLen), hitAt - (anchorAt + anchorLen));
}

/**
 * `select_text` — put the field's selection, or its caret, on a stretch of its own value; the only
 * partial write this platform has. The value is read from the app (the walk carries only a capped
 * PREVIEW), and the occurrence is picked by `near`, never by an index the model would have to count.
 */
export async function selectTextVerb(acts: ElementActs, ref: unknown, name: unknown, o: { want: string; near: string; caret: string }): Promise<ActResult> {
  const k = acts.resolve(ref, name);
  if (!("key" in k)) return k;
  const what = acts.what(k, ref);
  if (!o.want) {
    if (o.caret === "select") return { ok: false, note: "select_text needs the text to select, or caret:'before' / caret:'after' alone to place the caret at the start / end of the field" };
    // Placing the caret in an EMPTY field is the way to focus it for keys, so no value is required.
    let whole = "";
    try { whole = String((await acts.call<{ value: string }>("value", { key: k.key })).value ?? ""); }
    catch (e) { if (e instanceof AxRequestError && e.code === "stale_key") return acts.staleRef(ref); }
    const start = o.caret === "after" ? whole.length : 0;
    try { await acts.call("selectrange", { key: k.key, start, length: 0 }); }
    catch (e) {
      if (e instanceof AxRequestError && e.code === "stale_key") return acts.staleRef(ref);
      if (e instanceof AxRequestError && e.code === "ax_error") return { ok: false, note: `${what} will not take a caret (AXError ${e.ax ?? "?"}) — click it to focus it instead` };
      throw e;
    }
    return { ok: true, note: `caret placed at the ${o.caret === "after" ? "end" : "start"} of ${what} — keys and type go there now` };
  }
  let value: string;
  try {
    value = String((await acts.call<{ value: string }>("value", { key: k.key })).value ?? "");
  } catch (e) {
    if (e instanceof AxRequestError && e.code === "stale_key") return acts.staleRef(ref);
    value = "";
  }
  // No value at all is a different answer from "your text is not in it", which would have the
  // model retry at a button forever. AX gives both shapes (an error, an empty string).
  if (!value) {
    return { ok: false, note: `${what} has no readable text value — select_text works on text `
      + "fields and text areas; act on one of those, or use click" };
  }
  const hits: number[] = [];
  let at = value.indexOf(o.want);
  while (at !== -1) { hits.push(at); at = value.indexOf(o.want, at + 1); }
  if (!hits.length) {
    return { ok: false, note: `"${o.want}" is not in ${what} — read it with text() `
      + "and copy it exactly, whitespace included" };
  }
  let pick = hits[0]!, index = 0;
  if (o.near) {
    const anchor = value.indexOf(o.near);
    if (anchor === -1) {
      return { ok: false, note: `"${o.near}" is not in ${what}, so it cannot pick between the `
        + `${hits.length} matches for "${o.want}" — drop near, or give text that really sits beside the one you mean` };
    }
    let best = Infinity;
    for (const [i, h] of hits.entries()) {
      const d = gapBetween(h, o.want.length, anchor, o.near.length);
      if (d < best) { best = d; pick = h; index = i; }
    }
  }
  const start = o.caret === "after" ? pick + o.want.length : pick;
  const length = o.caret === "select" ? o.want.length : 0;
  try {
    await acts.call("selectrange", { key: k.key, start, length });
  } catch (e) {
    if (e instanceof AxRequestError && e.code === "stale_key") return acts.staleRef(ref);
    if (e instanceof AxRequestError && e.code === "ax_error") {
      return { ok: false, note: `${what} will not take a selection (AXError ${e.ax ?? "?"}) — the app does not expose `
        + "one for this control; set_text replaces its whole value instead" };
    }
    throw e;
  }
  const of = hits.length > 1 ? ` (match ${index + 1} of ${hits.length}${o.near ? `, the one nearest "${o.near}"` : ", the first"})` : "";
  return o.caret === "select"
    ? { ok: true, note: `selected "${o.want}" in ${what}${of} — keys now replaces exactly this (set_text still replaces the whole field)` }
    : { ok: true, note: `caret placed ${o.caret} "${o.want}" in ${what}${of} — keys now types there (set_text still replaces the whole field)` };
}
