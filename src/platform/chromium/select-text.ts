/**
 * `select_text` on a Chromium page: selecting part of ONE field's value, or placing the caret in
 * it, so `paste` or `keys` edits there while `setText(ref, text)` replaces the whole field.
 *
 * It reads the value back, finds the occurrence the caller meant (`near` picks between several),
 * and turns that into a real selection in the page.
 */

import type { Locator, Page } from "playwright-core";
import { Type } from "typebox";
import type { ActResult, VerbSpec } from "../types.ts";
import { pageFn } from "./collect.ts";


/**
 * select_text — put the SELECTION (or the caret) on a piece of text the model can name.
 *
 * `setText(ref, text)` deliberately fills the whole field; a selection must never be
 * advertised as changing that contract.
 *
 * `near` is surrounding TEXT rather than an occurrence number: the model knows what sits beside
 * the copy it means, while counting occurrences it would get wrong. The closest occurrence wins.
 */
export const SELECT_TEXT_VERB: VerbSpec = {
  kind: "select_text",
  schema: Type.Object({
    kind: Type.Literal("select_text"),
    text: Type.String({ description: "The exact text to select (copy it verbatim from what you read)" }),
    ref: Type.Optional(Type.String({ description: "Search inside this element only — a field, an editor, a section. Omit to search the whole page." })),
    name: Type.Optional(Type.String({ description: "Visible name of that element — identity check + fallback locator" })),
    near: Type.Optional(Type.String({ description: "Nearby text that tells one occurrence from another; the match closest to it wins" })),
    caret: Type.Optional(Type.Union(
      [Type.Literal("select"), Type.Literal("before"), Type.Literal("after")],
      { description: "select (default) leaves it selected — paste replaces it, Delete removes it; before / after place the caret there instead and select nothing" },
    )),
  }, { description: "Select text for paste({text}) to replace, or place the caret before/after it for paste to insert; setText(ref, text) still replaces the whole field." }),
};

/**
 * The page half of select_text, as page SOURCE: the tsconfig carries no DOM lib, and a nested
 * arrow would be rewritten with a `__name` call the page does not have. It handles both shapes
 * a caret can live in — a form field (offsets into `value`) and rendered text (a Range walked
 * across text nodes) — because a model naming a phrase cannot know which it is naming.
 */
const SELECT_TEXT_JS = String.raw`(a) => {
  // Distance between two SPANS, not between their start offsets. Measured live (TextEdit, a
  // second occurrence sitting just after its anchor): comparing starts picked the match BEFORE
  // the anchor, because a long anchor pushes its own start far from the text it names.
  function gapBetween(hitAt, hitLen, anchorAt, anchorLen) {
    const gap = Math.max(anchorAt - (hitAt + hitLen), hitAt - (anchorAt + anchorLen));
    return gap > 0 ? gap : 0;
  }
  const host = a[0], o = a[1];
  const scope = host || document.body;
  const caret = o.caret;
  // A form field: offsets are into value, and the browser owns the selection.
  if (typeof scope.value === "string" && typeof scope.setSelectionRange === "function") {
    const v = scope.value;
    const hits = [];
    let at = v.indexOf(o.want);
    while (at !== -1) { hits.push(at); at = v.indexOf(o.want, at + 1); }
    if (!hits.length) return { found: 0 };
    let pick = hits[0], index = 0;
    if (o.near) {
      const anchor = v.indexOf(o.near);
      if (anchor === -1) return { found: hits.length, nearMissing: true };
      let best = Infinity;
      for (let i = 0; i < hits.length; i++) {
        const d = gapBetween(hits[i], o.want.length, anchor, o.near.length);
        if (d < best) { best = d; pick = hits[i]; index = i; }
      }
    }
    scope.focus();
    const start = caret === "after" ? pick + o.want.length : pick;
    const end = caret === "select" ? pick + o.want.length : start;
    scope.setSelectionRange(start, end);
    return { found: hits.length, index: index, field: true, selected: v.slice(start, end) };
  }
  // Rendered text: one string out of the text nodes, then map the offset back onto a node.
  const nodes = [], starts = [];
  let flat = "";
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    // Script/style text is in the DOM but not on the page; a Range into it selects nothing.
    // A TEXTAREA's child text node is worse than useless: it holds the INITIAL value and stops
    // tracking the moment anyone types, and a Range over it reports a selection while the
    // field's own caret never moved — the model would then type into nowhere. Reaching inside
    // a textarea is what the ref form is for, and it goes down the value branch above.
    const tag = n.parentElement ? n.parentElement.tagName : "";
    if (tag !== "SCRIPT" && tag !== "STYLE" && tag !== "TEXTAREA" && n.data) { nodes.push(n); starts.push(flat.length); flat += n.data; }
    n = walker.nextNode();
  }
  const hits = [];
  let at = flat.indexOf(o.want);
  while (at !== -1) { hits.push(at); at = flat.indexOf(o.want, at + 1); }
  if (!hits.length) return { found: 0 };
  let pick = hits[0], index = 0;
  if (o.near) {
    const anchor = flat.indexOf(o.near);
    if (anchor === -1) return { found: hits.length, nearMissing: true };
    let best = Infinity;
    for (let i = 0; i < hits.length; i++) {
      const d = gapBetween(hits[i], o.want.length, anchor, o.near.length);
      if (d < best) { best = d; pick = hits[i]; index = i; }
    }
  }
  const endAt = pick + o.want.length;
  let sNode = 0, eNode = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (starts[i] <= pick) sNode = i;
    if (starts[i] < endAt) eNode = i;
  }
  const range = document.createRange();
  range.setStart(nodes[sNode], pick - starts[sNode]);
  range.setEnd(nodes[eNode], endAt - starts[eNode]);
  if (caret === "before") range.collapse(true);
  if (caret === "after") range.collapse(false);
  // An editor shows a caret only in the element it has focus in.
  let editor = range.startContainer.parentElement;
  while (editor && !editor.isContentEditable) editor = editor.parentElement;
  if (editor && typeof editor.focus === "function") editor.focus();
  const sel = window.getSelection();
  if (!sel) return { found: hits.length, index: index, noSelection: true };
  sel.removeAllRanges();
  sel.addRange(range);
  return { found: hits.length, index: index, selected: sel.toString(), editable: !!editor };
}`;

