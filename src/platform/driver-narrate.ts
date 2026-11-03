/**
 * How an observation is WORDED — the narration slice of {@link ComputerUseDriver}: a
 * {@link Snapshot} becomes the lines a model reads and the string that decides whether anything
 * changed. A base class rather than a helper module because every method is an override seam
 * (BrowserDriver extends renderHeadLines) and the wording rules cross-reference each other.
 *
 * It holds NO state: everything arrives as an argument. The observation state machine (verdicts,
 * ref bookkeeping, delta rounds) stays in driver.ts.
 */

import type { Element, HeaderChanges, ObservationCoverage, Snapshot, TargetIdentity, TargetInfo, ViewportPosition } from "./types.ts";

/** Group-label budget per observation (chars), priced over the groups SHOWN, not the
 * document-wide `Snapshot.groups`. x.com with five posts shows ~445 chars over 14 groups, so this
 * is headroom for pages labelling hundreds of rows. Past it groups are dropped and COUNTED, never
 * silently — a missing group must not read as "this control belongs to nothing". */
const GROUP_LABEL_BUDGET = 2000;

const FIRST_HEADER: HeaderChanges = { target: true, coverage: true, omissions: true, groups: true, ambiguity: true };

/** The surfaces line, or null when there is only one surface. Pure, so driver-render.ts can
 * build it to compare against the last one. */
export function targetsLine(targets: TargetInfo[]): string | null {
  if (targets.length <= 1) return null;
  // `own: false` is the user's tab: readable and actionable, but not this session's to close or
  // reuse. Marked per surface, because a caveat lines away from the id gets skipped.
  const line = targets.map((x) => `${x.active ? "*" : ""}${x.id}:${x.title.slice(0, 40)}${x.own === false ? "(user's)" : ""}`).join("  ");
  return targets.some((x) => x.own === false)
    ? `${line}\n  (user's) = a tab that was already open — work in it if the task is about it, but it is not yours to close`
    : line;
}

/** What {@link ComputerUseDriverNarrate.frozenNote} needs to know about the round, read off the driver's
 * observation state by the caller. */
export interface FrozenFacts {
  /** Pixels the last scroll measurably moved, when the round was a scroll. */
  scrollMoved: number | null;
  /** The last set_text round's write account (fields, read-back verified, closing step). */
  writeRound: { fields: number; verified: number; ended: string | null } | null;
  /** Measured geometry change on this observation, if any. */
  geomChange: string | null;
  /** The same action (kind + main args) twice in a row. */
  repeated: boolean;
  /** How many actions this run dispatched before the observation. More than one means the
   * verdict is about the run's NET effect, not about the last verb. */
  actionsInRound: number;
  /** The verdict's read channel cannot SEE this surface's content (macOS: a window publishing
   * only its own chrome), so the verdict is no evidence either way. */
  treeBlind: boolean;
}

/** Up to this many blank-row refs are named individually; past it the note reports a count. */
const BLANK_REFS_NAMED = 6;

export abstract class ComputerUseDriverNarrate {
  protected observationCoverage(s: Snapshot): ObservationCoverage {
    return {
      offscreen: s.meta.offscreen ?? s.offscreenElements?.length ?? null,
      covered: s.covered?.count ?? s.coveredElements?.length ?? null,
      capped: s.meta.capped ?? null,
      ...(s.covered?.modal ? { modal: s.covered.modal } : {}),
    };
  }

  protected targetLine(t: TargetIdentity): string {
    const app = t.application;
    const name = app ? `${app.name} ${app.version}` : "Electron app (identity/version not reported)";
    return `Target: ${name} | window ${t.windowId} | CDP ${t.endpoint}`;
  }

  /** Omission explanations are context, not a per-frame inventory: sent when their kind changes,
   * exact counts in observe().coverage. A scroll-position line already declares a clipped
   * viewport; a collector cap differs, since scrolling cannot recover what the read dropped. */
  protected notListedNote(m: Snapshot["meta"], positionStated: boolean): string | null {
    const parts: string[] = [];
    if (m.offscreen && !positionStated) parts.push(this.offscreenNote(m.offscreen));
    // No cap VALUE: the cap is per-platform; exact omitted counts live in coverage.
    if (m.capped) parts.push("some controls exceed this observation's element cap (narrow your target, or read the page)");
    return parts.length ? `NOTE: not in the list below — ${parts.join("; ")}.` : null;
  }

