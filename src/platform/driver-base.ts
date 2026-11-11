/**
 * ComputerUseDriverBase — the one abstraction (template method). The base owns the shared
 * observation pipeline (rendering, change verdict, ref bookkeeping, standard wording); subclasses
 * supply platform primitives and declare extras. The factories in tools/ build every tool from any
 * driver, so cross-platform consistency comes from that shared code, not from tests.
 *
 * A driver is created at bootstrap but connects lazily: no browser/device I/O before the first
 * primitive call.
 */

import type {
  ActResult,
  OwnershipResource,
  ScopedShot,
  ShotScope,
  Snapshot,
  SnapshotCapture,
  TargetInfo,
  ToolResult,
  VerbSpec,
  Verdict,
} from "./types.ts";
import { text } from "./types.ts";
import { CHROMIUM_DIAGNOSTICS, DiagnosticsBuffer, type DiagnosticsAbout } from "./driver-diagnostics.ts";
import { ComputerUseDriverRender } from "./driver-render.ts";


import { settleAfterStateAction } from "./driver-settle.ts";

/** Ceiling on one primitive read (snapshot / screenshot / full text) — see {@link ComputerUseDriver.bounded}. */
const OBSERVE_TIMEOUT_MS = 15_000;

export abstract class ComputerUseDriverBase extends ComputerUseDriverRender {
  /** Per-call execution policy, not proof that the user granted desktop permission. */
  interactionMode: "background" | "desktop" = "background";
  abstract override readonly platform: string;

  // ── Primitives (subclass must implement) ────────────────────────────────────

  /** Read the current a11y state as a numbered element list. */
  protected abstract snapshot(): Promise<Snapshot>;
  /** Raw image bytes in the format {@link screenshotMimeType} declares; never assume PNG. */
  abstract screenshot(): Promise<Buffer>;
  /** Scoped capture — one element (ref), a region, or the full scrollable page. The base refuses
   * rather than answer with the full frame; drivers that can scope override. Scoped shots are for
   * looking: they never advance the change-verdict ring or re-ground point actions. */
  screenshotScoped(_scope: ShotScope): Promise<ScopedShot> {
    return Promise.reject(new Error(`scoped screenshots are not supported on ${this.platform}`));
  }
  abstract readText(): Promise<string>;
  abstract listTargets(): Promise<TargetInfo[]>;
  abstract focusTarget(id: string): Promise<ActResult>;
  /** Execute one act verb (universal or extra) with its raw arguments. */
  abstract perform(kind: string, args: Record<string, unknown>): Promise<ActResult>;
  abstract close(): Promise<void>;
  /** A host records native executors before they can receive input. */
  onExecutorStart?: (pid: number) => Promise<void>;
  private readonly disconnectListeners = new Set<() => void | Promise<void>>();
  onDisconnect(listener: () => void | Promise<void>): void { this.disconnectListeners.add(listener); }
  protected async disconnected(): Promise<void> {
    for (const listener of this.disconnectListeners) await listener();
  }

  /** Resources held from the first bound read through explicit handoff or turn end. */
  async ownershipResources(): Promise<OwnershipResource[]> {
    const target = await this.activeTarget();
    if (!target) throw new Error("No active target to claim; list and bind a surface first.");
    return [{ key: `${this.platform}:${target}`, mode: "exclusive" }];
  }

  /** Prepare a selected target only after the REPL has acquired its ownership resources. */
  async prepareTarget(): Promise<void> {}

  /** Additional shared-input resources required by an action, held with its target. */
  async actionResources(_kind: string, _args: Record<string, unknown>): Promise<OwnershipResource[]> {
    return [];
  }

  /** A handoff invalidates observations: another caller may edit before we return. */
  invalidateObservation(): void { this.resetObservationState(); }
  async releaseInputResources(): Promise<void> {}
  /** The runtime went idle (its claims are being released): let go of what only a running task
   *  needs. The next bind must work as before, re-acquiring whatever this gave up. */
  async releaseIdle(): Promise<void> {}

