/** Shared types — one file. */

import type { TSchema, Static } from "typebox";

/** Observer-only identity of a window or tab the agent has actually reached. */
export interface PreviewTarget {
  kind: "browser" | "electron" | "macos";
  targetId: string;
  title: string;
  url: string;
  appName: string;
  capture: { type: "cdp"; endpoint: string; targetId: string }
    | { type: "macos"; app: string; pid: number; windowId: number };
  pointer?: { x: number; y: number; kind: string; ts: number };
}

/** One video frame of a preview target. */
export interface PreviewFrame {
  mimeType: "image/png" | "image/jpeg";
  /** base64 */
  data: string;
  /** In the target's own coordinates (CSS pixels for a page), the space `pointer` is in. */
  width: number;
  height: number;
  capturedAt: number;
}

/** What one preview stream reports about its target (preview.ts). */
export interface PreviewSink {
  frame(frame: PreviewFrame): void;
  status(status: { unavailable: string | null; icon?: string }): void;
  /** The target no longer exists (its page was closed). */
  gone(): void;
}

/** Read-only video of one target; each platform with a capture route has one (registry.ts). */
export interface PreviewStream {
  tick(): Promise<void>;
  dispose(): void;
}

// ── Tool shapes ───────────────────────────────────────────────────────────────

/** The fixed tool surface — the same two names on every platform. A repl result
 *  ends in an observation like an act did (its `details.ledgerLines` says how many leading
 *  lines are the run's action ledger). */
export const TOOL_NAMES = ["computer_repl", "computer_repl_reset"] as const;


export interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: Record<string, unknown>;
}

/**
 * One tool. `description` (with the schema) is all an MCP host (Claude Code / Codex) sees, so
 * guidance a host must have belongs in `description` or the observation text.
 */
export interface ComputerUseToolSpec<T extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  parameters: T;
  execute(params: Static<T>): Promise<ToolResult>;
}

/** Erase the schema generic so specs can live in one array. */
export function spec<T extends TSchema>(s: ComputerUseToolSpec<T>): ComputerUseToolSpec {
  return s as unknown as ComputerUseToolSpec;
}

/**
 * The surface the agent was driving is GONE and must not be recreated (the user closed the
 * window, the device went away). Nothing to retry, so the tool answers with a stop instruction.
 * Never replace the surface behind the user's back: it fights them and hides the fact from the
 * model.
 */
export class SurfaceGoneError extends Error {
  readonly surfaceGone = true;
}

/**
 * The surface is THERE but cannot be READ right now (locked screen, window minimised or on
 * another Space, display asleep); the same target answers again once that is over. The tool
 * answers with the reason, because an empty observation reads to a model as "this app has no
 * controls".
 */
export class SurfaceUnreadableError extends Error {
  readonly surfaceUnreadable = true;
}

export function text(t: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: t }], details };
}

// ── Grounding ─────────────────────────────────────────────────────────────────

/** How observations ground actions: text element refs, screenshot coordinates, or both. */

/** An operable surface: tab, window, app (device later). Ids are stable for the
 * session — unlike element refs, which are re-minted on every observation. */
export interface TargetInfo {
  id: string;
  kind: "tab" | "window" | "app" | "device";
  title: string;
  active: boolean;
  /**
   * This is the surface an APP-level query means — the app's own focused or main window.
   * `computer.surface('<bundle id>')` names one app, so a second open window must not turn it into
   * an ambiguity refusal; where a platform cannot say which window is primary, the refusal stands.
   */
  primary?: boolean;
  /**
   * `false` = the surface is the USER'S, not this session's: readable and actable, never
   * closable, not scratch space. In the browser bridge the listed tabs are all of the user's
   * while the session may close only what it opened or claimed; unmarked, a model would recycle a
   * tab the person is working in. Absent means the distinction does not arise on that platform.
   */
  own?: boolean;
  /**
   * `true` = THIS runtime opened or claimed the surface (its session tab, a tab it opened, a named
   * tab it adopted). Narrower than {@link own}: every tab of a managed browser is closable, but
   * one an earlier session left open is not this one's work. `computer.surface()` with no
   * argument binds by it. Absent where the distinction does not arise on that platform.
   */
  mine?: boolean;
  /** Chrome unloaded this tab's renderer. Bound operations restore it after ownership is held. */
  unloaded?: boolean;
}

/**
 * The HOST's way to put a question to its user — MCP elicitation, supplied by the entry that owns
 * the protocol (entries/mcp.ts). A driver asks through it before it touches something the user has
 * not cleared (a macOS app); it never learns how the host asks, or where the answer is kept.
 */
export interface UserConsent {
  /** Can this host ask right now? False for a client that declared no elicitation support. */
  available(): boolean;
  /** Ask once. `meta` rides the request's `_meta` so a host can act on WHAT is asked rather than
   *  on the prose. Resolves with the answer, how long it holds (`persist`, the Codex Computer Use
   *  field: absent = this action only), and the host's optional reason for a non-accept. */
  ask(message: string, meta: Record<string, unknown>): Promise<{ allowed: boolean; persist?: "session" | "always"; reason?: string }>;
  /** Subscribe to the host taking clearances back (`notifications/mirasim-computer-use/revoke`). */
  onRevoke(cb: (ids: string[]) => void): void;
}