  /** The offscreen half of {@link notListedNote}. The structure stays in the base, but "how to
   * reach them" is platform truth: a page's offscreen elements sit in a document, region or frame,
   * a native window's in none (page scroll advice is meaningless on an AppKit window). */
  protected offscreenNote(_count: number): string {
    return "offscreen controls (find() searches them and actions scroll them into view)";
  }

  /** Where the viewport sits in the document — the ONE computation behind every scroll-position
   * statement, so no two lines can disagree about it. */
  protected viewportPosition(m: Snapshot["meta"]): ViewportPosition {
    const viewportH = Math.max(1, m.viewportH);
    const maxScrollY = Math.max(0, m.docH - viewportH);
    // Screens overlap, so scrollY / viewportH never reaches `total`: anchor on the scroll extent.
    // At the bottom we ARE on the last screen, and "scroll" there sends the model after nothing.
    const atBottom = m.scrollY >= maxScrollY - 1;
    const total = Math.max(1, Math.ceil(m.docH / viewportH));
    return {
      scrollY: Math.round(m.scrollY),
      viewportH: Math.round(viewportH),
      docH: Math.round(m.docH),
      maxScrollY: Math.round(maxScrollY),
      belowFold: Math.round(Math.max(0, maxScrollY - m.scrollY)),
      atBottom,
      screen: atBottom ? total : Math.min(total, Math.floor(m.scrollY / viewportH) + 1),
      total,
    };
  }

  /** Header lines; override for platform layout. `targetsUnchanged` is decided by the CALLER,
   * which may remember (this slice may not). The ids are how a model switches surface, but an
   * unchanged list (~470 chars on a nine-surface desktop) need not repeat: `computer.surfaces()`
   * returns it on demand. */
  protected renderHeadLines(s: Snapshot, targets: TargetInfo[], targetsUnchanged = false, changes = FIRST_HEADER): string[] {
    const lines: string[] = [];
    if (s.target && changes.target) lines.push(this.targetLine(s.target));
    lines.push(`Title: ${s.title} | ${s.url}`);
    if (targetsLine(targets)) {
      lines.push(targetsUnchanged
        ? `Targets: ${targets.length} surfaces, the same list as the last observation — computer.surfaces() lists them again`
        : `Targets: ${targetsLine(targets)} (switch with focus(id), or act through the surface's handle)`);
    }
    // The list is viewport-clipped whenever the page scrolls AT ALL, so say so whenever it does:
    // "no line" reads as "this is the whole page".
    const pos = this.viewportPosition(s.meta);
    // Read by the omission note so it never restates this line.
    const positionStated = pos.maxScrollY > 0;
    if (positionStated) {
      if (s.meta.docH > pos.viewportH * 1.5) {
        lines.push(`Screen ${pos.screen}/${pos.total} (elements below are current viewport only${pos.atBottom ? "" : "; scroll to see more"})`);
      } else {
        // A screen counter oversells a page barely taller than the viewport (an 8px body margin
        // makes ~16px of scroll); the remainder in pixels is self-describing.
        const more = pos.belowFold > 0 ? `; ${pos.belowFold}px below the fold — scroll to see the rest` : "";
        lines.push(`Partial view (elements below are current viewport only${more})`);
      }
    }
    // Describe the active layer without telling a caller to dismiss it. The task may be
    // inside that layer, or already complete. A blocked action names its obstruction itself.
    if (changes.coverage && s.covered?.count && s.covered.modal) {
      // A declared modal: the listed controls ARE the dialog's. Say where the rest went, no advice.
      lines.push(`Scope: «${s.covered.modal}» dialog; covered background controls are omitted.`);
    } else if (changes.coverage) {
      lines.push("Scope: window's visible controls.");
    }
    // What the list does not show stays outside the action-effect baseline. A count
    // changing does not prove a click landed, nor warrant repeating the same explanation.
    const notListed = this.notListedNote(s.meta, positionStated);
    if (notListed && changes.omissions) lines.push(notListed);
    // A missing ⟨row⟩ must not read as "unambiguous", so both disjoint causes are stated, each
    // with the channel that helps: `rowsCut` is a BUDGET drop (the text exists, it was not sent),
    // `rowBlank` means the page has no separating text at all.
    if (s.meta.rowsCut && changes.ambiguity) {
      const one = s.meta.rowsCut === 1;
      lines.push(`NOTE: ${s.meta.rowsCut} same-named or unnamed element${one ? "" : "s"} `
        + `below ${one ? "carries" : "carry"} no ⟨row⟩ context (this observation's row budget ran out) — tell `
        + `${one ? "it" : "them"} apart with page() before acting on ${one ? "it" : "one"}.`);
    }
    // The page author's own grouping, one line per card. In the HEAD: labels carry live counts
    // (x.com view counts), and a body line that changes by itself would defeat the frozen verdict.
    // Narrowed to LISTED refs here, not at collection (scripts group off-viewport controls); a
    // group wholly off screen goes uncounted, like an off-viewport element — only budget drops count.
    const shown = new Set(s.elements.map((e) => e.ref));
    const groups: { label: string; members: string[] }[] = [];
    let groupChars = 0, groupsCut = 0, groupsFull = false;
    for (const g of s.groups ?? []) {
      const members = g.members.filter((r) => shown.has(r));
      if (!members.length) continue;
      if (groupsFull || groupChars + g.label.length > GROUP_LABEL_BUDGET) { groupsCut++; groupsFull = true; continue; }
      groupChars += g.label.length;
      groups.push({ label: g.label, members });
    }
    if (groups.length && changes.groups) {
      lines.push(`GROUPS (${groups.length}):`);
      for (const g of groups) lines.push(`  ⟨${g.label}⟩ ${g.members.join(" ")}`);
    }
    if (groupsCut && changes.groups) {
      const one = groupsCut === 1;
      lines.push(`NOTE: ${groupsCut} more labelled group${one ? "" : "s"} `
        + `${one ? "was" : "were"} dropped at this observation's group budget — page() reads one region's `
        + "structure in full.");
    }
    const blank = s.elements.filter((e) => e.rowBlank).map((e) => e.ref);
    if (blank.length && changes.ambiguity) {
      // Refs by name while few ("e2, e3" is the whole answer), a count past the cap. Not pointed at
      // page(): the separating text does not exist. Singular when one (a lone unlabelled input).
      const which = blank.length <= BLANK_REFS_NAMED
        ? blank.join(", ")
        : `${blank.length} same-named or unnamed elements`;
      const one = blank.length === 1;
      lines.push(`NOTE: ${which} ${one ? "carries" : "carry"} no ⟨row⟩ context — the page has no text that `
        + `sets ${one ? "it" : "them"} apart, so a page read will not add any; tell ${one ? "it" : "them"} apart `
        + `by position (screenshot()), or by ${one ? "its place" : "their order"} in the list below.`);
    }
    return lines;
  }

