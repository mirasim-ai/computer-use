/**
 * Element LINES as text: the diff between two observations, and the rules that keep it honest —
 * a focus mark is not a change, a row label is not identity, a churning transcript is summarised.
 * Pure functions over strings; `driver-narrate.ts` renders lines, this compares them.
 */


/** The frozen wording when the round was a LOOK, not an action. The action wording ("your last
 * action had no effect") after a mere re-observe makes the model abandon a working approach. */
export const OBSERVE_FROZEN_NOTE =
  "NOTE: unchanged since your last observation (that was a look, not an action — nothing failed). " +
  "If you are waiting for something to appear, use wait({text:'…'}) instead of observing again.";

/** Erase the focus marker from an element line so focus-only diffs cancel out. */
export function stripFocus(l: string): string {
  return l.replace(/ \[focused\]$/, "").replace("[focused, ", "[");
}

/** Only actual element lines have identity; page prose that happens to repeat is still text. */
export function controlRef(line: string): string | undefined {
  return /^(e\d+): /.exec(line)?.[1];
}

/** Erase the row annotation so row-only diffs cancel out (a live field in a row would churn every
 * line, as for `elSig`). Anchored on what FOLLOWS it (state bracket or end of line) so a `⟩`
 * inside the row text cannot cut it short. */
export function stripRow(l: string): string {
  return l.replace(/ ⟨row: .*⟩(?= \[|$)/, "");
}

/** Re-attach what {@link stripRow} removed, so a diff on stripped lines still PRINTS row context.
 * Multiset, matching {@link diffLines}. */
export function reattachRows(stripped: string[], full: string[]): string[] {
  const byBare = new Map<string, string[]>();
  for (const l of full) {
    const k = stripRow(l);
    const q = byBare.get(k);
    if (q) q.push(l);
    else byBare.set(k, [l]);
  }
  return stripped.map((l) => byBare.get(l)?.shift() ?? l);
}

/** Multiset line diff: what disappeared, what appeared. Order-insensitive on purpose —
 * a row moving within a list is not a change worth a line. */
export function diffLines(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  const budget = new Map<string, number>();
  for (const l of prev) budget.set(l, (budget.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of next) {
    const n = budget.get(l) ?? 0;
    if (n > 0) budget.set(l, n - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const [l, n] of budget) for (let i = 0; i < n; i++) removed.push(l);
  return { added, removed };
}

/**
 * Does a page with this few controls look like its controls are UNMARKED (bare spans/divs)?
 *
 * Judged on the SHAPE of the viewport excerpt (one line per text run), not its length: a
 * bare-div app is a LIST of many short runs, a marked page with few controls (consent wall,
 * terms, 404) is PROSE, a few long runs. A controls/chars ratio cannot tell those apart; the run
 * count can (41/47 on a fixture sweep, no bare-div page missed). Bullet-heavy marked pages fire
 * on purpose: that costs one screenshot, a missed bare-div app costs a dozen observations.
 *
 * Zero controls need only two short runs: with nothing to act on by ref the note is cheap even
 * when wrong (`test/smoke.ts` pins the shape). No text floor (a toolbar over a canvas is 25
 * chars) and no off-viewport clause (a footer link below the fold is on nearly every page).
 */
export function looksUnmarked(controls: number, excerpt: string): boolean {
  if (controls > 2) return false;
  const shortRuns = excerpt.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("(cut at") && l.length < SHORT_RUN_CHARS).length;
  return shortRuns >= (controls === 0 ? 2 : 8);
}
/** A text run shorter than this is a row or an item, not a paragraph (rows measured 8–80
 * chars; the shortest prose paragraph 143). */
const SHORT_RUN_CHARS = 120;

/**
 * Element lines the model can ACT on, and the ones that are just text. A `text` row's ref is keyed
 * on its value, so changing prose (a streaming answer) re-mints every one as a removal plus an
 * addition, burying the control changes worth reading.
 */
export function splitTextChurn(lines: string[]): { controls: string[]; text: string[] } {
  const controls: string[] = [], text: string[] = [];
  for (const l of lines) (/^e\d+: text /.test(l) || !/^e\d+: /.test(l) ? text : controls).push(l);
  return { controls, text };
}

/** Text-line changes a delta still prints one by one; above this they are churn, summarised as a
 *  count plus a pointer to text(). */
export const TEXT_CHURN_MAX = 8;
