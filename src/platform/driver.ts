/**
 * `ComputerUseDriver` — the class every platform extends: what an observation LOOKS like once a
 * round is over. Under it: narration (`driver-narrate.ts` → `driver-verdict.ts`), the ref and
 * selection slices, and `driver-base.ts` (platform primitives, round bookkeeping, waits,
 * diagnostics).
 *
 * This is the TEMPLATE: `observeElements` and `observeImage` are the two ways a round ends, and
 * every judgement the model reads (verdict, delta, frozen note, geometry fallback) is assembled
 * here. A platform overrides the primitives, never this.
 */

import type {
  ScopedShot,
  ShotScope,
  Snapshot,
  SnapshotCapture,
  TargetInfo,
  ToolResult,
  Verdict,
} from "./types.ts";
import { SurfaceGoneError, SurfaceUnreadableError, text } from "./types.ts";

import { type FrozenFacts } from "./driver-narrate.ts";
import { OBSERVE_FROZEN_NOTE } from "./driver-lines.ts";
import {
  disclosureClosed,
  effectAlreadyShown,
  elementSignature,
  onlyRefsLost,
  settleAfterStateAction,
  STATE_CHANGING_ACTIONS,
  substantiveElementSignature,
} from "./driver-settle.ts";
import { ComputerUseDriverWaits } from "./driver-waits.ts";
import type { PreviewTarget } from "./types.ts";

/** Re-exported because `tools/` may import only `driver.ts` and `types.ts`, and `find` needs the
 *  same set the observation's settle uses. */
export { STATE_CHANGING_ACTIONS } from "./driver-settle.ts";

/** Roles whose click only places the caret (combobox is out: its click opens a list). */
const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox"]);

export abstract class ComputerUseDriver extends ComputerUseDriverWaits {
  /** Prepended to every surface id the observation's `Targets:` line names. computer_repl sets it
   *  (`macos/`) when several platforms are mounted, because there a bare driver id such as
   *  `9469:22613` names nothing and `computer.surface()` only resolves the prefixed one. */
  surfaceIdPrefix = "";
  /** The host's optional observer, absent in standalone drivers and tests. */
  onPreview?: (target: PreviewTarget, at: number) => void;
  protected previewTarget(): Promise<PreviewTarget | null> { return Promise.resolve(null); }

  publishPreview(kind?: string, args: Record<string, unknown> = {}): void {
    if (!this.onPreview || this.permissionRefusal) return;
    const at = Date.now();
    const rect = typeof args.ref === "string" ? this.lastRects?.get(args.ref) : undefined;
    const x = typeof args.x === "number" ? args.x : rect ? rect.x + rect.w / 2 : undefined;
    const y = typeof args.y === "number" ? args.y : rect ? rect.y + rect.h / 2 : undefined;
    // Fire-and-forget: a frozen renderer or an unavailable observer cannot slow the caller.
    void this.previewTarget().then((target) => {
      if (target && !this.permissionRefusal) this.onPreview?.({ ...target,
        ...(kind && x !== undefined && y !== undefined ? { pointer: { x, y, kind, ts: at } } : {}) }, at);
    }).catch(() => {});
  }
  /** Caller-provided task description for app consent; scoped to one REPL call. */
  consentPurpose: string | null = null;
  /** A permission refusal must also prevent the automatic end-of-call observation. */
  permissionRefusal: string | null = null;
  /**
   * Host lifecycle edge, mirroring Codex Computer Use's hidden `turn_ended` tool. Platforms may
   * clean resources owned by this session; the default is deliberately a no-op for generic MCP
   * clients and for surfaces where closing the user's application would be unsafe.
   */
  async turnEnded(_info: { sessionId: string; turnId: string; hookEventName: string; keepBrowserTabs?: boolean }): Promise<void> {}

