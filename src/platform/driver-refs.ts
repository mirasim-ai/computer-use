/**
 * Ref bookkeeping — which refs the model may act on, and what to say when the one it sent is
 * not among them. One object the driver holds ({@link RefBook}), so "why was my ref refused?" is
 * answered by one file. What differs per platform reaches it as two questions it asks back:
 * whether `scroll({into})` exists, and how refs go stale there.
 */

import type { Snapshot } from "./types.ts";

/** Cap on remembered refs (they accumulate across observations); oldest evicted first. */
const MAX_KNOWN_REFS = 2000;

/** What a {@link RefBook} asks the platform it keeps refs for. Asked at use, never copied: both
 *  are declared by the platform's own class, which is built after the book. */
export interface RefBookPlatform {
  /** Whether `scroll({into: ref})` exists here, to bring a covered control clear. */
  scrollsInto(): boolean;
  /** How refs stop being valid on this platform, as one clause with no leading capital. */
  staleCause(): string;
}

export class RefBook {
  constructor(private readonly platform: RefBookPlatform) {}

  /** Refs the model may act on, accumulated across observations. See {@link known}. */
  private refs = new Set<string>();
  /** What each ref last named. NOT cleared by {@link forget}: it is what lets a refusal of
   *  a ref from before a reload say which control that was. Capped like {@link refs}. */
  private refNames = new Map<string, { role: string; name: string }>();
  /** Has an element observation on this surface ever succeeded? NOT cleared by
   *  {@link forget}: it alone tells a REPLACED surface from a never-readable one. */
  private everObserved = false;
  /** Why the last observation failed, so a refusal repeats the real reason. Cleared on success. */
  private lastObserveFailure: string | null = null;
  /** Refs the last observation COLLECTED but did not list because an overlay covers them,
   *  mapped to the coverer's name. Replaced each read: being covered is a fact about right now.
   *  Read only by {@link staleNote}. */
  private coveredRefs = new Map<string, string>();

  /** Is this ref one the model has legitimately seen? Refs accumulate (capped) and die with the
   * surface ({@link forget}). A courtesy filter, never the last line of defense; when it says
   * no, answer with {@link staleNote}. */
  known(ref: string): boolean {
    return this.refs.has(ref);
  }

  /** The role and name `ref` carried when it was last listed — also after the surface that
   *  minted it is gone, so a refusal can say what it was. Undefined for a ref never handed out. */
  was(ref: string): { role: string; name: string } | undefined {
    return this.refNames.get(ref);
  }

  /**
   * Why a ref the caller sent cannot be used. NOT a prefix — the caller frames it ("Action
   * failed:" for an action, nothing for a look). Three states, three pieces of advice:
   *  - Never read: no ref was ever handed out and re-observing fails the same way until the
   *    blocker (missing grant, locked screen) is dealt with, so repeat the known reason.
   *  - Collected but covered: re-observing returns the same list, so name the overlay — the
   *    refusal must lead to an act, not a retry loop.
   *  - Otherwise: re-observing is the fix. The platform's cause is a LIKELIHOOD, not a
   *    finding; the ref may never have been handed out, so both causes are named.
   */
  staleNote(ref: string): string {
    if (!this.everObserved) {
      const why = this.lastObserveFailure;
      return `ref ${ref} is not usable — this surface has not been read yet, so it has never handed out a ref. `
        + (why
          ? `The last read failed, and the next one fails the same way until this is dealt with — ${why}`
          : "Call observe() first.");
    }
    const coverer = this.coveredRefs.get(ref);
    if (coverer) {
      return `ref ${ref} was collected but not listed — «${coverer}» covers it, so it is not actionable `
        + "and re-observing returns the same list. Deal with that overlay first"
        + (this.platform.scrollsInto() ? `, or scroll({into:'${ref}'}) to bring it clear` : "") + ", or act on a listed ref.";
    }
    return `ref ${ref} is not among the refs currently in play — either ${this.platform.staleCause()}, `
      + "or it was never handed out (refs come from observe() and find(), never from the surface's own markup). "
      + "Re-observe (w.observe()) and use a ref from that list.";
  }

  /** Remember the snapshot's refs, refreshed to most-recent so eviction hits the oldest. */
  remember(snap: Snapshot): void {
    // Reaching here IS a successful read, empty screen included (see everObserved).
    this.everObserved = true;
    this.lastObserveFailure = null;
    // Replaced, never accumulated: a stale entry would blame a dialog no longer on screen.
    this.coveredRefs.clear();
    const coverer = snap.covered?.top || "an overlay";
    for (const e of snap.coveredElements ?? []) this.coveredRefs.set(e.ref, e.coveredBy || coverer);
    for (const e of snap.elements) {
      this.refs.delete(e.ref); // re-insert: Set keeps insertion order, so this refreshes recency
      this.refs.add(e.ref);
      this.refNames.delete(e.ref);
      this.refNames.set(e.ref, { role: e.role, name: e.name });
    }
    for (const ref of this.refNames.keys()) {
      if (this.refNames.size <= MAX_KNOWN_REFS) break;
      this.refNames.delete(ref);
    }
    for (const ref of this.refs) {
      if (this.refs.size <= MAX_KNOWN_REFS) break;
      this.refs.delete(ref);
    }
  }

  /** The refs died with the surface (see `resetObservationState`). `everObserved` survives on
   *  purpose — this surface HAS been readable, which is what the refusal needs to know. */
  forget(): void {
    this.refs.clear();
    this.coveredRefs.clear();
  }

  /** Why the read that just failed, failed — kept for {@link staleNote}. */
  noteFailure(message: string): void {
    this.lastObserveFailure = message;
  }
}

/** Lenient identity check, shared by every platform: does the on-screen name match what the
 * model named? Errs toward agreement (a false "stale" rejects a good click); only a clear
 * mismatch counts as moved. One-character names (a calculator's keys) compare exactly, because
 * the lenient rules would agree with anything. */
export function nameAgrees(actual: string, want: string): boolean {
  const norm = (s: string) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const a = norm(actual), w = norm(want);
  if (!w || !a) return true; // nothing to check against
  if (a.length < 2 || w.length < 2) return a === w;
  if (/^\d+$/.test(a) && /^\d+$/.test(w)) return a === w; // both numeric → strict
  return a.includes(w) || w.includes(a) || a.slice(0, 6) === w.slice(0, 6);
}
