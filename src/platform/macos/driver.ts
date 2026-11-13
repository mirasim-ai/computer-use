/**
 * MacosDriver — ComputerUseDriver over native macOS applications through the Accessibility API, via
 * the resident Swift helper in `ax/` ({@link AxHelperProcess}).
 *
 * An external process behind a seam the tests stub; tree first with pixels as fallback;
 * screenshots scaled on the helper's side with points mapped back here; app LIFECYCLE
 * (launch/quit) only through explicit verbs, never on the driver's own initiative.
 *
 * Three rulings:
 *
 *   - **Actions are AX actions and they land in the BACKGROUND.** `click` is `AXPress` on the
 *     element, `set_text` is `AXSetValue`, a key goes to ONE pid. A synthesised mouse event is
 *     the LAST rung (click-verb.ts): a real click raises the user's window and takes their
 *     cursor, so it runs only when AX cannot do the job, and every note it writes says so.
 *   - **Document shortcuts can stay in the background.** The helper temporarily establishes
 *     app-local activation and a key window, with input protection, then restores that state.
 *     Remote panels retain the explicit foreground path. Nothing activates the system's app
 *     on its own; `activate` still deliberately takes the user's foreground and keyboard.
 *   - **Identity is the bundle id.** Localised names (Calculator on a Chinese Mac) are display only.
 *
 * A TARGET is a window (`<pid>:<CGWindowID>`); refs are minted per snapshot and mapped to the
 * helper's per-walk element keys. A ref from an older snapshot fails as `stale_key`, never
 * resolved by position (that presses the wrong element).
 * Rects are window-local points; a model point read off the last screenshot is scaled back with
 * the helper's `scale` before it is hit-tested.
 */

import { MacosDriverTargets } from "./driver-targets.ts";
import type { DiagnosticsAbout } from "../driver-diagnostics.ts";
import { MACOS_VERBS } from "./extra-verbs.ts";
import { ElementActs, type AxCall } from "./act-element.ts";
import type { ActResult, HeaderChanges, OwnershipResource, PreviewTarget, Snapshot, TargetInfo, UserConsent, VerbSpec } from "../types.ts";
import { AxHelperProcess, type AxHelperOptions, type AxTransport } from "./ax-client.ts";
import { menuChord, menuVerb, normalizeChord, pasteVerb, type MenuHost } from "./menu-commands.ts";
import { COLLAPSED_FRAME_HINT, dragVerb, hoverVerb, PressMemory, type MouseHost } from "./mouse.ts";
import { clickVerb } from "./click-verb.ts";
import { waitQuiet } from "./press-rungs.ts";
import { selectTextVerb } from "./select-text-verb.ts";
import { scrollVerb } from "./scroll-verb.ts";
import { typeVerb } from "./type-verb.ts";
import {
  offscreenWindowNote,
  promptFragmentFor,
  selfDrawnWindowNote,
  sharedMarksNote,
  staleRefCauseNote,
} from "./narrate.ts";
import { SAVE_PANEL_NOTE, appNote } from "./app-notes.ts";
import { MACOS_INTERACTION_NOTES } from "./interaction-notes.ts";
import { DesktopInteractionRequired, clipboardChord } from "./interaction-policy.ts";
import { PANEL_SERVICE_BUNDLE } from "./ax-shapes.ts";
import { MacosApprovals } from "./approvals.ts";
import { findInstalledApps, type AppNameResolver } from "./app-names.ts";

/** `toldAbout` key for the Save panel note; not a bundle id, so no app can collide with it. */
const SAVE_PANEL = "#save-panel";

export interface MacosDriverOptions {
  /** Embedders must obtain scoped permission before choosing desktop input. */
  interaction?: "background" | "desktop";
  /** Bundle id of the app to drive when the caller binds nothing (tests and embedders; a HOST
   *  names the app per call with `computer_repl`'s `target`). */
  bundle?: string;
  env?: NodeJS.ProcessEnv;
  /** The host's way to ask its user whether an app may be driven — @see MacosDriverApps.authorize. */
  consent?: UserConsent;
  /** Test seam: a canned transport makes the driver fully hermetic. */
  transport?: AxTransport;
  /** Test seam: how an app NAME becomes installed bundle ids (default: the app folders, then
   *  Spotlight — @see app-names.ts). */
  appsNamed?: AppNameResolver;
  helper?: AxHelperOptions;
}