export async function performSelectText(
  page: Page,
  a: Record<string, any>,
  locate: () => Promise<Locator | null>,
): Promise<ActResult> {
  const want = String(a.text ?? "");
  if (!want) return { ok: false, note: "select_text needs the text to select" };
  let root: unknown = null;
  if (a.ref) {
    const loc = await locate();
    if (!loc) return { ok: false, note: `no element for ref ${a.ref}` };
    root = await loc.elementHandle().catch(() => null);
    if (!root) return { ok: false, note: `${a.ref} is no longer in the page — re-observe` };
  }
  const arg = { want, near: typeof a.near === "string" ? a.near : "", caret: String(a.caret ?? "select") };
  // The handle rides inside the argument array: Playwright dereferences it to the live element.
  const out: any = await page.evaluate(pageFn(SELECT_TEXT_JS) as any, [root, arg] as any)
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));

  const where = a.ref ? ` in ${a.ref}` : "";
  if (out.error) return { ok: false, note: `select_text failed: ${String(out.error).split("\n")[0]}` };
  if (out.found === 0) {
    return { ok: false, note: `"${want}" is not${where ? ` in ${a.ref}` : " on this page"} — `
      + "read it back with text() and copy the text exactly, whitespace included"
      + (a.ref ? "" : "; text inside an input or textarea is only reachable with that field's ref") };
  }
  if (out.nearMissing) {
    return { ok: false, note: `"${a.near}" is not${where || " on this page"}, so it cannot pick between the `
      + `${out.found} matches for "${want}" — drop near, or give text that really sits beside the one you mean` };
  }
  if (out.noSelection) return { ok: false, note: "this page has no selection to set" };
  const of = out.found > 1 ? ` (match ${(out.index ?? 0) + 1} of ${out.found}${a.near ? `, the one nearest "${a.near}"` : ", the first"})` : "";
  if (arg.caret !== "select") {
    return { ok: true, note: `caret placed ${arg.caret} "${want}"${where}${of} — nothing is selected; paste({text}) will INSERT there. setText(ref, text) replaces the whole field` };
  }
  // Read back: a Range can be built over unselectable text (a collapsed node, an overlay).
  const got = String(out.selected ?? "");
  if (got !== want) {
    return { ok: true, note: `WARNING: the selection reads back as «${got.slice(0, 60)}», not the text you asked for — `
      + "check the page before typing over it" };
  }
  return { ok: true, note: `selected "${want}"${where}${of} — paste({text}) replaces only this selection. setText(ref, text) replaces the whole field` };
}
