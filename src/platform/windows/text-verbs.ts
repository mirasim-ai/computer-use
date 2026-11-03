/**
 * Partial edits on Windows: `select_text` (selection or caret on a stretch of a field's own text)
 * and `paste` (through the clipboard, at the window's keyboard focus). `set_text` replaces a whole
 * field; these are how one word of a document changes without re-sending the rest.
 *
 * The occurrence is picked the way macOS picks it (macos/select-text-verb.ts): from the value read
 * back now, by `near` — the text beside the one meant — never by an index. Windows editors hold
 * CRLF while the model reads LF, so the search runs on the LF form and maps back to the field's own
 * UTF-16 offsets, which is what the helper selects by and verifies against.
 */

import type { ActResult } from "../types.ts";
import type { RefTarget } from "./elements.ts";
import { parseDateTime } from "./dates.ts";
import { UiaRequestError } from "./uia-client.ts";

export interface TextHost {
  target(ref: unknown): RefTarget;
  call<T>(op: string, params?: Record<string, unknown>): Promise<T>;
  hwnd(): number;
}

const VERIFY_MS = 2500;

/** LF form of a CRLF/CR text, and for each LF-form index the raw index it came from (one past the end included). */
function lfMap(raw: string): { lf: string; at: number[] } {
  let lf = "";
  const at: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    at.push(i);
    if (raw[i] === "\r") {
      lf += "\n";
      if (raw[i + 1] === "\n") i++;
    } else lf += raw[i];
  }
  at.push(raw.length);
  return { lf, at };
}

/** Distance between two spans, zero when they overlap (macos/select-text-verb.ts `gapBetween`). */
function gap(hitAt: number, hitLen: number, anchorAt: number, anchorLen: number): number {
  return Math.max(0, anchorAt - (hitAt + hitLen), hitAt - (anchorAt + anchorLen));
}

const what = (t: RefTarget) => `${t.type.toLowerCase()} "${t.name}"`;

export async function selectText(host: TextHost, a: Record<string, any>): Promise<ActResult> {
  const t = host.target(a.ref);
  const caret = String(a.caret ?? "select");
  if (!["select", "before", "after"].includes(caret)) return { ok: false, note: "caret is select, before or after" };
  // A button's "value" is its label; selecting in it is meaningless and would match the label.
  if (!(t.type === "Edit" || t.type === "Document" || t.actions.includes("text"))) {
    return { ok: false, note: `${what(t)} is not a text field — select_text works on text fields and documents; click a control instead` };
  }
  let raw: string;
  try { raw = String((await host.call<{ value: string }>("value", { key: t.key })).value ?? ""); }
  catch (e) {
    if (e instanceof UiaRequestError) return { ok: false, note: `${what(t)} cannot be read (${e.message}), so nothing in it can be selected` };
    throw e;
  }
  const { lf, at } = lfMap(raw);
  const want = String(a.text ?? "").replace(/\r\n?/g, "\n");
  let from: number, to: number, of = "";
  if (!want) {
    if (caret === "select") return { ok: false, note: "select_text needs the text to select, or caret:'before' / caret:'after' alone to put the caret at the start / end of the field" };
    from = to = caret === "after" ? lf.length : 0;
  } else {
    const hits: number[] = [];
    for (let i = lf.indexOf(want); i !== -1; i = lf.indexOf(want, i + 1)) hits.push(i);
    if (!hits.length) return { ok: false, note: `"${want}" is not in ${what(t)} — read it with text() and copy it exactly, whitespace included` };
    let pick = hits[0]!, index = 0;
    const near = String(a.near ?? "").replace(/\r\n?/g, "\n");
    if (near) {
      const anchor = lf.indexOf(near);
      if (anchor === -1) {
        return { ok: false, note: `"${near}" is not in ${what(t)}, so it cannot pick between the ${hits.length} matches for "${want}" — drop near, or give text that really sits beside the one you mean` };
      }
      let best = Infinity;
      for (const [i, hAt] of hits.entries()) {
        const d = gap(hAt, want.length, anchor, near.length);
        if (d < best) { best = d; pick = hAt; index = i; }
      }
    }
    if (hits.length > 1) of = ` (match ${index + 1} of ${hits.length}${near ? `, the one nearest "${near}"` : ", the first"})`;
    from = caret === "after" ? pick + want.length : pick;
    to = caret === "select" ? pick + want.length : from;
  }
  const start = at[from]!, end = at[to]!;
  try {
    await host.call("selectrange", { key: t.key, start, length: end - start, want: raw.slice(start, end), prefix: raw.slice(0, start) });
  } catch (e) {
    if (e instanceof UiaRequestError && (e.code === "no_selection" || e.code === "stale_key")) {
      return { ok: false, note: `${e.message}${e.code === "no_selection" ? " — setText replaces the whole field instead" : ""}` };
    }
    if (e instanceof UiaRequestError && e.code === "unknown_op") return { ok: false, note: "this Windows native helper predates select_text; update @mirasim/computer-use, or the app that bundles it" };
    throw e;
  }
  if (!want) return { ok: true, note: `caret at the ${caret === "after" ? "end" : "start"} of ${what(t)}, which has the keyboard focus — keys and type go there now` };
  return caret === "select"
    ? { ok: true, note: `selected "${want}" in ${what(t)}${of}, read back from the field — keys, type or paste now replace exactly this (setText still replaces the whole field)` }
    : { ok: true, note: `caret placed ${caret} "${want}" in ${what(t)}${of} — keys, type or paste now insert there` };
}