export class MacosDriver extends MacosDriverTargets {
  private pointerHeld = false;
  override async releaseInputResources(): Promise<void> {
    if (!this.pointerHeld) return;
    const result = await this.perform("pointer_release", {});
    if (!result.ok) throw new Error(result.note || "Could not release the held pointer");
  }
  protected override previewTarget(): Promise<PreviewTarget | null> {
    const app = this.app;
    const windowId = this.windowId;
    if (!app || windowId === null || !this.cleared(app.bundle)) return Promise.resolve(null);
    return Promise.resolve({ kind: "macos", targetId: `${app.pid}:${windowId}`,
      title: this.frame?.title || app.name, appName: app.name,
      url: `macos:${app.bundle}:${windowId}`,
      capture: { type: "macos", app: app.bundle, pid: app.pid, windowId } });
  }
  readonly platform = "macos";
  override readonly screenshotMimeType: string = "image/png";

  override async ownershipResources(): Promise<OwnershipResource[]> {
    const { pid } = await this.ensure();
    const app = `macos:app:${pid}`;
    return this.windowId === null ? [{ key: app, mode: "exclusive" }] : [
      { key: `macos:window:${pid}:${this.windowId}`, mode: "exclusive" },
      { key: app, mode: "shared" },
    ];
  }

  override async actionResources(kind: string, args: Record<string, unknown>): Promise<OwnershipResource[]> {
    const pointer = ["click", "hover", "drag", "scroll", "activate", "pointer_move", "pointer_press", "pointer_release", "paste"].includes(kind);
    const keyboard = ["keys", "type", "select_text"].includes(kind) || (kind === "menu" && !!args.path);
    if (!pointer && !keyboard) return [];
    const { pid } = await this.ensure();
    // Background mode refuses the desktop routes before dispatch (DESKTOP_INPUT_OPS); what is
    // left (AX, keys posted to the pid, `backgroundkey`) must not claim the desktop, or it fails
    // whenever another session holds it. `pointer_release` does: the release is a real mouse-up.
    const desktop = this.interactionMode === "desktop" ? pointer || kind === "keys" || kind === "menu"
      : kind === "pointer_release";
    return [{ key: `macos:app:${pid}`, mode: "exclusive" },
      ...(desktop ? [{ key: "macos:desktop-input", mode: "exclusive" as const }] : [])];
  }

  protected readonly ax: AxTransport;
  protected readonly wantBundle: string | undefined;
  /** `COMPUTER_USE_MACOS_FALLBACK_APPS` (comma-separated): the apps a host that CANNOT ask may
   *  drive, or null when unset (the standalone CLI, where the user IS the operator). Under a host
   *  that can ask, these are cleared up front. @see MacosDriverApps.authorize */
  protected readonly fallback: Set<string> | null;
  protected readonly hostApps: ReadonlySet<string>;
  protected readonly consent: UserConsent | null;
  protected readonly stored: MacosApprovals;
  protected readonly appsNamed: AppNameResolver;
  /** The menu verbs (menu-commands.ts) reach the helper and the target only through this. */
  private readonly menu: MenuHost = {
    checkCommand: async (pid, item) => {
      if (this.interactionMode === "background"
          && (((item.mods & 8) === 0 && /^[cxv]$/i.test(item.cmd)) || await this.menu.isFrontmost(pid))) {
        throw new DesktopInteractionRequired(`menu ${item.path}`);
      }
    },
    call: (op, params) => this.call(op, params),
    walk: () => this.walk(),
    appName: () => this.app!.name,
    windowId: () => this.windowId,
    keyPostedAt: (at) => { this.lastKeyAt = at; },
    closeWindow: async (pid) => {
      await this.call("closewindow", { pid, ...(this.windowId !== null ? { window: this.windowId } : {}) });
      this.windowId = null;
    },
    raiseWindow: async (pid) => this.windowId === null ? false
      : (await this.call<{ raised?: boolean }>("raisewindow", { pid, window: this.windowId })).raised === true,
    // Asked fresh: `this.app` is a snapshot from resolution time, and an `activate` may have
    // happened one call ago.
    isFrontmost: async (pid) => (await this.lookup({ pids: [pid] }))[0]?.active === true,
    refForKey: (key) => this.acts.refForKey(key),
    startedHere: (pid) => this.startedHere(pid),
    keyPid: (pid) => this.keyPid(pid),
  };

