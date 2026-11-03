/**
 * How an observation is SHAPED — full list or incremental diff — the render slice of
 * {@link ComputerUseDriver}. Whether an observation may be a DELTA is stateful (previous body, its
 * printable length, its URL, deltas since the last full list), which is why it is not in the
 * stateless driver-narrate.ts; the wording still comes from there.
 *
 * {@link ComputerUseDriverRender.resetRenderState} drops the state when the surface is REPLACED:
 * a delta against a page that is gone would describe a fiction.
 */

import type { Element, HeaderChanges, Snapshot, TargetInfo, Verdict } from "./types.ts";
import { ComputerUseDriverSelect } from "./driver-select.ts";
import { targetsLine } from "./driver-narrate.ts";
import { controlRef, diffLines, looksUnmarked, reattachRows, stripFocus, stripRow } from "./driver-lines.ts";

/** After this many deltas a full list is re-sent, bounding how far back a delta's anchor is. */
const MAX_DELTA_ROUNDS = 6;
/** A drag whose diff moved page text but no control: what a reorder looks like, whatever focus did. */
const DRAG_TEXT_NOTE = "NOTE: this drag changed the page's text but no interactive element — a reorder "
  + "looks exactly like this; read the order (text()) before dragging again.";

export abstract class ComputerUseDriverRender extends ComputerUseDriverSelect {
  /** Body lines of the last element observation — the delta base; null forces a full render. */
  private lastBody: string[] | null = null;
  private lastElements = new Map<string, Element>();
  /** How many of `lastBody`'s lines were PRINTABLE (covered block excluded): the 50% valve keeps
   * a delta cheaper than the full list it replaces, which never shows the covered block. */
  private lastPrintableLen = 0;
  private lastBodyUrl: string | null = null;
  /** The surfaces line as it was last RENDERED, so an identical one can be summarised instead of
   *  repeated. Null means "say it in full next time" — which is what a reset wants. */
  private lastTargetsLine: string | null = null;
  private deltaRounds = 0;
  /** Context has its own baseline: a background count changing is not an action taking effect. */
  private lastHeadContext: Record<keyof HeaderChanges, string> | null = null;
  /** Connection identity is delivered once, even when the caller trims the listing. */
  protected contextKeep: string[] = [];
  /** Geometry delta of the latest observation vs the one before, as a short phrase (null under
   * the jitter threshold). Read by {@link frozenNote} and the no-effect wording here. */
  protected lastGeomChange: string | null = null;

  /** Forget the delta base alone — a read that FAILED leaves no continuity to diff against,
   *  but the rest of the observation state is still true. */
  protected forgetDeltaBase(): void {
    this.lastBody = null;
    this.lastPrintableLen = 0;
    this.lastHeadContext = null;
    this.lastElements.clear();
  }

  /** Forget the delta base. Called by the pipeline's own reset when the surface is replaced. */
  protected resetRenderState(): void {
    this.lastBody = null;
    this.lastPrintableLen = 0;
    this.lastBodyUrl = null;
    this.lastTargetsLine = null;
    this.deltaRounds = 0;
    this.lastGeomChange = null;
    this.lastHeadContext = null;
    this.contextKeep = [];
    this.lastElements.clear();
  }

  private headerChanges(s: Snapshot): HeaderChanges {
    const shown = new Set(s.elements.map((e) => e.ref));
    const coverage = JSON.stringify(s.covered?.modal
      ? ["modal", s.covered.modal]
      : ["window"]);
    const context: Record<keyof HeaderChanges, string> = {
      target: JSON.stringify(s.target ?? null),
      coverage,
      // Counts stay in observe().coverage. Their fluctuations do not repeat the explanation.
      omissions: JSON.stringify([coverage, !!s.meta.offscreen, !!s.meta.capped, this.viewportPosition(s.meta).maxScrollY > 0]),
      groups: JSON.stringify((s.groups ?? []).map((g) => ({
        label: g.label, members: g.members.filter((r) => shown.has(r)),
      })).filter((g) => g.members.length)),
      ambiguity: JSON.stringify([s.meta.rowsCut ?? 0, s.elements.filter((e) => e.rowBlank).map((e) => e.ref)]),
    };
    const previous = s.url === this.lastBodyUrl ? this.lastHeadContext : null;
    const changed = (key: keyof HeaderChanges) => previous?.[key] !== context[key];
    const changes: HeaderChanges = {
      target: changed("target"), coverage: changed("coverage"), omissions: changed("omissions"),
      groups: changed("groups"), ambiguity: changed("ambiguity"),
    };
    this.lastHeadContext = context;
    this.contextKeep = changes.target && s.target ? [this.targetLine(s.target)] : [];
    return changes;
  }