  /** One element as the model reads it — the ONE place an element becomes a line, shared by the
   * viewport list and the query result, and the exact string the delta diff runs over. Row
   * context sits BEFORE the state bracket: `stripFocus` anchors on a trailing " [focused]", and
   * anything appended after it would make every focus move a -/+ pair (hence the query result
   * groups matches under headers instead of annotating lines). */
  protected elementLine(e: Element): string {
    return `${e.ref}: ${e.role}${e.name ? ` "${e.name}"` : ""}`
      + `${e.id && e.id.toLowerCase() !== e.name.trim().toLowerCase() ? ` ⟨id: ${e.id}⟩` : ""}`
      + `${e.help ? ` ⟨help: ${e.help}⟩` : ""}`
      + `${e.row ? ` ⟨row: ${e.row}⟩` : ""}${e.state ? ` [${e.state}]` : ""}`;
  }

  /** A surviving ref changed state; do not describe it as a removed and newly added control. */
  protected changedElementLine(before: Element, after: Element): string {
    if (before.role === after.role && before.name === after.name && before.id === after.id && before.help === after.help) {
      return `~ ${this.elementLine({ ...after, state: "" })}: [${before.state || "none"}] → [${after.state || "none"}]`;
    }
    return `~ ${this.elementLine(before)} → ${this.elementLine(after).slice(after.ref.length + 2)}`;
  }

  /** The covered lines the baseline carries — decided only here, so the full render asks
   * instead of re-deriving the body's shape. */
  protected coveredBaselineLines(s: Snapshot): string[] {
    if (!s.coveredElements?.length) return [];
    return s.coveredElements.map((e) => this.elementLine(e));
  }

  /** The diffable content lines: elements, then covered elements, then the excerpt; no labels
   * or headers. The covered block is a DIFF BASELINE only, never printed (`renderObservation`
   * skips it by length): its lines match the clickable ones, so being covered is not a change.
   * The blocks stay contiguous and in this order, because the full render slices by it. */
  protected renderBodyLines(s: Snapshot): string[] {
    const lines = s.elements.map((e) => this.elementLine(e));
    lines.push(...this.coveredBaselineLines(s));
    if (s.text) lines.push(...s.text.split("\n"));
    return lines;
  }

}