  /** Where a key event goes: the app, unless its focused element is owned by another process (a
   *  remote Open/Save panel — `focusedElement` in ax-tree.swift). No `pid` field, no focus: the app.
   *
   *  The one route by which an action lands in a DIFFERENT process, so it is authorized against
   *  what it reaches. The system's Open/Save panel service acts for the bound app and rides its
   *  clearance; any other owner is authorized as the app it is. */
  private async keyPid(pid: number): Promise<number> {
    let owner = await this.call<{ element: { pid?: number } }>("focused", { pid }).then((r) => r.element.pid ?? pid, () => undefined);
    // A background app often reports no focus; its Open/Save panel is then found in its window
    // list (`panelservice`). An older helper lacks the op, and its error reads as "no panel".
    if (owner === undefined) {
      owner = await this.call<{ pid: number }>("panelservice", { pid }).then((r) => r.pid || pid, () => pid);
    }
    if (typeof owner !== "number" || owner <= 0 || owner === pid) return pid;
    const app = (await this.lookup({ pids: [owner] }))[0];
    if (app && app.bundle !== PANEL_SERVICE_BUNDLE) await this.authorize(app.bundle, app.name);
    return owner;
  }

  private async typingChannel(pid: number): Promise<{ to: number; call: AxCall }> {
    const to = await this.keyPid(pid);
    const background = to === pid && !(await this.menu.isFrontmost(pid));
    return { to, call: <T>(op: string, params?: Record<string, unknown>) => {
      if (background && op === "type") {
        return this.call<T>("backgroundtype", { ...params, window: this.windowId });
      }
      return this.call<T>(op, params);
    } };
  }
  /** The mouse (mouse.ts) reaches the helper and the last walk's geometry only through this. */
  private readonly mouse: MouseHost = {
    call: (op, params) => this.call(op, params),
    pid: () => this.app!.pid,
    appName: () => this.app!.name,
    rectOf: (ref) => {
      const r = this.rects.get(ref);
      return r && this.frame ? { x: this.frame.x + r.x, y: this.frame.y + r.y, w: r.w, h: r.h } : null;
    },
    toScreen: (x, y) => this.toScreen(x, y),
    // A ref the walk found OUTSIDE the window has a real frame, but a pointer sent there lands on
    // somebody else's window. Read from the WALK's classification, never re-derived from
    // geometry: a second opinion from the same numbers can only disagree.
    offWindow: (ref) => this.offscreenRefs.has(ref),
    walk: async () => (await this.walk()).mapped.elements,
    listing: () => this.lastListed,
    minted: () => this.refCount,
    bundle: () => this.app!.bundle,
    hadWeb: () => this.lastWalkHadWeb(),
    pointerAllowed: () => this.interactionMode === "desktop",
    flagCollapsedFrameRisk: () => { this.collapsedFrameRisk = true; },
    memory: new PressMemory(),
  };
  /** When this driver last posted a key event. `type` waits out `TYPE_AFTER_KEY_MS` from it: a
   *  field that commits on Enter hands focus on asynchronously, and a character posted into that
   *  gap is swallowed silently (type-verb.ts). */
  private lastKeyAt = 0;
  /** Everything that acts on ONE ref-named element — the ref table included (act-element.ts). */
  protected readonly acts = new ElementActs((op, params) => this.call(op, params));
  /** A one-shot fact for the next tool result (the base's {@link takePendingNote} hook). */
  private pendingNote: string | null = null;
  /** The app pack this observation just delivered, held until the trim hook can claim it. */
  protected appNoteThisRound: string | null = null;
  /** Bundles whose `app-notes.ts` entry has been delivered this session, including ones that have
   *  none, so a noteless app costs one lookup per session. */
  protected readonly toldAbout = new Set<string>();

