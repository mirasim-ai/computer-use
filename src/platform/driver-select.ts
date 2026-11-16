/**
 * Selection-based observation — the read that answers with the surface as DATA (the repl's
 * `observe()` and `find(name)`).
 *
 * Its own slice of the chain (`…Refs` → `…Select` → `ComputerUseDriver`) because of one hard
 * rule: it must never touch the change-verdict ring. `prevSig` / `prevElSig` / `lastBody` /
 * `lastRects` mean "the screen as last seen"; a filtered set fed into them makes the next real
 * observation read `changed` for nothing. Here the ring is not even in scope. What this slice
 * needs from below is declared abstract and implemented in ComputerUseDriver.
 */

import type { Element, Heading, ObservationCoverage, Snapshot, TargetIdentity } from "./types.ts";
import { ComputerUseDriverRefs } from "./driver-refs.ts";

export abstract class ComputerUseDriverSelect extends ComputerUseDriverRefs {
  abstract readonly platform: string;

  // ── Implemented further down the chain (driver-base.ts), called from here ──────────
  protected abstract snapshot(): Promise<Snapshot>;
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
    const snapshot = await this.bounded("observe", this.snapshot());
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
}