  /**
   * Render one element observation, full or incremental. Header lines orient each read; coverage
   * and grouping explanations are sent on changes. The body is a delta when safe AND worth it —
   * full on: first round · URL changed · MAX_DELTA_ROUNDS deltas since the last full · diff over
   * half the old body · an attached image (`forceImage`) · COMPUTER_USE_OBS_DELTA=0 (process-wide).
   *
   * Only this decides; no caller can ask for a full render, and none needs to: `readElements`
   * (the script's `observe()`) returns every element and leaves this base untouched — the delta
   * rations rendered text, not access. It leans on sticky refs: an unchanged element yields an
   * identical line and drops out of the diff.
   */
  protected renderObservation(
    snap: Snapshot,
    targets: TargetInfo[],
    verdict: Verdict | null,
    opts: { forceImage?: boolean; afterAction?: string; surfaceChanged?: boolean },
  ): { body: string; obsKind: "full" | "delta"; headLines: number; effectNote: string | null } {
    const bodyLines = this.renderBodyLines(snap);
    // The ~470-char surfaces list is compared whole: ANY change brings the full line back.
    const tl = targetsLine(targets);
    const targetsUnchanged = tl !== null && tl === this.lastTargetsLine;
    this.lastTargetsLine = tl;
    const lines = this.renderHeadLines(snap, targets, targetsUnchanged, this.headerChanges(snap));
    // TEXT lines, not entries: one entry may hold several (an app's knowledge pack,
    // macos/driver.ts), and `brief` must not cut through it.
    const headLines = lines.join("\n").split("\n").length;  // the head of the BODY; observeElements makes it absolute
    const prev = this.lastBody;
    const elements = new Map([...snap.elements, ...(snap.coveredElements ?? [])].map((e) => [e.ref, e]));
    let obsKind: "full" | "delta" = "full";
    let noEffectNote: string | null = null;
    if (prev !== null && verdict !== null && snap.url === this.lastBodyUrl) {
      // Diff ROW-STRIPPED lines (as `elSig` does): a row with a live field (elapsed time, unread
      // count) would put every annotated element in every diff, defeating the swallowed-click
      // check and the 50% valve. The PRINTED line keeps its row (reattachRows); a real row-text
      // change still shows through the excerpt lines.
      const bare = diffLines(prev.map(stripRow), bodyLines.map(stripRow));
      const added = reattachRows(bare.added, bodyLines);
      const removed = reattachRows(bare.removed, prev);
      const removedRefs = new Set(removed.map(controlRef).filter(Boolean));
      const removedLines = new Set(removed);
      const modified = new Map<string, string>();
      for (const line of added) {
        const ref = controlRef(line);
        const before = ref && this.lastElements.get(ref), after = ref && elements.get(ref);
        if (ref && removedRefs.has(ref) && before && after && before.role !== "text" && after.role !== "text"
          && line === this.elementLine(after) && removedLines.has(this.elementLine(before))) {
          modified.set(ref, this.changedElementLine(before, after));
        }
      }
      // Timer pages defeat the frozen verdict (something always ticks), so a swallowed click reads
      // as a harmless text diff and gets re-clicked forever. When an action changed no element,
      // say so — decided before the render-mode split, so a full render says it too. Focus-only
      // changes get neutral wording: moving focus may be the click's purpose.
      if (!opts.surfaceChanged && (opts.afterAction === "click" || opts.afterAction === "drag" || opts.afterAction === "keys")
        && added.length + removed.length > 0) {
        const el = (ls: string[]) => ls.filter((l) => /^e\d+: /.test(l));
        const elAdded = el(added), elRemoved = el(removed);
        if (elAdded.length + elRemoved.length === 0) {
          // Geometry outranks the swallowed accusation: element lines carry no coordinates.
          noEffectNote = this.lastGeomChange
            ? `NOTE: no element appeared or changed state after this ${opts.afterAction}, but geometry changed: ${this.lastGeomChange} — the action DID take effect; judge progress by the new size/position.`
            : opts.afterAction === "drag"
              // A reorder moves TEXT only, focus moved or not — the dragged row is not a control.
              ? DRAG_TEXT_NOTE
              : `NOTE: no interactive element changed after this ${opts.afterAction} — only page text moved (e.g. a timer). `
                + "If you expected an effect, it was likely swallowed (failed validation, wrong element) — re-check what you entered or take a different path instead of repeating it.";
        } else {
          // Both strips: a click that moves focus INTO an annotated row would otherwise still
          // differ by that row's text and never earn the focus wording.
          const flat = (l: string) => stripFocus(stripRow(l));
          const d = diffLines(elRemoved.map(flat), elAdded.map(flat));
          if (d.added.length === 0 && d.removed.length === 0) {
            // Non-element lines are page TEXT: "changed nothing else" would contradict the excerpt
            // when a handler also wrote text. But text is not made evidence — it cannot tell a
            // handler's write from a clock (the swallowed-click loop above) — so the wording
            // borrows "(e.g. a timer)" and stops there.
            const textMoved = added.length > elAdded.length || removed.length > elRemoved.length;
            noEffectNote = this.lastGeomChange
              ? `NOTE: this ${opts.afterAction} moved the focus, and geometry changed: ${this.lastGeomChange}.`
              : textMoved
                ? opts.afterAction === "drag"
                  // For a drag the moved text is the likeliest effect (a reorder).
                  ? DRAG_TEXT_NOTE
                  : `NOTE: this ${opts.afterAction} moved the focus; no interactive element changed. `
                    + "Page text moved too (e.g. a timer), which on its own is not evidence your action landed."
                : `NOTE: this ${opts.afterAction} moved the focus but changed nothing else on the page.`;
          }
        }
      }
      if (
        process.env.COMPUTER_USE_OBS_DELTA !== "0"
        && !opts.forceImage
        && this.deltaRounds < MAX_DELTA_ROUNDS
      ) {
        // The 50% valve: a diff over half the old body is a rewrite — a full list reads better AND
        // costs less. Scroll rounds count only ADDITIONS: their removals are one summary line.
        const cost = opts.afterAction === "scroll" ? added.length : added.length + removed.length - modified.size;
        if (cost <= this.lastPrintableLen * 0.5) {
          obsKind = "delta";
          lines.push(...this.renderDelta(added, removed, opts.afterAction === "scroll", modified));
        }
      }
    }
    if (obsKind === "full") {
      // The covered block between them is baseline-only, never shown: listing an element an
      // overlay covers invites a click that cannot land.
      const elementLines = bodyLines.slice(0, snap.elements.length);
      const excerptLines = bodyLines.slice(snap.elements.length + this.coveredBaselineLines(snap).length);
      lines.push("Interactive elements (act by ref):");
      lines.push(...(elementLines.length ? elementLines : ["(none)"]));
      if (excerptLines.length) {
        lines.push("Body excerpt (full text via text()):");
        lines.push(...excerptLines);
      }
      // Text-rich page, near-empty list: controls are bare spans/divs and more tree reads will not
      // find them. Judged on the SHAPE of the text, not its amount: two buttons over a paragraph
      // is a complete page, and "act by x/y" there sends the model off refs it already has.
      if (looksUnmarked(snap.elements.length, snap.text ?? "")) {
        lines.push("NOTE: almost no interactive elements were detected on a text-rich page — its controls are likely "
          + "unmarked (bare spans/divs). Take a screenshot() and act by x/y coordinates.");
      }
    }
    if (noEffectNote) lines.push(noEffectNote);
    this.lastBody = bodyLines;
    this.lastElements = elements;
    this.lastPrintableLen = bodyLines.length - this.coveredBaselineLines(snap).length;
    this.lastBodyUrl = snap.url;
    this.deltaRounds = obsKind === "delta" ? this.deltaRounds + 1 : 0;
    return { body: lines.join("\n"), obsKind, headLines, effectNote: noEffectNote };
  }
}