  constructor(opts: MacosDriverOptions = {}) {
    super();
    this.interactionMode = opts.interaction ?? "background";
    const env = opts.env ?? process.env;
    // The helper's log is this platform's diagnostics channel. The sink is read at CALL time: the
    // tool layer enables it after the driver exists, and lines while it is off are not kept.
    this.ax = opts.transport
      ?? new AxHelperProcess({ env, onLog: (line) => this.diagnosticsSink?.push("helper", line), ...opts.helper,
        onStart: async (pid) => {
          await this.onExecutorStart?.(pid);
          await opts.helper?.onStart?.(pid);
        },
      });
    // Lets a helper error name the caller's ref instead of the helper's own key.
    this.ax.nameKeys = this.acts.nameKeys;
    this.ax.onReset = () => this.forgetHelper();
    this.wantBundle = opts.bundle?.trim() || undefined;
    const list = env.COMPUTER_USE_MACOS_FALLBACK_APPS;
    this.fallback = list === undefined ? null : new Set(list.split(",").map((s) => s.trim()).filter(Boolean));
    this.hostApps = new Set((env.COMPUTER_USE_HOST_APPS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    this.consent = opts.consent ?? null;
    this.stored = new MacosApprovals(env);
    this.appsNamed = opts.appsNamed ?? findInstalledApps;
    // Every action re-checks (MacosDriverApps.ensure), so dropping it here is all of revocation.
    this.consent?.onRevoke((ids) => this.revoke(ids));
  }

  /**
   * The resident helper's stderr is the only account of what went wrong INSIDE the platform (an
   * `activate` that returned false, an unserialisable reply). Never the app's own logs.
   */
  override readonly supportsDiagnostics = true;

  override get diagnosticsAbout(): DiagnosticsAbout {
    return {
      empty: "complaints from the accessibility helper (this platform's diagnostics are the helper's own log, never the app's)",
      header: "the macOS accessibility helper's own log — what went wrong inside the platform, not inside the app",
    };
  }

  /** Set by a by-ref mouse click (`mouse.ts`), spent by {@link frozenExtra}: the collapsed-frame
   *  advice is said only when nothing moved. */
  private collapsedFrameRisk = false;

  protected override frozenExtra(): string | null {
    const risked = this.collapsedFrameRisk;
    this.collapsedFrameRisk = false;
    // The hint is about a WEB VIEW collapsing a control's frame (mouse.ts §"COLLAPSED"); without
    // web content it sends the reader after a mechanism that cannot be there.
    return risked && this.lastWalkHadWeb() ? COLLAPSED_FRAME_HINT : null;
  }


  // ── Declared variance ───────────────────────────────────────────────────────

  /** @see extra-verbs.ts — the schemas themselves, lifted out for the read budget. */
  override extraVerbs(): VerbSpec[] {
    return MACOS_VERBS;
  }

  /** @see narrate.ts */
  protected override offscreenNote(count: number): string {
    return offscreenWindowNote(count, this.offscreenEmptyRows);
  }

  /**
   * The action marks the walk hoisted off the element lines (`meta.sharedMarks`), and, the first
   * time this session observes a given app, its `app-notes.ts` pack. Both are this platform's, so
   * appended here rather than in the base class.
   *
   * The note rides the observation TEXT, not a side channel: the observation is the one thing
   * every caller reads, on every path in. Once per bundle per session.
   */
  protected override renderHeadLines(s: Snapshot, targets: TargetInfo[], targetsUnchanged = false, changes?: HeaderChanges): string[] {
    const lines = super.renderHeadLines(s, targets, targetsUnchanged, changes);
    if (s.meta.sharedMarks?.length) lines.push(sharedMarksNote(s.meta.sharedMarks));
    const intro = this.takeIntro(s);
    if (intro) { lines.push(intro); this.appNoteThisRound = intro; }
    return lines;
  }

  /**
   * What this session is told ONCE about the app it just bound: that its window publishes nothing
   * but chrome (when the walk found that), then the app's own pack.
   *
   * One slot, because taking a note marks it said and {@link trimSurvivors} keeps a trimmed
   * observation from swallowing it. NOT the pending note: that is consumed by the first snapshot,
   * so a script's mid-run `observe()` would spend it on an observation nobody renders.
   */
  private takeIntro(s: Snapshot): string | null {
    const parts: string[] = [];
    if (this.takeBareWindow()) parts.push(selfDrawnWindowNote(this.app?.name ?? s.title, this.app?.webShell === true));
    const pack = this.takeAppNote();
    if (pack) parts.push(pack);
    // A Save panel can come up in any app, so its note keys on the panel, not on the bundle.
    if (!this.toldAbout.has(SAVE_PANEL) && s.elements.some((e) => e.id === "saveAsNameTextField")) {
      this.toldAbout.add(SAVE_PANEL);
      parts.push(SAVE_PANEL_NOTE);
    }
    return parts.length ? parts.join("\n") : null;
  }

  /** The app's pack is said ONCE per session, so a trimmed observation must still carry it (the
   *  base's hook). */
  protected override trimSurvivors(): string[] {
    const note = this.appNoteThisRound;
    this.appNoteThisRound = null;
    return note ? [note] : [];
  }

  /** The app's note, once (noteless bundles are remembered too). */
  private takeAppNote(): string | null {
    const bundle = this.app?.bundle;
    if (!bundle || this.toldAbout.has(bundle)) return null;
    this.toldAbout.add(bundle);
    return appNote(bundle);
  }

  protected override staleRefCause(): string {
    return staleRefCauseNote();
  }

  /**
   * A fallback list is the one mode where apps are filtered out of the listing rather than listed
   * by name. A bundle id is answered exactly ("not allowed" is a fact); a display name cannot be,
   * since apps outside the list are never enumerated, so only the list's existence is said.
   */
  override explainMiss(query: string): string | null {
    if (!this.fallback || this.asking) return null;
    const q = query.trim();
    if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){1,}$/.test(q) && !this.fallback.has(q)) return `mirasim-cu: ${this.notAllowed(q)}`;
    return "mirasim-cu: this session drives only a fixed list of apps, and an app outside it is not listed here at all — so a "
      + "missing name may be a running app rather than a closed one.";
  }