/**
 * set_text on a Win32 date/time picker: typed field by field the way a person would (helper
 * `datetime.rs`), because writing the value directly changes what it shows without telling the
 * app. Verified by reading the picker's date back.
 */
export async function setDate(host: TextHost, t: RefTarget, text: string): Promise<ActResult> {
  const want = parseDateTime(text);
  if (!want) {
    return { ok: false, note: `"${text}" is not a date or time this picker can take — give the date as 2026-03-09, the time as 14:30, or both ("2026-03-09 14:30"). Nothing was typed` };
  }
  let r: { verified: boolean; iso: string; shown: string };
  try { r = await host.call("setdate", { key: t.key, want }); }
  catch (e) {
    if (!(e instanceof UiaRequestError)) throw e;
    if (e.code === "unknown_op") return { ok: false, note: "this Windows native helper predates date pickers; update the full desktop app. Nothing was typed" };
    return { ok: false, mayHaveActed: e.code !== "date_unreadable", note: e.message };
  }
  return r.verified
    ? { ok: true, verified: true, note: `${what(t)} now reads ${r.shown} (${r.iso}) — typed field by field the way a person would, so the app saw each step` }
    : { ok: true, verified: false, note: `${what(t)} reads ${r.shown} (${r.iso}) after typing, not what was asked — do not retype blindly; observe it` };
}

export async function paste(host: TextHost, a: Record<string, any>): Promise<ActResult> {
  const text = String(a.text ?? "");
  if (!text) return { ok: false, note: "paste needs text (and optionally html for apps that take rich text)" };
  const key = typeof a.ref === "string" ? host.target(a.ref).key : undefined;
  let r: { note: string; verified: boolean | null; restored: boolean };
  try {
    r = await host.call("paste", { hwnd: host.hwnd(), text, ...(typeof a.html === "string" && a.html ? { html: a.html } : {}), ...(key ? { key } : {}), verifyMs: VERIFY_MS });
  } catch (e) {
    if (!(e instanceof UiaRequestError)) throw e;
    if (["wrong_focus", "clipboard_busy", "clipboard_large", "stale_key"].includes(e.code)) return { ok: false, note: e.message };
    if (e.code === "unknown_op") return { ok: false, note: "this Windows native helper predates paste; update @mirasim/computer-use, or the app that bundles it. Nothing was put on the clipboard" };
    throw e;
  }
  return { ok: true, note: r.note, ...(typeof r.verified === "boolean" ? { verified: r.verified } : {}), journal: { restored: r.restored } };
}
