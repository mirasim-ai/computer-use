/**
 * The VERDICT half of the shared narration: how `find` reports matches, what a delta says, and
 * what a run is told when the surface did not change. `driver-narrate.ts` RENDERS what was
 * observed; this JUDGES it. Both stay in the base class: the wording was tuned against real
 * failures, and a platform fork would teach the model what the other platforms contradict.
 */

import type { Element, Snapshot } from "./types.ts";
import { ComputerUseDriverNarrate, type FrozenFacts } from "./driver-narrate.ts";
import { controlRef, splitTextChurn, TEXT_CHURN_MAX } from "./driver-lines.ts";

/** Standard effect-evidence wording. Tuned against real failure modes; identical on
 * every platform so behavior learned on one transfers to another. */
const FROZEN_NOTE =
  "NOTE: the screen did NOT change after your last action — it likely had no effect. " +
  "Do not repeat the same action; try a different element or approach.";

/** The frozen wording when the run dispatched SEVERAL actions. The verdict compares this run's
 * end with the previous run's, so a round trip (a panel opened then closed) reads as frozen, and
 * so does a run that redid work to the same result (Calculator: the same sum twice). Neither
 * means an action failed, and {@link FROZEN_NOTE}'s "do not repeat" would abandon a sequence that
 * worked: the net effect is nothing, and only the caller knows whether that was the plan. */
const FROZEN_ROUNDTRIP_NOTE =
  "NOTE: the screen ends this run where it started. That is what a round trip looks like (opened then closed, " +
  "scrolled away then back), and also what redoing work that produces the same result looks like — it is NOT by " +
  "itself evidence that an action failed. Intermediate states are not in this observation: read the value you "
  + "expected to change, or return your own observe() results, before deciding.";

/** The frozen wording when the read channel cannot see the content ({@link FrozenFacts.treeBlind}):
 * a self-drawn macOS app publishes only its window, so the signature survives an action that
 * landed. This channel has no opinion — go and look. */
const FROZEN_BLIND_NOTE =
  "NOTE: the element tree is unchanged, but on this surface the tree cannot see the app's own drawing — so this is NOT "
  + "evidence that your action failed. Take a screenshot (observe({screenshot: true})) and judge from the picture.";

/** A run whose last verb was `wait`: a frozen screen is a condition not yet arrived, and the wait
 * already said what it waited for. "Do not repeat" is wrong for the verb meant to be re-called. */
const FROZEN_WAIT_NOTE =
  "NOTE: the surface is unchanged, which is what a wait whose condition has not arrived looks like — "
  + "the wait's own line says what it was waiting for and how long it spent. Nothing acted here, so this is not a "
  + "dead action: wait again if it is still coming.";

/** Escalation of {@link FROZEN_NOTE} when the SAME action (kind + main arguments)
 * produced a frozen screen twice in a row — the polite version was already ignored once. */
const FROZEN_REPEAT_NOTE =
  "NOTE: You already tried this exact action and the screen did not change. " +
  "Repeating it a third time will not help — change target or approach.";

export abstract class ComputerUseDriverVerdict extends ComputerUseDriverNarrate {
  /**
   * The query observation behind `find('…')`. Opens with a RECEIPT — what was searched (control
   * names), how many, how many outside the viewport — so "not found" is a claim the tool makes,
   * not an absence the model infers. It says "controls", never "the page": what this channel
   * cannot see is what a wrong answer turns on. Matches are GROUPED by on/off screen, not
   * annotated per line: the split is actionable (click now vs the click scrolls it into view), a
   * header costs one line, and per-line suffixes would un-anchor `stripFocus` ({@link elementLine}).
   */
  protected renderMatches(
    s: Snapshot, query: string,
    inView: Element[], offView: Element[],
    searched: number, offscreenSearched: number,
    dropped: { inViewport: number; offscreen: number },
  ): string[] {
    const shown = inView.length + offView.length;
    const cut = dropped.inViewport + dropped.offscreen;
    const lines = [`Title: ${s.title} | ${s.url}`];
    const scope = `${searched} control${searched === 1 ? "" : "s"} searched`
      + (offscreenSearched ? `, ${offscreenSearched} of them outside the viewport` : "");
    if (cut) {
      // Actionable half first: leading with "narrow the query" frames a result CONTAINING the
      // target as a failed search. Which SIDE was cut is stated, as the ways out differ: an
      // on-screen omission is one observe() away, an off-screen one reachable only by narrowing.
      const where = dropped.offscreen && dropped.inViewport
        ? `${dropped.inViewport} of them in the viewport, ${dropped.offscreen} outside it`
        : dropped.offscreen
          ? "all of them outside the viewport — narrow the query to reach those"
          : "all of them in the viewport — a plain observe() lists those";
      lines.push(`find "${query}" — ${shown} of ${shown + cut} matches shown, ${cut} not listed `
        + `(${where}). ${scope}. If what you want is below, act on it; narrow the query only if it is not.`);
    } else {
      lines.push(`find "${query}" — ${shown} match${shown === 1 ? "" : "es"} (${scope}).`);
    }
    if (shown === 0) {
      // Name the boundary: what WAS searched (so a zero is trustworthy) and what was not (so it is
      // not read as "nothing like that here"). The row caveat is literal: a control whose name
      // identifies it carries no ⟨row⟩, so its surrounding text is unsearchable here.
      lines.push("Searched every control's name, and the ⟨row⟩ context of controls that have one "
        + "(a control whose name already identifies it carries none). Page text outside those is a "
        + "different channel — read it with page().");
      return lines;
    }
    if (inView.length) {
      lines.push("In the viewport (act by ref):");
      lines.push(...inView.map((e) => this.elementLine(e)));
    }
    if (offView.length) {
      lines.push("Outside the viewport (act by ref — the click scrolls it into view, no need to scroll first):");
      lines.push(...offView.map((e) => this.elementLine(e)));
    }
    return lines;
  }