/** An extra verb a driver adds beyond the universal ones (e.g. open_url, ax_action), bound in
 * the repl under its camelCase name and via `act(kind, …)`. The schema is one full branch of the
 * action union, including a literal `kind`. */
export interface VerbSpec {
  kind: string;
  schema: TSchema;
  /** Read-shaped platform verbs return facts without claiming a visible action. */
  readOnly?: boolean;
}

// ── Observation shapes ────────────────────────────────────────────────────────

export interface Element {
  ref: string; // e.g. "e12"; valid only within the snapshot that produced it
  role: string; // normalized: link | button | textbox | checkbox | ...
  name: string; // display-caliber name (may include inferred icon hints; never used to veto an action)
  state: string; // form state, e.g. "filled:foo" | "empty" | "checked" | ""
  /**
   * The app developer's own id for this control (macOS `AXIdentifier`), for `find`: on a
   * localised interface the NAME is what goes wrong, and this handle does not move. It is NOT a
   * name — nothing on screen shows it, so never look for it in a screenshot. Rendered as
   * `⟨id: …⟩` only when it differs from the name (Finder uses a file row's filename as its id).
   */
  id?: string;
  /**
   * The control's tooltip (macOS `AXHelp`): what it DOES, where the name says what it is called.
   * Dropped when it repeats the name or sits on nearly every control. Rendered as `⟨help: …⟩`.
   */
  help?: string;
  rect: { x: number; y: number; w: number; h: number };
  /**
   * The text of the row/card this element sits in, when the name alone cannot identify it (three
   * `button "Delete"`, a nameless input). Present only for a same-named group or an empty name,
   * within the row budget — absence means "the name is enough", never "there is no row".
   * Rendered as `⟨row: …⟩`. OUT of the element-change signature (`elSig`): page text that moves
   * on its own must never read as an element changing.
   */
  row?: string;
  /**
   * This element NEEDED row context and the page had none to give. Distinct from `row` being
   * absent ("the name is enough") and from a budget drop (`meta.rowsCut`, recoverable by reading
   * the page). Surfaced as a header note (`renderHeadLines`), never on the element line; out of
   * the element-change signature, like `row`.
   */
  rowBlank?: boolean;
  /**
   * What covers THIS element, on `Snapshot.coveredElements` only. `covered.top` is the cover of
   * the most controls, which is a different overlay for a control under a lone strip. Out of the
   * element-change signature, like `row`.
   */
  coveredBy?: string;
  /** The ref of that cover, when the cover is itself a listed control (a floating button). Absent
   *  for a layer that is not one (a backdrop, a sticky bar). Out of the signature like `coveredBy`. */
  coveredByRef?: string;
}

/** Presentation changes only; these never enter the action-effect signature. */
export interface HeaderChanges {
  target: boolean;
  coverage: boolean;
  omissions: boolean;
  groups: boolean;
  ambiguity: boolean;
}

/** Connection facts reported by the target, never inferred from a helper's install path. */
export interface TargetIdentity {
  transport: "cdp";
  endpoint: string;
  windowId: string;
  application?: { name: string; version: string };
}

/** Exact omission counts remain available even when their prose has already been shown. */
export interface ObservationCoverage {
  /** null means this collector does not report the count. */
  offscreen: number | null;
  covered: number | null;
  capped: number | null;
  modal?: string;
}

/** One page heading: its text, level (1–6, 0 when the page gives none) and box. */
export interface Heading {
  name: string;
  level: number;
  rect: { x: number; y: number; w: number; h: number };
}

