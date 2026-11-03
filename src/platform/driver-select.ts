/**
 * Selection-based observation — reads that answer with a SUBSET of the surface (`find('…')`,
 * the repl's `observe()`).
 *
 * Its own slice of the chain (`…Refs` → `…Select` → `ComputerUseDriver`) because of one hard
 * rule: it must never touch the change-verdict ring. `prevSig` / `prevElSig` / `lastBody` /
 * `lastRects` mean "the screen as last seen"; a filtered set fed into them makes the next real
 * observation read `changed` for nothing. Here the ring is not even in scope. What this slice
 * needs from below is declared abstract and implemented in ComputerUseDriver.
 */

import type { Element, Heading, ObservationCoverage, SnapshotCapture, TargetIdentity, ToolResult } from "./types.ts";
import { SurfaceGoneError, text } from "./types.ts";
import { ComputerUseDriverRefs } from "./driver-refs.ts";

/** Per-query match cap, far below the walk's ref cap: a query matching 300 controls has
 *  narrowed nothing, and one line saying so is cheaper than 300 lines. */
const MATCH_CAP = 25;

export abstract class ComputerUseDriverSelect extends ComputerUseDriverRefs {
  abstract readonly platform: string;

  // ── Implemented by ComputerUseDriver, called from here ──────────────────────────────
  protected abstract captureSnapshot(): Promise<SnapshotCapture>;
  protected abstract bounded<T>(what: string, run: Promise<T>): Promise<T>;

  /** Observations since the last dispatched action. Re-observing an unchanged surface is the top
   * step-burner; past a threshold the observation itself says "stop looking, act". */
  protected observesSinceAction = 0;

  /**
   * Did this round READ CONTENT — text, a page tree, a screenshot, diagnostics? Exempt from the
   * counter above: "more looking will not reveal more" is true of re-listing controls and false
   * of reading a long document in parts. Exempt, not RESET: a run that only re-lists controls
   * still escalates, and re-reading unchanging text is caught by the frozen verdict.
   */
  protected contentRead = false;

  /** Called by the read bindings (`text` / `page` / `screenshot` / `diagnostics`). */
  noteContentRead(): void {
    this.contentRead = true;
  }

  /** Consumed by the ONE observation that ends the round. */
  protected takeContentRead(): boolean {
    const had = this.contentRead;
    this.contentRead = false;
    return had;
  }

  /**
   * The surface as DATA — what the repl's `observe()` returns; renders nothing.
   *
   * Must not touch the verdict ring: the model sees one observation at the end of the run, and
   * it must diff against the screen BEFORE the script. Refs are remembered (the script acts on
   * them, so they must pass `knownRef`). Off-viewport elements come back too, flagged `offscreen`.
   */
  async readElements(): Promise<{
    url: string; title: string; elements: Array<Element & { offscreen?: boolean }>;
    coverage: ObservationCoverage;
    target?: TargetIdentity;
    /** The page's own grouping (see {@link Snapshot.groups}); absent where the surface has none.
     *  Members may name any ref in `elements`, on screen or off. */
    groups?: { label: string; members: string[] }[];
    /** {@link Snapshot.headings}: reference boxes for layout measurements; web surfaces only. */
    headings?: Heading[];
    /** {@link Snapshot.meta.partial}: the read did not cover the surface. */
    partial?: string;
    /** Controls collected but not actionable because an overlay sits on them, and what covers
     *  them (the same label a covered ref is refused with). Absent when nothing is covered. */
    covered?: { by: string; elements: Element[] };
  }> {
    const { snapshot } = await this.bounded("observe", this.captureSnapshot());
    const off = (snapshot.offscreenElements ?? []).map((e) => ({ ...e, offscreen: true }));
    const all = [...snapshot.elements, ...off];
    this.rememberRefs({ ...snapshot, elements: all });
    return { url: snapshot.url, title: snapshot.title, elements: all,
      coverage: this.observationCoverage(snapshot), ...(snapshot.target ? { target: snapshot.target } : {}),
      ...(snapshot.groups?.length ? { groups: snapshot.groups } : {}),
      ...(snapshot.headings?.length ? { headings: snapshot.headings } : {}), ...(snapshot.meta.partial ? { partial: snapshot.meta.partial } : {}),
      ...(snapshot.coveredElements?.length
        ? { covered: { by: snapshot.covered?.top || "an overlay", elements: snapshot.coveredElements } } : {}) };
  }