  override promptFragment(): string {
    return promptFragmentFor();
  }

  override interactionNotes(): readonly string[] {
    return MACOS_INTERACTION_NOTES;
  }

  protected override addNote(note: string): void {
    // Two facts can land on one result and neither may overwrite the other; but the SAME fact can
    // land twice (a round takes more than one walk, each re-counting what it folded), so dedupe.
    if (this.pendingNote === note || this.pendingNote?.endsWith(` Also: ${note}`)) return;
    this.pendingNote = this.pendingNote ? `${this.pendingNote} Also: ${note}` : note;
  }

  protected override takePendingNote(): string | null {
    const note = this.pendingNote;
    this.pendingNote = null;
    return note;
  }


  /**
   * `wait({})`: by the app's own change notifications where its silence can be read, else the
   * base's poll over the text. @see waitQuiet
   */
  override async waitSettled(capMs = 16_000): Promise<ActResult> {
    await this.ensure();
    return await waitQuiet(this.mouse, capMs) ?? super.waitSettled(capMs);
  }

  /** The pids whose change notifications the helper is already listening to. */
  private readonly listening = new Set<number>();

  /**
   * Start listening to the app, so that a `wait({})` has something to go by. Once per pid for the
   * helper's life; best effort — an app or a helper that cannot be listened to is waited on by
   * polling instead.
   */
  private async listenTo(pid: number): Promise<void> {
    if (this.listening.has(pid)) return;
    this.listening.add(pid);
    // Straight to the transport: a refusal here (no grant yet, an old helper) is nobody's news,
    // and `call` would word it as the failure of whatever the caller was doing.
    await this.ax.request("watch", { pid, quietMs: 0, maxMs: 0 }).catch(() => undefined);
  }