  /**
   * Record the element state an action starts from, when no observation of this surface has.
   *
   * The settle re-check (driver-settle.ts) compares against the previous observation, and a tab
   * switch rightly drops that — so the first click after one had nothing to compare with and
   * rendered the instant after the click. Measured on a controlled checkbox that flips 400 ms
   * later: reported `[unchecked]` while the page went on to `checked`. One extra read, paid only
   * when the baseline is missing and the action can change state; a failed read leaves it
   * missing, as before.
   */
  async ensureSettleBaseline(kind: string): Promise<void> {
    if (!STATE_CHANGING_ACTIONS.has(kind) || this.prevElSigSubstantive !== null) return;
    try {
      const { snapshot } = await this.bounded("observe", this.captureSnapshot());
      this.prevElSigSubstantive = substantiveElementSignature(snapshot.elements);
    } catch {
      // No baseline means no re-check — the behaviour this only improves on.
    }
  }

  async observeElements(opts: { prefix?: string; forceImage?: boolean; afterAction?: string } = {}): Promise<ToolResult> {
    let capture: SnapshotCapture;
    try {
      capture = await this.bounded("observe", this.captureSnapshot());
    } catch (e) {
      this.prevSig = null;
      this.takeSurfaceChange();
      this.forgetDeltaBase(); // continuity is gone — the next successful observation renders full
      // Before the rethrows: those are exactly the states where a later ref refusal would
      // otherwise blame a navigation that never happened.
      this.noteObserveFailure((e as Error).message);
      // Gone / unreadable surfaces reach the tool layer whole: flattened into "(observe failed)"
      // a model reads them as "try again" and loops.
      if (e instanceof SurfaceGoneError) throw e;
      if (e instanceof SurfaceUnreadableError) throw e;
      // The prefix is the caller's ACTION LEDGER and a failed read must not eat it; the pending
      // note goes too (e.g. "app was just launched for you", which explains a missing window).
      const failed = `(observe failed: ${(e as Error).message})`;
      const pending = this.takePendingNote();
      const said = [opts.prefix, pending ? `NOTE: ${pending}.` : "", failed].filter(Boolean).join("\n");
      // Every line IS the action ledger, so both counts cover the whole text; otherwise
      // `trimObservation` would cut it to zero.
      const all = said.split("\n").length;
      return text(said, { verdict: "unknown", actionLines: all, headLines: all });
    }
    // Let a server-driven change land before the notes below call it "nothing changed"
    // (driver-settle.ts). Pays only when no substantive change shows, or things only went GONE —
    // and not when the effect is already on screen where that comparison does not look.
    // Not after a click INTO a text field: it changes only the focus, which the comparison
    // strips, so the re-check would always run out its budget (measured: 1.3 s against 26 ms).
    const clicked = opts.afterAction === "click" && this.lastActionRef !== null
      ? capture.snapshot.elements.find((e) => e.ref === this.lastActionRef) : undefined;
    if (STATE_CHANGING_ACTIONS.has(opts.afterAction ?? "") && !(clicked && TEXT_ENTRY_ROLES.has(clicked.role))) {
      const prevRefs = this.lastRects ? new Set(this.lastRects.keys()) : null; // the previous observation's refs
      const prevFull = this.prevElSig, prevScrollY = this.lastScrollY, action = opts.afterAction ?? "";
      capture = await settleAfterStateAction({
        capture,
        previous: this.prevElSigSubstantive,
        signature: (c) => substantiveElementSignature(c.snapshot.elements),
        unsettled: (prev, c) => {
          const els = c.snapshot.elements;
          const scrolled = prevScrollY !== null && Math.abs(c.snapshot.meta.scrollY - prevScrollY) >= 3;
          if (prev === substantiveElementSignature(els)) {
            return !effectAlreadyShown({
              action,
              target: els.find((e) => e.ref === this.lastActionRef) ?? els.find((e) => e.state.startsWith("focused")),
              scrolled,
              focusMoved: prevFull !== null && prevFull !== elementSignature(els),
              geometryMoved: this.geometryChanges(c.snapshot) !== null,
            });
          }
          // Refs lost to a scroll went off screen; they are not a menu mid-close.
          if (scrolled || prevRefs === null || !onlyRefsLost(prevRefs, els)) return false;
          // Lost from the FLOW, with the survivors moved into the gap (a row deleted, a list
          // filtered), is a finished effect: measured, each such click paid the whole budget.
          // An overlay that closes moves nothing, and that is the shape whose next thing may
          // still be mounting — as is any close a disclosure trigger reports, reflow or not.
          return this.geometryChanges(c.snapshot) === null || disclosureClosed(prevFull, els);
        },
        recapture: () => this.bounded("observe", this.captureSnapshot()),
      });
    }
    const snap = capture.snapshot;
    this.publishPreview();
    const sig = this.signature(snap);
    const surfaceChanged = this.takeSurfaceChange();
    const verdict: Verdict | null = surfaceChanged ? "changed"
      : this.prevSig === null ? null : this.prevSig === sig ? "frozen" : "changed";
    this.prevSig = sig;
    // Element identity and state ONLY — never `row`: row text with a live field (elapsed time,
    // unread count) would churn this on every observation, so the "observations without acting"
    // nudge would never fire and the swallowed-click check in renderObservation would see a fake
    // change.
    const elSig = elementSignature(snap.elements);
    const elFrozen = this.prevElSig !== null && this.prevElSig === elSig;
    this.prevElSig = elSig;
    this.prevElSigSubstantive = substantiveElementSignature(snap.elements);
    this.lastGeomChange = this.geometryChanges(snap);
    this.lastRects = new Map(snap.elements.map((e) => [e.ref, e.rect]));
    this.lastScrollY = snap.meta.scrollY;
    this.rememberRefs(snap);
    if (verdict === "frozen") this.journalVerdict?.("frozen");

    const actionsInRound = this.takeActionsInRound();
    // A round that only READ content (text / page / screenshot / diagnostics): its screen is
    // unchanged by construction, so the frozen wording's re-observe advice does not apply.
    const contentRound = !opts.afterAction && this.takeContentRead();
    let head = opts.prefix ?? "";
    const pending = this.takePendingNote();
    if (pending) head += (head ? "\n" : "") + `NOTE: ${pending}.`;
    if (verdict === "frozen" && !contentRound) {
      head += (head ? "\n" : "") + (opts.afterAction ? this.frozenNote(opts.afterAction, this.frozenFacts(actionsInRound)) : OBSERVE_FROZEN_NOTE);
      const extra = this.frozenExtra();
      if (extra) head += `\n${extra}`;
    }
    // After the frozen wording on purpose: when the page's own code broke, this corrects "try a
    // different element". The url lets the note blame an action only if no navigation intervened.
    const diagNote = this.diag?.takeNote(snap.url);
    if (diagNote) head += (head ? "\n" : "") + diagNote;
    // 3+ model-initiated observes of a page that is not changing: the looking IS the problem, so
    // say so in the observation, the one channel guaranteed to be read. Judged on ELEMENTS (timer
    // text churns the full verdict forever).
    if (!opts.afterAction && !contentRound && !surfaceChanged && ++this.observesSinceAction >= 3 && (verdict !== "changed" || elFrozen)) {
      head += (head ? "\n" : "")
        + `NOTE: ${this.observesSinceAction} observations in a row without acting, and the actionable elements are not changing — `
        + "more looking will not reveal more. Act now (click / set_text / drag / scroll), or if the target truly is not on this screen, scroll or switch target.";
    }
    const listed = await this.listTargets().catch(() => []);
    const targets = this.surfaceIdPrefix ? listed.map((t) => ({ ...t, id: `${this.surfaceIdPrefix}${t.id}` })) : listed;
    const { body, obsKind, headLines, effectNote } = this.renderObservation(snap, targets, verdict, { ...opts, surfaceChanged });

    // `details` is the machine-readable half of the observation, so an auditor can check it
    // against the prose. It does NOT reach the model, by design: the MCP entry answers with the
    // `content` blocks alone (entries/mcp.ts).
    const result = text(head ? `${head}\n${body}` : body, {
      url: snap.url, verdict, elementCount: snap.elements.length, obsKind,
      headLines: (head ? head.split("\n").length : 0) + headLines,  // all lines before the listing
      // Lines ABOUT THIS ACTION (the caller's journal plus this driver's notes); the rest of the
      // head describes the LISTING. @see tools/repl.ts `trimObservation`.
      actionLines: head ? head.split("\n").length : 0,
      // Lines no trim may eat: once-delivered knowledge would otherwise be consumed and dropped,
      // and the swallowed-action note must never be hidden.
      keep: [...this.contextKeep, ...this.trimSurvivors(), ...(effectNote ? [effectNote] : [])],
      coverage: this.observationCoverage(snap),
      ...(snap.target ? { target: snap.target } : {}),
      viewport: this.viewportPosition(snap.meta),
      ...(snap.meta.offscreen || snap.meta.capped
        ? { notListed: { offscreen: snap.meta.offscreen ?? 0, capped: snap.meta.capped ?? 0 } }
        : {}),
    });
    if (opts.forceImage) {
      const image = capture.image ?? await this.screenshot()
        .then((bytes) => ({ bytes, mimeType: this.screenshotMimeType }))
        .catch(() => null);
      if (image) {
        result.content.push({ type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType });
      }
    }
    return result;
  }

