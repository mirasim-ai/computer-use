/**
 * Selection-based observation — the read that answers with the surface as DATA (the repl's
 * `observe()` and `find(name)`).
 *
 * Its own slice of the chain (`…Refs` → `…Select` → `…Render` → `…Base` → …) because of one hard
 * rule: it must never touch the change-verdict ring. `prevSig` / `prevElSig` / `lastBody` /
 * `lastRects` mean "the screen as the model last saw it"; a read made in the middle of a script
 * fed into them would make the run's closing observation diff against that read instead of the
 * screen before the script. Here the ring is not even in scope: it is declared in later links.
 * What this slice needs from those is declared abstract and implemented in driver-base.ts.
 */

import type { Element, Heading, ObservationCoverage, Snapshot, TargetIdentity } from "./types.ts";
import { observationCoverage } from "./driver-narrate.ts";
import { RefBook } from "./driver-refs.ts";

export abstract class ComputerUseDriverSelect {
  abstract readonly platform: string;

  // ── Refs (driver-refs.ts) ────────────────────────────────────────────────────────────
  /** Which refs the model may act on, and what each last named. */
  protected readonly refs = new RefBook({ scrollsInto: () => this.scrollsInto, staleCause: () => this.staleRefCause() });
  /** Can `scroll({into: ref})` bring one control, a covered one included, to the middle of the
   *  viewport? DECLARED, not inferred: the API reference and the cover notes offer it only where
   *  it exists. */
  readonly scrollsInto: boolean = false;
  /** Does a read collect the controls an overlay sits on ({@link Snapshot.coveredElements})?
   *  DECLARED like `scrollsInto`: only where it does can `find(…, {why})` answer `covered`. */
  readonly readsCovered: boolean = false;

  /** Is this ref one the model has legitimately seen? Refs accumulate (capped) and die with the
   * surface. A courtesy filter, never the last line of defense; when it says no, answer with
   * {@link staleRefNote}. */
  knownRef(ref: string): boolean {
    return this.refs.known(ref);
  }

  /** The role and name `ref` carried when it was last listed — also after the surface that
   *  minted it is gone, so a refusal can say what it was. Undefined for a ref never handed out. */
  refWas(ref: string): { role: string; name: string } | undefined {
    return this.refs.was(ref);
  }

  /** Why a ref the caller sent cannot be used; the three cases are {@link RefBook.staleNote}'s. */
  staleRefNote(ref: string): string {
    return this.refs.staleNote(ref);
  }

  /**
   * How refs stop being valid on THIS platform, as one clause with no leading capital. Declared
   * variance: browser mechanisms (navigation, tab switch) named on a native window send the model
   * looking for a page that was never there; the default names no mechanism.
   */
  protected staleRefCause(): string {
    return "the surface has changed since it was handed out";
  }

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
    this.refs.remember({ ...snapshot, elements: all });
    return { url: snapshot.url, title: snapshot.title, elements: all,
      coverage: observationCoverage(snapshot), ...(snapshot.target ? { target: snapshot.target } : {}),
      ...(snapshot.groups?.length ? { groups: snapshot.groups } : {}),
      ...(snapshot.headings?.length ? { headings: snapshot.headings } : {}), ...(snapshot.meta.partial ? { partial: snapshot.meta.partial } : {}),
      ...(snapshot.coveredElements?.length
        ? { covered: { by: snapshot.covered?.top || "an overlay", elements: snapshot.coveredElements } } : {}) };
  }
}