  /** Listening starts before the first READ of an app, not only before the first action: some
   *  apps answer a read with changes of their own (System Settings), and an app first heard at
   *  its first click could not be told quiet by a `wait({})` that came before it. */
  protected override async walk(maxText?: number): ReturnType<MacosDriverTargets["walk"]> {
    const { pid } = await this.ensure();
    await this.listenTo(pid);
    return super.walk(maxText);
  }

  async perform(kind: string, raw: Record<string, any>): Promise<ActResult> {
    const before = this.dispatchedActions;
    try { return await this.performAction(kind, raw); }
    catch (e) {
      if (e instanceof DesktopInteractionRequired) {
        return { ok: false, mayHaveActed: this.dispatchedActions > before, note: e.message };
      }
      throw e;
    }
  }

  private async performAction(kind: string, raw: Record<string, any>): Promise<ActResult> {
    const a: Record<string, any> = { ...raw };
    // Before `ensure()`: the one verb that names its own app must work with nothing to resolve,
    // and must not resolve some OTHER app on the way.
    if (kind === "launch_app") return this.launch(String(a.bundle ?? ""));
    const { pid } = await this.ensure();
    await this.listenTo(pid);
    if (this.interactionMode === "background") {
      if (kind === "paste" || (kind === "keys" && clipboardChord(normalizeChord(String(a.chord ?? ""))))) {
        return { ok: false, note: new DesktopInteractionRequired(kind).message };
      }
      if (["keys", "type"].includes(kind) && await this.menu.isFrontmost(pid)) {
        return { ok: false, note: new DesktopInteractionRequired(`${kind} in the frontmost app`).message };
      }
      if (kind === "ax_action") {
        const target = this.acts.resolve(a.ref, a.name);
        if ("key" in target && target.role === "menuitem") {
          return { ok: false, note: "Use menu({path}) for menu items so the background policy can check their command and clipboard effects." };
        }
      }
    }
    switch (kind) {
      // AXPress first; a real mouse event when AXPress cannot say it (right, middle, double) or
      // demonstrably did nothing (mouse.ts; the cost: the app comes forward).
      case "click":
        return clickVerb(this.mouse, this.acts, a, Math.max(1, Math.min(3, a.count ?? 1)));
      case "drag":
        return dragVerb(this.mouse, this.acts, a);
      case "hover":
        return hoverVerb(this.mouse, this.acts, a);
      // The pointer's three acts (@see ax-pointer.swift): no AX rung, no evidence check, no cursor
      // restore. They are the hand, and the caller judges.
      case "pointer_move": {
        const at = this.toScreen(Number(a.x), Number(a.y));
        const r = await this.call<{ steps: number; dragging: boolean }>("ptrmove", { pid, ...at, ...(a.steps === undefined ? {} : { steps: Number(a.steps) }) });
        return { ok: true, note: `moved the pointer to ${Math.round(Number(a.x))},${Math.round(Number(a.y))} over ${r.steps} motion events${r.dragging ? " with the button still held (a drag)" : ""} and left it there — the user's cursor is now here` };
      }
      case "pointer_state": {
        const r = await this.call<{ x: number; y: number; down: boolean; owned: boolean; grabbed: boolean }>("ptrstate", {});
        // In the model's own coordinates (last screenshot's pixels), the space every point it
        // passes is measured in.
        const f = this.frame;
        const local = f && this.shotTaken
          ? ` = ${Math.round((r.x - f.x) / this.shotScale)},${Math.round((r.y - f.y) / this.shotScale)} in this window's screenshot`
          : " (no screenshot in this session yet, so there is no screenshot-space answer)";
        return {
          ok: true,
          note: `the pointer is at ${Math.round(r.x)},${Math.round(r.y)} on screen${local}`
            + `${r.owned ? "" : " — it has not been moved in this session, so that is simply where the user's cursor is"}`
            + `${r.down ? ", holding a button" : ""}${r.grabbed ? ", and the user's physical mouse is disconnected from the cursor until the release" : ""}`,
        };
      }
      case "pointer_press": {
        // A lost reply is uncertain: cleanup must still check whether the helper holds input.
        this.pointerHeld = true;
        const r = await this.call<{ button: string }>("ptrpress", { pid, button: String(a.button ?? "left") });
        return { ok: true, note: `pressed the ${r.button} button and is HOLDING it at the pointer's position — this can bring ${this.app!.name} to the front and change keyboard focus; activation was not verified. While held, the user's physical mouse is disconnected from the cursor; always pointer_release in finally (an idle hold also releases after 20 s)` };
      }
      case "pointer_release": {
        const state = await this.call<{ down: boolean }>("ptrstate", {});
        if (!state.down) {
          this.pointerHeld = false;
          return { ok: true, verified: true, note: "no button is held; no mouse-up was posted and the pointer was not moved" };
        }
        const r = await this.call<{ wasHolding: boolean }>("ptrrelease", { pid, button: String(a.button ?? "left") });
        this.pointerHeld = false;
        return { ok: true, note: r.wasHolding ? "released the button at the tracked pointer position" : "no button was held; posted a real mouse-up at the helper's tracked position, which can move the user's cursor — this is not a read-only probe" };
      }
      case "set_text": {
        if (a.ref) return this.acts.setValue(a.ref, a.name, String(a.text ?? ""));
        const channel = await this.typingChannel(pid);
        return typeVerb(channel.call, channel.to, this.app!.name, String(a.text ?? ""), this.lastKeyAt);
      }
      case "type": {
        const channel = await this.typingChannel(pid);
        return typeVerb(channel.call, channel.to, this.app!.name, String(a.text ?? ""), this.lastKeyAt);
      }
      case "keys": {
        // Symbols first: the menu listing prints ⌥⌘N, so that is what a model sends back.
        const chord = normalizeChord(String(a.chord ?? ""));
        const n = Math.min(Math.max(Math.trunc(Number(a.count)) || 1, 1), 20);
        // Plain keys reach a background app. Document shortcuts also need app-local activation
        // and a key window; menuChord keeps AX stand-ins and otherwise asks the helper to
        // establish those temporarily, without changing the system's foreground.
        const to = await this.keyPid(pid);
        // ...except while the focus sits in ANOTHER process: an Open/Save panel has shortcuts of
        // its own (⌘⇧G is Go To Folder there) that the app's menu would mismatch, so the chord is
        // posted to the panel's process. In the background the panel ignores a ⌘-chord, so that
        // case is refused with the real reason.
        if (/\bcmd\b/i.test(chord) && to === pid) {
          const result = await menuChord(this.menu, pid, chord, n);
          return result;
        }
        if (/\bcmd\b/i.test(chord)) {
          if (!(await this.menu.isFrontmost(pid))) {
            return { ok: false, note: `${this.app!.name}'s focus is in its Open/Save panel (a separate process), and a ⌘-chord there `
              + "takes effect only with the app frontmost — activate, then send it again. The panel's fields and buttons still "
              + "answer by ref in the background (set_text a field, click a button)" };
          }
          for (let i = 0; i < n; i++) await this.call("key", { pid: to, chord });
          this.lastKeyAt = Date.now();
          return { ok: true, note: `${chord} was posted to the Open/Save panel that holds ${this.app!.name}'s focus (its own process), not run as one of the app's menu commands` };
        }
        if (to === pid && !(await this.menu.isFrontmost(pid))) {
          const receipt = await this.call<{ lastInputAt?: number }>("backgroundkey", { pid, window: this.windowId, chord, count: n });
          this.lastKeyAt = receipt.lastInputAt ?? Date.now();
          return { ok: true, note: `${chord} was posted ${n} time(s) to the bound background window; observe whether it took effect` };
        }
        for (let i = 0; i < n; i++) await this.call("key", { pid: to, chord });
        // When the NEXT verb is `type`, this timestamp is what it waits out — see TYPE_AFTER_KEY_MS.
        this.lastKeyAt = Date.now();
        return { ok: true };
      }
      case "ax_action":
        return this.acts.action(a.ref, a.name, String(a.action ?? ""));
      case "paste":
        // A menu command (menu-commands.ts).
        return pasteVerb(this.menu, pid, a);
      case "select_text":
        return selectTextVerb(this.acts, a.ref, a.name, {
          want: String(a.text ?? ""), near: typeof a.near === "string" ? a.near : "", caret: String(a.caret ?? "select"),
        });
      case "menu":
        return menuVerb(this.menu, pid, a.path);
      case "scroll":
        return this.scroll(a);
      case "activate":
        await this.call("activate", { pid });
        return { ok: true, note: `${this.app!.name} is now frontmost — the user's keyboard goes to it until they switch back` };
      default:
        return { ok: false, note: `unknown action kind ${kind}` };
    }
  }