  /** Rect changes since the previous observation, as a short phrase ("e3 resized 110×80 →
   * 110×62"): first two, then a count. Null under 3px (jitter rounds to ±1; real gestures move
   * tens). By ref, so only elements present in BOTH observations. */
  private geometryChanges(snap: Snapshot): string | null {
    const prev = this.lastRects;
    if (!prev) return null;
    const parts: string[] = [];
    let more = 0;
    const r = (n: number) => Math.round(n);
    for (const e of snap.elements) {
      const p = prev.get(e.ref);
      if (!p) continue;
      const resized = Math.abs(e.rect.w - p.w) >= 3 || Math.abs(e.rect.h - p.h) >= 3;
      const moved = Math.abs(e.rect.x - p.x) >= 3 || Math.abs(e.rect.y - p.y) >= 3;
      if (!moved && !resized) continue;
      if (parts.length >= 2) { more++; continue; }
      parts.push(resized
        ? `${e.ref} resized ${r(p.w)}×${r(p.h)} → ${r(e.rect.w)}×${r(e.rect.h)}`
        : `${e.ref} moved (${r(p.x)},${r(p.y)}) → (${r(e.rect.x)},${r(e.rect.y)})`);
    }
    if (parts.length === 0) return null;
    return parts.join(", ") + (more ? ` (+${more} more)` : "");
  }