  // ── Declared variance (subclass overrides) ──────────────────────────────────

  /** Extra act verbs beyond the universal set (open_url, swipe, ax_action, ...). */
  extraVerbs(): VerbSpec[] {
    return [];
  }

  /** Grounding teaching — the host's MCP initialize `instructions` (entries/mcp.ts). */
  abstract promptFragment(): string;

  /** Platform interaction constraints that must survive API-reference summarization. */
  interactionNotes(): readonly string[] {
    return [];
  }

  /** MIME type of screenshot()'s bytes (jpeg on browser, png where capture is lossless). PUBLIC:
   * whoever persists or re-serves them takes extension and MIME from HERE — strict model APIs
   * reject a declared MIME that disagrees with the bytes, though viewers hide it. Atomic captures
   * may override it per image (SnapshotCapture.image carries its own mimeType). */
  readonly screenshotMimeType: string = "image/jpeg";

  /** Default drivers collect structure first and pixels only when requested. Drivers
   * with an atomic structure+image API override this to keep both views coherent. */
  protected async captureSnapshot(): Promise<SnapshotCapture> {
    return { snapshot: await this.snapshot() };
  }

  /** Bound one primitive read: a half-dead CDP session (client killed mid-navigation) leaves
   * `page.evaluate` waiting FOREVER — playwright sets no timeout — hanging every later call. A
   * timeout fails this read honestly; drivers re-acquire dead connections on the next call. */
  protected async bounded<T>(what: string, run: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([run, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${OBSERVE_TIMEOUT_MS / 1000}s — `
          + "the result is unknown. Re-observe before continuing; do not replay a preceding mutation.")), OBSERVE_TIMEOUT_MS);
        timer.unref();
      })]);
    } finally { clearTimeout(timer); }
  }

  // ── Shared observation pipeline (the template) ──────────────────────────────

  protected prevSig: string | null = null;
  /** Element-only signature of the last observation: the full one includes page text, which a
   * countdown timer churns every second, so verdicts would read "changed" forever. */
  protected prevElSig: string | null = null;
  /** {@link prevElSig} with the focus marker stripped — "did anything SUBSTANTIVE change".
   *  What {@link settleAfterStateAction} compares against, since focus moves on every click. */
  protected prevElSigSubstantive: string | null = null;
  /** Signatures of the last two dispatched actions (repeat-action escalation). */
  protected lastActionSig: string | null = null;
  /** The ref the last dispatched action targeted, if it named one (the settle skip in driver.ts). */
  protected lastActionRef: string | null = null;
  protected prevActionSig: string | null = null;
  /** Actions since the last verdict-bearing observation (once per repl run). A frozen verdict
   * over several is about the NET effect, never "your last action did nothing". */
  protected actionsInRound = 0;
  /** A window/popup changed outside the current snapshot. Kept through intermediate reads
   * until the next rendered observation, so an unchanged parent is not called a failed action. */
  protected pendingSurfaceChange = false;
  /** Measured px of the LAST scroll, when the driver measures it (browser does): tells a dead
   * scroll from a uniform list whose rows all look alike. */
  protected lastScrollMoved: number | null = null;
  /** The LAST action round (one repl verb call), set by the act tool: fields written, fields read
   * back holding the sent text, last non-write step (`keys Enter`) or null. A verified write must
   * not be blamed by a frozen screen, or models abandon set_text for select-all+delete loops. */
  protected writeRound: { fields: number; verified: number; ended: string | null } | null = null;
  /** ref→rect of the previous element observation. Element lines carry no coordinates, so the
   * no-effect and frozen wordings consult geometry before accusing a move/resize of nothing. */
  protected lastRects: Map<string, { x: number; y: number; w: number; h: number }> | null = null;
  /** The previous element observation's scroll offset: a viewport that moved is an effect. */
  protected lastScrollY: number | null = null;

  /** Record one dispatched action (the act tool calls this per action). Feeds the repeat
   * escalation: frozen + same signature as the previous action ⇒ {@link FROZEN_REPEAT_NOTE}. */
  noteAction(kind: string, args: Record<string, unknown>): void {
    // A `wait` acts on nothing, so it is never a "repeat" or blamed in diagnostics; it still
    // clears the observes counter (a waiting run is not looking in circles).
    if (kind === "wait") {
      this.observesSinceAction = 0;
      return;
    }
    this.prevActionSig = this.lastActionSig;
    this.lastActionRef = typeof args.ref === "string" ? args.ref : null;
    const main = ["ref", "name", "x", "y", "text", "chord", "direction", "to", "url", "option", "target", "ms", "package"]
      .map((k) => `${args[k] ?? ""}`)
      .join("|");
    // `then` holds a sequence's later steps; without this digest two DIFFERENT sequences share a
    // signature and the second is accused of repeating.
    const then = Array.isArray(args.then)
      ? args.then.map((s) => {
          const st = s as { do?: string; ref?: string; text?: string; option?: string; chord?: string };
          return `${st.do ?? ""}:${st.ref ?? ""}=${st.text ?? st.option ?? st.chord ?? ""}`;
        }).join(",")
      : "";
    this.lastActionSig = `${kind}|${main}|${then}`;
    this.actionsInRound++;
    this.observesSinceAction = 0;
    // Only an error after this moment can be this action's doing (driver-diagnostics.ts
    // `markAction`); never `wait`, or open_url → wait → look would pin load errors on the wait.
    if (kind !== "wait") this.diag?.markAction();
  }

  /** Record the round the repl's action just performed (see {@link writeRound}). Called once per
   * action call, after the last step ran — never per step. */
  noteWriteRound(round: { fields: number; verified: number; ended: string | null }): void {
    this.writeRound = round;
  }


  /** Drop all observation continuity — refs, change signatures, the delta base. Call it when the
   * surface is REPLACED (browser relaunched, device switched): the next observation is full. */
  protected resetObservationState(): void {
    this.prevSig = null;
    this.prevElSig = null;
    this.prevElSigSubstantive = null;
    this.forgetRefs();
    this.lastRects = null;
    this.lastScrollY = null;
    this.pendingSurfaceChange = false;
    this.resetRenderState();
  }

  /** Optional: drivers with an audit journal record frozen verdicts there, or a journal of
   * ok:true dispatches reads as progress while nothing on screen changed. */
  protected journalVerdict?(verdict: Verdict): void;

  /** Optional deep-content read (`page()`): the page's content tree
   * with a completeness receipt. Only drivers with a structural DOM implement it. */
  readPage?(opts: { ref?: string; depth?: number; node?: string }): Promise<ToolResult>;

  /** Optional single-element read (`value()`): ONE control's full value, which a listing clips,
   * without `readText()`'s whole surface (on an app holding the user's content, all of it).
   * Drivers that cannot answer for one element leave it undefined; the tool layer says so. */
  readValue?(ref: string): Promise<string>;

  /** Optional: is the element this ref named still on the surface? A ref stays KNOWN after its
   * node is re-rendered away (refs accumulate), so a find() handle asks this before it trusts its
   * ref, and re-finds by name when the answer is no. One cheap lookup, no walk; a driver that
   * cannot answer without a walk leaves it undefined and its handles keep trusting a known ref. */
  refLive?(ref: string): Promise<boolean>;

  /** Compare a read-back value using the platform's text representation. */
  valueMatches(actual: string, expected: string): boolean { return actual === expected; }

  // ── Diagnostics channel (opt-in) ─────────────────────────────────────────────

  /** Whether this platform can FEED diagnostics (chromium via page listeners, macos via the
   * helper's log). Enabling is the tool layer's call, opt-in per session: the channel taxes the
   * resident tool surface and helps only a caller that can read source. */
  readonly supportsDiagnostics: boolean = false;

  /** Does a read include what is NOT on screen ({@link Snapshot.offscreenElements}, which
   * `readElements` merges with an `offscreen` flag so `find(name)` reaches it)? DECLARED, not
   * inferred: the model's API reference is built from it, and promising "whole surface" where only
   * the viewport is searched wastes the model's calls. A viewport-only platform sets it false. */
  readonly readsOffscreen: boolean = true;

  protected diag: DiagnosticsBuffer | null = null;
  /** Start collecting (idempotent). The tool factory calls it when the session opts in. */
  enableDiagnostics(): void {
    if (this.supportsDiagnostics && !this.diag) this.diag = new DiagnosticsBuffer(this.diagnosticsAbout);
  }
  /** What this platform's diagnostics actually carry — the channel says it in its own words, and
   *  a platform that feeds it something else than a page's console MUST override this. */
  get diagnosticsAbout(): DiagnosticsAbout {
    return CHROMIUM_DIAGNOSTICS;
  }
  /** Where platform listeners push events; null while disabled — attach nothing then. */
  protected get diagnosticsSink(): DiagnosticsBuffer | null {
    return this.diag;
  }
  /** Where the surface is right now, cheaply — no walk. The base cannot say (an app window has
   *  no url), and a platform that can overrides it. */
  async currentUrl(): Promise<string> {
    return "";
  }

  /** `diagnostics()` — counts + recent entries, or one full entry by id. The current url goes
   *  with it so entries left behind by a navigation are marked as such. */
  async readDiagnostics(opts: { id?: string } = {}): Promise<ToolResult> {
    if (!this.diag) return text("diagnostics are not enabled for this session", { error: "diagnostics_off" });
    return this.diag.render(opts.id, await this.currentUrl().catch(() => ""));
  }

  /** Lines that must survive a trimmed observation (`computer_repl`'s `observation` argument)
   * beyond those kept by position. Override for text delivered ONCE: taking it marks it
   * delivered, so a trim that dropped it would lose it for the session. */
  protected trimSurvivors(): string[] {
    return [];
  }

  /** A one-shot fact for the next tool result ("the browser was closed; a fresh one is up"). It
   * rides observations as well as actions: a model that only observes after a reopen would
   * otherwise see a blank page unexplained. */
  protected takePendingNote(): string | null {
    return null;
  }

  /** {@link takePendingNote} for a result that renders NO observation (the repl's skipped one):
   *  without it the fact waited for the next observation that did, after the model had acted. */
  takeNoteForResult(): string | null {
    return this.takePendingNote();
  }

  protected takeSurfaceChange(): boolean {
    const changed = this.pendingSurfaceChange;
    this.pendingSurfaceChange = false;
    return changed;
  }

  /** The target the next action lands on — the id `listTargets` marks active. Surface handles
   * (tools/repl.ts) ask before every verb, so a bound verb never lands elsewhere after the driver
   * moved on its own (popup adopted, window closed). Override if listing is expensive. */
  async activeTarget(): Promise<string | null> {
    return (await this.listTargets()).find((t) => t.active)?.id ?? null;
  }

  /** Is `id` already the active target? Asked before every verb; a `false` costs a re-bind. The
   * base compares ids; a platform listing one target under TWO names must override (macOS: a
   * not-running app by bundle id, the same app once running as `pid:window`). */
  async isActiveTarget(id: string): Promise<boolean> {
    return (await this.activeTarget()) === id;
  }

  /** A standing caveat about the TARGET LISTING (a missing OS grant, say), read after
   * `listTargets()`. Unlike {@link takePendingNote} it is not one-shot, and it rides
   * `computer.surfaces()`, which no pending note reaches. */
  targetsNote(): string | null {
    return null;
  }
}