  /**
   * Query observation (behind `find('…')`): every control whose NAME (or row) contains the query,
   * viewport or not, each with the ref to act on.
   *
   * Separate from {@link observeElements} because it must NOT touch the verdict ring (see the
   * file header); a filtered set would also leave the delta base describing a fiction. It does
   * share {@link rememberRefs} over the matches (a matched off-viewport ref must pass `knownRef`;
   * the walk already minted it) and the push-to-act counter (a query spree is a looking spree).
   *
   * Known gap: an in-viewport match may have lost its row to the row budget (`meta.rowsCut`)
   * while an off-viewport one keeps it; fix by re-pricing rows for the matched set if it bites.
   */
  async observeMatches(query: string): Promise<ToolResult> {
    let capture: SnapshotCapture;
    try {
      capture = await this.bounded("observe", this.captureSnapshot());
    } catch (e) {
      if (e instanceof SurfaceGoneError) throw e; // the stop instruction path stays
      return text(`(query failed: ${(e as Error).message})`, { verdict: "unknown" });
    }
    const snap = capture.snapshot;
    const offscreen = snap.offscreenElements ?? [];
    const hit = matcher(query);
    const inView = snap.elements.filter(hit);
    const offView = offscreen.filter(hit);
    // OFF-viewport matches fill the cap FIRST: on-screen ones are also listed by a plain
    // `observe()`, while a dropped off-viewport match loses a ref available nowhere else.
    // Selection order only — the render still leads with the viewport group.
    const keptOff = offView.slice(0, MATCH_CAP);
    const keptIn = inView.slice(0, Math.max(0, MATCH_CAP - keptOff.length));
    const droppedOff = offView.length - keptOff.length;
    const droppedIn = inView.length - keptIn.length;
    const kept = [...keptIn, ...keptOff];
    this.rememberRefs({ ...snap, elements: kept });
    const lines = this.renderMatches(
      snap, query, keptIn, keptOff,
      snap.elements.length + offscreen.length, offscreen.length,
      { inViewport: droppedIn, offscreen: droppedOff },
    );
    if (++this.observesSinceAction >= 3) {
      lines.push(`NOTE: ${this.observesSinceAction} observations in a row without acting — `
        + "more looking will not reveal more; act (click / set_text / drag / scroll) before looking again.");
    }
    return text(lines.join("\n"), {
      url: snap.url, query, matches: inView.length + offView.length,
      searched: snap.elements.length + offscreen.length,
      offscreenMatches: offView.length, dropped: droppedIn + droppedOff,
      droppedInViewport: droppedIn, droppedOffscreen: droppedOff,
      // NOT "full": a query result is neither the full list nor a diff.
      obsKind: "find",
      viewport: this.viewportPosition(snap.meta),
    });
  }

}

/**
 * Query matching: case-insensitive substring over whitespace-normalized name OR row context.
 * Substring, not regex: a regex costs schema text on every host and turns a typo into an error.
 * Row is searched because among thirty same-named Delete buttons the row (`user23@example.com`)
 * IS the disambiguator. But `row` exists only where a name needed help, so a uniquely named
 * control's row text is not searchable — see {@link Element.row}.
 */
function matcher(query: string): (e: Element) => boolean {
  const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
  const q = norm(query);
  if (!q) return () => false;
  return (e) => norm(e.name).includes(q) || (!!e.row && norm(e.row).includes(q));
}