  /** A platform fact to add when nothing changed — and ONLY then. Advice for a failure must not
   *  ride a success. */
  protected frozenExtra(): string | null {
    return null;
  }

  /**
   * Why a surface the caller NAMED is not in the list — the platform's answer, or null. The
   * allow-list filters BEFORE the match, so a running app the session may not see would read as
   * "no surface matches"; the platform that filtered says so instead.
   */
  explainMiss(_query: string): string | null {
    return null;
  }

  /**
   * A surface the caller NAMED that the listing cannot carry — the platform's row for it, or null.
   * macOS answers an installed, not-running app by bundle id: such apps are never listed (no
   * bounded set), yet binding one is how the user gets asked to clear it.
   */
  async unlistedTarget(_query: string): Promise<TargetInfo | null> {
    return null;
  }

  /**
   * Whether this session holds no surface at all, on a platform that can open one from nothing
   * (the browser's open_url / new_tab): "closed" when it closed its own last one, "not-yet" when
   * it has opened or bound none. Null everywhere else, and whenever a surface is held. The repl
   * uses it to let openUrl / newTab start a fresh surface on a handle whose own is gone.
   */
  async heldNothing(): Promise<"closed" | "not-yet" | null> {
    return null;
  }

  /** Milliseconds this driver has spent waiting on the USER (a consent prompt). A run's time cap
   *  measures the surface, not a person deciding, so computer_repl subtracts it (tools/repl.ts). */
  waitedOnUserMs = 0;

