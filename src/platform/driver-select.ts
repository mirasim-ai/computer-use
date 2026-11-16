/**
 * The surface as DATA: what the repl's `observe()` and `find(name)` read
 * (`ComputerUseDriver.readElements`), as a plain function of one snapshot.
 *
 * Kept apart from the observation that ends a round because of one hard rule: a read made in the
 * middle of a script must never touch the change-verdict ring. `prevSig` / `prevElSig` /
 * `lastRects` and the delta base mean "the screen as the model last saw it"; a mid-script read
 * fed into them would make the run's closing observation diff against that read instead of the
 * screen before the script. Nothing here can reach the ring: it takes a snapshot and answers.
 */

import type { Element, Heading, ObservationCoverage, Snapshot, TargetIdentity } from "./types.ts";
import { observationCoverage } from "./driver-narrate.ts";

/** One read of the surface, every element on screen and off. */
export interface SurfaceData {
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
}

/** Off-viewport elements come back too, flagged `offscreen`. */
export function surfaceData(snapshot: Snapshot): SurfaceData {
  const off = (snapshot.offscreenElements ?? []).map((e) => ({ ...e, offscreen: true }));
  const all = [...snapshot.elements, ...off];
  return { url: snapshot.url, title: snapshot.title, elements: all,
    coverage: observationCoverage(snapshot), ...(snapshot.target ? { target: snapshot.target } : {}),
    ...(snapshot.groups?.length ? { groups: snapshot.groups } : {}),
    ...(snapshot.headings?.length ? { headings: snapshot.headings } : {}), ...(snapshot.meta.partial ? { partial: snapshot.meta.partial } : {}),
    ...(snapshot.coveredElements?.length
      ? { covered: { by: snapshot.covered?.top || "an overlay", elements: snapshot.coveredElements } } : {}) };
}