export interface Snapshot {
  url: string; // browser: page URL; other drivers: a stable locus id
  title: string;
  target?: TargetIdentity;
  elements: Element[];
  /**
   * Elements found OUTSIDE the viewport, same shape, y-sorted, with live refs (a click scrolls
   * one into view). SEPARATE from `elements` because the ref cap and row budget are priced over
   * what the model is SHOWN. Absent = the driver does not separate them; empty = none.
   */
  offscreenElements?: Element[];
  /**
   * Elements dropped from `elements` because an overlay covers their center point; separate like
   * {@link Snapshot.offscreenElements}. Kept as the DIFF BASELINE: a covered element is not a
   * removal, else opening a full-screen dialog would force a full re-render on open and close.
   */
  coveredElements?: Element[];
  /**
   * Labelled containers the elements sit in ("which card is this control part of"): one per
   * container with a non-empty `aria-label` (never `aria-labelledby`: already in the page read)
   * holding a collected element; each element in at most ONE, the nearest. One string per card
   * (x.com's post row: "4448 replies, … 1405 bookmarks"), often data found nowhere else.
   * DOCUMENT-WIDE like {@link offscreenElements}. Rendered in the HEAD, never the diffable body:
   * the labels carry live numbers that would make a frozen observation read as changed.
   */
  groups?: { label: string; members: string[] }[];
  /** The page's headings with boxes in `rect` coordinates, for layout scripts to measure against
   *  (chromium/headings.ts). Returned by observe(), never rendered. Web surfaces only. */
  headings?: Heading[];
  text: string; // short body/context excerpt
  /** `offscreen` / `capped`: elements found but not in the list — outside the viewport, past the
   *  ref cap. Absent = not counted, zero = none; only a non-zero count is rendered. `offscreen`
   *  is DERIVED from {@link Snapshot.offscreenElements} where filled, so the rendered count can
   *  never disagree with a query over those elements. */
  meta: { scrollY: number; viewportH: number; docH: number; offscreen?: number; capped?: number;
    /** Set when the read stopped before covering the surface (macOS: the AX walk's read budget):
     *  a short reason. What it did not reach is unknown, so a miss there is not an absence. */
    partial?: string;
    /** Same-named/nameless elements whose `row` context was dropped at the row budget. */
    rowsCut?: number;
    /**
     * State marks (nearly) every listed element carries, stated once in the header instead of
     * per line: a shared mark cannot say which element to act on. Set by drivers that render
     * such marks (macos: advertised AX actions); the header wording is the driver's, the same seam
     * as {@link ComputerUseDriverNarrate.offscreenNote}.
     */
    sharedMarks?: string[] };
  /** Elements omitted because an unrelated element intercepts their click point.
   * `top` names the most common blocker for ref diagnostics. Only a declared modal
   * changes the observation's scope; transient overlap is not a new active layer. */
  covered?: { count: number; top: string;
    /** Every covered element sits behind this open modal dialog (its name) — the page's own
     *  declaration that the dialog is where interaction is, so the notice informs, not advises. */
    modal?: string };
}

/**
 * Where the viewport sits in the document. Derived once in the driver base class so every
 * statement about scroll position comes from one expression and they cannot disagree.
 * A page that fits reads `maxScrollY: 0, belowFold: 0, atBottom: true, screen: 1, total: 1`.
 */
export interface ViewportPosition {
  scrollY: number;
  viewportH: number;
  docH: number;
  /** Scroll extent: how far the page CAN scroll. 0 ⇒ the element list is the whole page. */
  maxScrollY: number;
  /** Pixels still below the viewport from here. */
  belowFold: number;
  atBottom: boolean;
  /** 1-based screen index and the number of screens the document spans. */
  screen: number;
  total: number;
}

/** One atomic platform observation. A platform that returns structure and pixels from one
 * capture provides both, so an observation with a screenshot never invalidates its own refs with a second
 * screenshot. */
export interface SnapshotCapture {
  snapshot: Snapshot;
  image?: { bytes: Buffer; mimeType: string };
}

/** Scoped screenshot request — exactly one of the three. Region coordinates live in the
 * same space as a FULL screenshot of the surface (browser: CSS px of the viewport, the
 * space mouse actions share). */
export interface ShotScope {
  ref?: string;
  region?: { x: number; y: number; width: number; height: number };
  fullPage?: boolean;
  /** With `ref` only: px of surroundings kept on every side of the element — enough to see
   *  the row or card it sits in, which a crop to its own box never shows. */
  padding?: number;
}

/** One scoped capture: bytes plus the facts a caller needs to caption them honestly. */
export interface ScopedShot {
  bytes: Buffer;
  mimeType: string;
  /** What was actually captured, e.g. `element e12, 320×64 at (410,220)`. */
  note: string;
  /** Optional platform capture identity and coordinate mapping, returned to the script. */
  capture?: Record<string, unknown>;
}

/** Result of comparing two consecutive observations — the effect-evidence ring. */
export type Verdict = "changed" | "frozen" | "unknown";

/** Stable OS/CDP identities, never display names or a runtime's local window numbers. */
export interface OwnershipResource { key: string; mode: "shared" | "exclusive" }

export interface ActResult {
  /** Whether the action was dispatched. Not a claim about its effect — that is the observation's job. */
  ok: boolean;
  note?: string;
  /** Extra facts for the action journal, merged into the published line (e.g. scroll's
   * measured `moved` px and the `container` it acted on) — measurements, never claims. */
  journal?: Record<string, unknown>;
  /** What a read-shaped verb (`run_js`, `download`) computed, whole and unserialized — handed back to the
   *  calling script as a value, while `note` carries only a clipped preview for the journal. */
  value?: unknown;
  /** Read-back verdict of a write: true = the field holds the sent text, false = it does NOT,
   * undefined = cannot be read back here. One explicit `false` in a write round blocks a queued
   * submit — Enter over a rejected value commits the wrong thing. */
  verified?: boolean;
  /**
   * `ok: false`, but the call DID go out and the surface may have acted anyway, so the tool layer
   * must re-observe. Only for a failure the platform reported after dispatch, never for a refusal
   * decided here (stale ref, unmet precondition): those never reached the surface. E.g. macOS
   * `AXShowMenu` on Chrome's address bar can answer AXError -25204 and open the menu ~800 ms later.
   */
  mayHaveActed?: boolean;
}