  async close(): Promise<void> {
    // Stop OUR helper only. The apps are the user's — never quit on close.
    this.forgetHelper();
    try { await this.ax.close(); }
    finally { await this.disconnected(); }
  }

  /** A new helper cannot use the old process's AX keys. Keep the target and consent,
   *  but require a fresh observation and never reuse the old ref numbers. */
  private forgetHelper(): void {
    this.pointerHeld = false;
    this.listening.clear();
    // The pinned window id belongs to macOS, not the helper, and remains the target.
    this.frame = null;
    this.shotScale = 1;
    this.shotTaken = false;
    this.resetObservationState();
    this.refsByWindow.clear();
    this.acts.keys.clear();
    this.rects.clear();
    this.offscreenRefs.clear();
    this.lastListed = [];
    this.offscreenEmptyRows = 0;
    this.appWindowIds = null;
  }

  // ── Verb helpers ────────────────────────────────────────────────────────────
  // Everything that starts from a ref lives in act-element.ts; what is left here needs the
  // driver's own app / window / frame state.

  /** A model point (last screenshot's pixels) → global screen points. Refuses rather than guessing
   *  when this session has never taken one: @see shotTaken. */
  private toScreen(x: number, y: number): { x: number; y: number } {
    // Only once the window has been READ: before that the refusal that matters is the read's own
    // (a missing grant, another Space), and "take a screenshot first" would send the reader to a
    // screenshot refused for the same reason.
    if (this.frame && !this.shotTaken && !this.accessRefused) {
      throw new Error(
        "a point is a pixel of the LAST SCREENSHOT, and this session has not taken one — so there is no scale to map it "
        + "with, and on a Retina window the guess is off by a factor of two. Take w.observe({screenshot: true}) and read "
        + "the coordinates off that picture (it carries the pointer's own position as a ring)");
    }
    const f = this.frame ?? { x: 0, y: 0 };
    return { x: Math.round(f.x + x * this.shotScale), y: Math.round(f.y + y * this.shotScale) };
  }

  /** @see scroll-verb.ts — the wheel burst, and why the point it goes to is the ref's. */
  private async scroll(a: Record<string, any>): Promise<ActResult> {
    await this.ensure();
    if (!this.frame) await this.walk();
    return scrollVerb(this.mouse, this.acts, this.frame!, a);
  }

  /** Drop what describes the previously bound window (frame, delta base, screenshot scale) on
   *  binding a different app or window. @see driver-apps.ts
   *
   *  The signature → ref maps stay: they are keyed BY window, so a caller coming back keeps its
   *  refs (@see MacosDriverRead.refsByWindow). `resetObservationState` still empties the in-play
   *  set, so a ref counts again only once this window has been read again. */
  protected override forgetApp(): void {
    this.windowId = null;
    this.frame = null;
    this.shotScale = 1;
    this.shotTaken = false;
    this.resetObservationState();
  }

}
