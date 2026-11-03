/**
 * The TEXT channel: the window's own words, in the order the app has them. `textOf` re-joins the
 * walk's on- and off-screen arrays into one reading order for `text()`; `foldTextRuns` folds runs
 * of static text into one element for the listing's row budget.
 */

import { clean, collapse, roleOf } from "./element-lines.ts";
import type { AxElement, AxTree } from "./element-shapes.ts";

/**
 * On-screen and off-screen rows as ONE sequence, in the order the app itself has them. The walk
 * splits them (@see AxTree.offscreenElements); `seq`, its visit counter, restores the order. A
 * helper too old to send `seq` sorts to the end, so off-screen rows follow, never interleave wrongly.
 */
function inDocumentOrder(tree: AxTree): AxElement[] {
  const off = tree.offscreenElements ?? [];
  if (!off.length) return tree.elements;
  const at = (e: AxElement) => e.seq ?? Number.POSITIVE_INFINITY;
  // STABLE sort: with no seq anywhere this is exactly `elements` then `offscreenElements`.
  return [...tree.elements, ...off].sort((a, b) => at(a) - at(b));
}

/**
 * The `text` channel — every visible string, one per line.
 *
 * Not a side effect of the element walk: the tree carries a 400-char PREVIEW of each value, and a
 * full-text read must re-assemble from COMPLETE values without going near a ref. Re-running
 * mapTree would change a static text's name (its name IS its value, part of its ref signature),
 * re-minting every ref on screen. A value that could not be completed keeps its preview and says
 * so, in the page read's words (`chromium/read-page.ts`): a silent trim reads as "that is all".
 *
 * Off-screen rows are included (otherwise `find` could NAME a row of an AppKit list scrolled out
 * of view that `text()` cannot read; web content already reports those in `elements`), woven into
 * document order by {@link AxElement.seq} so a model reading for "the latest" phrase gets the
 * right one. No row is MARKED off-screen: the observation already counts those.
 */
export function textOf(tree: AxTree): string {
  const lines: string[] = [];
  for (const e of inDocumentOrder(tree)) {
    const role = roleOf(e);
    const name = clean(e.title || e.desc || (role === "text" ? e.value : ""));
    const val = e.value.trim();
    const receipt = e.valueCut ? ` (cut at ${e.value.length} chars — the app has the full value)` : "";
    if (role === "text") {
      if (val) lines.push(val + receipt);
    } else if (val && !(role === "checkbox" || role === "radio")) {
      lines.push((name ? `${name}: ${val}` : val) + receipt);
    } else if (name) {
      lines.push(name);
    }
  }
  return lines.join("\n");
}

/** How much of a merged text run an element LINE carries: the same 80 characters `clean` allows any
 *  name, since a larger cap would just be trimmed again. The line is for orientation and a ref to
 *  scroll by; the whole text is `text()`'s job, which never folds (that would silently trim). */
const RUN_PREVIEW = 80;

/**
 * Fold consecutive static text into one element each. Web content hands out fragments, not
 * paragraphs (one 10,633-char answer measured 2,082 `AXStaticText` nodes), which would crowd out
 * the controls. The run breaks at the first non-text element, so Copy buttons, links and headings
 * keep the structure visible. The merged node keeps the FIRST fragment's identity (key, frame), so
 * `scroll ref:` and stale-ref refusals still work; only `text`, a role read and never clicked, folds.
 */
/** How long a run has to be before it is folded. Not 2: fragmentation and ADJACENCY look the same
 *  in tree order. Chromium's fragments come in long runs (measured average 21), while a native
 *  window's adjacent readouts come in ones and twos, and folding Calculator's result row into its
 *  display would cost the display its ref the moment a row appears above it. Runs of 2-3 were
 *  4 of 77 measured, so 5 keeps nearly all of the shrink. A SwiftUI form label is a run of one. */
const RUN_MIN = 5;

export function foldTextRuns(elements: AxElement[]): AxElement[] {
  const out: AxElement[] = [];
  let run: AxElement[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length < RUN_MIN) out.push(...run);
    else {
      const first = run[0]!;
      const joined = collapse(run.map((e) => e.value || e.title || e.desc).join(""));
      out.push({
        ...first,
        value: joined.length > RUN_PREVIEW ? `${joined.slice(0, RUN_PREVIEW)}\u2026` : joined,
        // The count travels as the element's own fact; `stateOf` renders it.
        runOf: run.length,
      });
    }
    run = [];
  };
  for (const e of elements) {
    if (roleOf(e) === "text" && !clean(e.title || e.desc)) run.push(e);
    else { flush(); out.push(e); }
  }
  flush();
  return out;
}