  /** One tool call is over (called after its observation): consent granted with no `persist`
   *  ends here. */
  endCall(): void {}

  /** Can this read channel see the surface's content at all right now? Answer false where the
   *  channel is structurally blind to it — then the frozen verdict stops being evidence and the
   *  wording says so instead of denying an effect. @see FrozenFacts.treeBlind */
  protected treeBlind(): boolean {
    return false;
  }

  /** Read the run's action count and start the next one. Called once per verdict-bearing
   *  observation, whatever the verdict, so a changed round does not leak into the next. */
  private takeActionsInRound(): number {
    const n = this.actionsInRound;
    this.actionsInRound = 0;
    return n;
  }

  /** The facts {@link frozenNote} words from — read once per round, never held by the narrator. */
  private frozenFacts(actionsInRound: number): FrozenFacts {
    return {
      scrollMoved: this.lastScrollMoved,
      writeRound: this.writeRound,
      geomChange: this.lastGeomChange,
      repeated: this.lastActionSig !== null && this.lastActionSig === this.prevActionSig,
      actionsInRound,
      treeBlind: this.treeBlind(),
    };
  }

  /** A screenshot read: the whole surface, or a scoped shot that answers with capture facts. */
  async observeImage(opts: { prefix?: string; scope?: ShotScope; modelInitiated?: boolean } = {}): Promise<ToolResult> {
    // Screenshots count toward the push-to-act nudge too: a screenshot spree is the costliest
    // way to look in circles.
    const nudge = opts.modelInitiated && !this.takeContentRead() && ++this.observesSinceAction >= 3
      ? `\nNOTE: ${this.observesSinceAction} observations in a row without acting — more looking will not reveal more; act (click / set_text / drag / scroll) before looking again.`
      : "";
    if (opts.scope) {
      let shot: ScopedShot;
      try {
        shot = await this.bounded("screenshot", this.screenshotScoped(opts.scope));
      } catch (e) {
        if (e instanceof SurfaceGoneError || e instanceof SurfaceUnreadableError) throw e;
        return text(`(screenshot failed: ${(e as Error).message})`, { error: "shot_failed" });
      }
      return {
        content: [
          {
            type: "text",
            text: `Screenshot captured (${shot.note}). Scoped shots are for looking — `
              + "point coordinates for actions live in FULL screenshots; use the returned mapping when provided, or act by ref."
              + nudge,
          },
          { type: "image", data: shot.bytes.toString("base64"), mimeType: shot.mimeType },
        ],
        details: { scoped: true, bytes: shot.bytes.length, ...(shot.capture ? { capture: shot.capture } : {}) },
      };
    }
    const buf = await this.bounded("screenshot", this.screenshot());
    this.takeSurfaceChange();
    this.takeActionsInRound();
    let head = opts.prefix ?? "";
    const pending = this.takePendingNote();
    if (pending) head += (head ? "\n" : "") + `NOTE: ${pending}.`;
    const diagNote = this.diag?.takeNote(await this.currentUrl().catch(() => ""));
    if (diagNote) head += (head ? "\n" : "") + diagNote;
    return {
      content: [
        { type: "text", text: `${head ? `${head}\n` : ""}Screenshot captured. Anything without a ref can be acted on by x/y coordinates from this image.${nudge}` },
        { type: "image", data: buf.toString("base64"), mimeType: this.screenshotMimeType },
      ],
      details: { verdict: null, bytes: buf.length },
    };
  }

  async observeFullText(): Promise<ToolResult> {
    const t = await this.bounded("read text", this.readText());
    // Empty is ambiguous (not rendered yet vs no text); naming the likely cause keeps the model
    // on the cheapest whole-page read instead of falling back to scrolling.
    return text(t || "(no readable text — the page may still be rendering; wait, then observe again)", { chars: t.length });
  }

}