  /** The delta body. After a scroll, lines that left the viewport are summarized, not listed as
   * removals (a wall of "-" taught models to re-observe in full). The summary stays NEUTRAL: hover
   * menus close on scroll and virtual lists recycle DOM, so never promise those refs are alive. */
  protected renderDelta(added: string[], removed: string[], afterScroll: boolean, modified = new Map<string, string>()): string[] {
    const lines: string[] = [];
    if (afterScroll) {
      if (added.length) lines.push("Newly visible after scrolling:", ...added.map((l) => `+ ${l}`));
      if (removed.length) lines.push(`(${removed.length} line${removed.length === 1 ? "" : "s"} left the viewport — scrolled out, or dismissed (hover menus close on scroll); re-observe before acting on their refs if unsure)`);
      if (!added.length && !removed.length) lines.push("(nothing new is visible)");
    } else {
      lines.push("Changes since last observation:");
      if (added.length || removed.length) {
        const a = splitTextChurn(added), r = splitTextChurn(removed);
        const churn = a.text.length + r.text.length;
        lines.push(
          ...r.controls.filter((l) => !modified.has(controlRef(l) ?? "")).map((l) => `- ${l}`),
          ...modified.values(),
          ...a.controls.filter((l) => !modified.has(controlRef(l) ?? "")).map((l) => `+ ${l}`),
        );
        if (churn > TEXT_CHURN_MAX) {
          lines.push(`(${churn} text lines changed too — this surface re-renders or streams its text; read it with text() rather than from this diff)`);
        } else {
          lines.push(...r.text.map((l) => `- ${l}`), ...a.text.map((l) => `+ ${l}`));
        }
      } else lines.push("(none)");
    }
    lines.push("(unchanged elements omitted — refs from earlier observations remain valid; full list re-sent periodically)");
    return lines;
  }

  /** The frozen wording for an action round (a look gets {@link OBSERVE_FROZEN_NOTE} at the call
   * site); state arrives as {@link FrozenFacts}. A scroll that measurably moved reads as a uniform
   * list; a set_text verified by read-back is not "no effect" (that drove models into
   * click+select-all+delete loops); the same action frozen twice gets the harsher wording. */
  protected frozenNote(afterAction: string, f: FrozenFacts): string {
    if (afterAction === "scroll" && f.scrollMoved !== null && f.scrollMoved >= 8) {
      return `NOTE: scrolled ${Math.round(f.scrollMoved)}px but the visible elements look identical (uniform list?).`;
    }
    if (afterAction === "set_text" && f.writeRound?.ended) {
      // "Try another element" would send the model back to the fields it just filled: name what
      // was dispatched, and for Enter the usual cause.
      const ended = f.writeRound.ended;
      return `NOTE: the fields are filled and ${ended} was dispatched, but nothing on screen changed — `
        + (ended === "keys Enter"
          ? "this form does not submit on Enter. Click its submit button."
          : "re-observe before assuming the sequence worked.");
    }
    if (afterAction === "set_text" && f.writeRound && f.writeRound.fields > 0
      && f.writeRound.verified === f.writeRound.fields) {
      return f.writeRound.fields > 1
        ? `NOTE: all ${f.writeRound.fields} fields hold the text you sent (verified by read-back); nothing else on screen changed.`
        : "NOTE: the text is in the field (verified by read-back); nothing else on screen changed.";
    }
    // A frozen signature only proves the TEXT view is identical — measured geometry
    // (a resize, a reorder, a pan) is still an effect and must not be denied.
    if ((afterAction === "click" || afterAction === "drag" || afterAction === "keys") && f.geomChange) {
      return `NOTE: the element list and text are identical, but geometry changed: ${f.geomChange} — the ${afterAction} DID take effect; judge progress by the new size/position.`;
    }
    // Wait and blind come before repeat/round-trip, which claim no effect — unknowable on a blind
    // channel. The wait wording only for a round of NOTHING but waiting (`wait` is not counted in
    // actionsInRound): an action before it is judged as usual.
    if (afterAction === "wait" && f.actionsInRound === 0) return FROZEN_WAIT_NOTE;
    if (f.treeBlind) return FROZEN_BLIND_NOTE;
    if (f.repeated) return FROZEN_REPEAT_NOTE;
    if (f.actionsInRound > 1) return FROZEN_ROUNDTRIP_NOTE;
    return FROZEN_NOTE;
  }

  /**
   * Change signature: refs stripped (identity is what an element IS; some platforms re-mint
   * numbers), form values included (a fill changes values, not the element set). Blind to meaning
   * carried by pixels alone, which it calls `frozen`: `img` is not a collected role (BROWSER_ROLES
   * is controls only) and the excerpt reads text nodes plus ALT, so a swapped photo, a canvas/svg
   * redraw, a video frame or a color-only change only `screenshot()` settles. NOT blind to
   * geometry: rects are compared separately ({@link geometryChanges} → `lastGeomChange`) before
   * any no-effect wording, so a drag that moves things is handled — don't add a second one.
   */
  protected signature(s: Snapshot): string {
    const els = s.elements.map((e) => `${e.role}|${e.name}|${e.row ?? ""}|${e.state}`).join("\n");
    return `${s.url}\n${s.title}\n${els}\n${s.text}`;
  }
}
