/**
 * Which window, and may we touch it: the first slice of {@link WindowsDriver}'s chain, then
 * `WindowsDriverRead` (the walk and the reads) → `WindowsDriverYield` (giving the foreground back
 * to the user) → `WindowsDriverApps` (starting apps) → the driver itself (its wiring and the
 * verbs). Constructor-owned fields are abstract here and supplied in driver.ts.
 */

import { ComputerUseDriver } from "../driver.ts";
import type { ActResult, OwnershipResource, TargetInfo } from "../types.ts";
import { SurfaceGoneError, SurfaceUnreadableError } from "../types.ts";
import { AppRefused, isSharedFrameHost, type WindowsAppGate } from "./app-gate.ts";
import type { RefTarget } from "./elements.ts";
import type { UiaTransport } from "./uia-client.ts";

export interface WindowRow {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  class: string;
  rect: { x: number; y: number; w: number; h: number };
  minimized: boolean;
  foreground: boolean;
}

export type Frame = { x: number; y: number; w: number; h: number };

/** How long a bind waits for a Store app's window to say which app it is (see {@link WindowsDriverTargets.identified}). */
const IDENTITY_WAIT_MS = 3000;

/** A Store app's frame with no app attached to it, worded for whoever has to wait for it. */
export const NOT_IDENTIFIED_YET = "the app inside this window is not attached to it right now (a Store app is like that for a moment while it starts), "
  + "so there is no telling which app it is, and nothing was read or sent. Wait a moment and bind it again with computer.surface(…)";

export abstract class WindowsDriverTargets extends ComputerUseDriver {
  protected abstract readonly uia: UiaTransport;
  protected abstract readonly gate: WindowsAppGate;
  protected hwnd: number | null = null;
  protected row: WindowRow | null = null;
  /** The bound window's frame on screen, from the last walk or screenshot. */
  protected frame: Frame | null = null;
  /** Separate from walks: region coordinates refer to the last FULL screenshot. */
  protected fullShotFrame: Frame | null = null;
  protected refTargets = new Map<string, RefTarget>();
  protected pendingNote: string | null = null;
  /** Our last action left this app in front, at this time (`takenOver`, driver-yield.ts). */
  protected leftFront: { pid: number; at: number } | null = null;
  /** The window a launch bound, under the handle id it was reached through ({@link isActiveTarget}). */
  protected launched: { id: string; hwnd: number } | null = null;

  /** Start `app` and bind the window it shows (driver-apps.ts); binding an `app:` handle does. */
  protected abstract launchAndBind(app: string, handle?: string): Promise<ActResult>;

  protected override takePendingNote(): string | null {
    const note = this.pendingNote;
    this.pendingNote = null;
    return note;
  }

  protected call<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.uia.request(op, params) as Promise<T>;
  }

  // ── Targets ──────────────────────────────────────────────────────────────────

  protected async windows(): Promise<WindowRow[]> {
    return (await this.call<{ windows: WindowRow[] }>("windows")).windows;
  }

  /**
   * `row`, once it names its app. A Store app's top-level window belongs to ApplicationFrameHost,
   * and the helper names the app inside it — which is attached only some hundreds of
   * milliseconds after the frame shows. Until then the row carries the frame's own program,
   * which is no app's identity (app-gate.ts `isSharedFrameHost`): asking the user about it, or
   * checking it against their allow-list, would be about every Store app at once. So this waits
   * for the real name, up to `until`, and answers the row as it is then — still the frame's when
   * the app never attached — or null when the window closed meanwhile.
   */
  protected async identified(row: WindowRow, until: number = Date.now() + IDENTITY_WAIT_MS): Promise<WindowRow | null> {
    let now: WindowRow | undefined = row;
    while (now && isSharedFrameHost(now.process) && !now.minimized && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 150));
      now = (await this.windows()).find((r) => r.hwnd === row.hwnd);
    }
    return now ?? null;
  }

  /**
   * The bound window, still there. Never a default: the window in front is whatever the user is
   * working in, and reading it unasked is exactly what the app gate exists to prevent — the macOS
   * platform's rule too (macos/driver-apps.ts `ensure`).
   */
  private async ensure(): Promise<WindowRow> {
    if (this.hwnd === null) {
      throw new Error("mirasim-cu: no window is bound, and picking one is the caller's call, not this platform's. "
        + "Take one with computer.surface('<title or program name>'); computer.surfaces() lists them.");
    }
    const rows = await this.windows();
    const row = rows.find((r) => r.hwnd === this.hwnd);
    if (!row) throw new SurfaceGoneError(`the window "${this.row?.title ?? this.hwnd}" was closed`);
    this.row = row;
    return row;
  }

  /**
   * The bound window, once its APP is cleared — the check every read and action passes
   * (app-gate.ts). It never ASKS: a question waits on a person, and these run under the read's
   * own time bound, which would cut the person off and report a timeout. The asking happens when
   * the window is bound ({@link focusTarget}); an app not cleared here was revoked since, and
   * {@link isActiveTarget} sends the next bind back through the question.
   */
  protected async authorized(): Promise<WindowRow> {
    const row = await this.ensure();
    if (row.minimized && isSharedFrameHost(row.process)) {
      throw new SurfaceUnreadableError("This minimized app no longer exposes its UIA app identity. Restore it and bind again; no input was sent. The shared ApplicationFrameHost is not an app-access substitute");
    }
    if (isSharedFrameHost(row.process) && !this.gate.cleared(row.process)) throw new SurfaceUnreadableError(`This window cannot be used yet: ${NOT_IDENTIFIED_YET}`);
    if (!this.gate.cleared(row.process || "?")) {
      this.permissionRefusal = `mirasim-cu: ${row.process || "this app"} is not allowed for this session (any more) — `
        + "bind it again with computer.surface(…) to ask the user, or continue without it";
      throw new Error(this.permissionRefusal);
    }
    return row;
  }

  /** A window whose app is not cleared is not bound for this session's purposes: the next bind
   *  must go through {@link focusTarget}, which is where the user is asked. */
  override endCall(): void {
    this.gate.endCall();
  }

  private bind(row: WindowRow): void {
    if (this.hwnd === row.hwnd) return;
    this.hwnd = row.hwnd;
    this.row = row;
    this.frame = null;
    this.fullShotFrame = null;
    this.refTargets.clear();
    this.leftFront = null;
    this.resetObservationState();
    this.pendingSurfaceChange = true;
  }

  async listTargets(): Promise<TargetInfo[]> {
    // A window title is the user's content (a document, a chat), so an app not cleared yet is
    // listed by its app name only — nameable and bindable, never read.
    return (await this.windows()).map((r) => ({
      id: String(r.hwnd),
      kind: "window" as const,
      title: this.gate.cleared(r.process || "?")
        ? `${r.title} — ${r.process || "?"}${r.minimized ? " (minimized)" : ""}`
        : isSharedFrameHost(r.process)
          ? `a Store app ${r.minimized ? "that is minimized" : "that is still starting"} — which app it is shows once it is ${r.minimized ? "restored" : "up"}`
          : `${r.process || "?"} — not cleared in this session yet; binding it checks the user's allow-list or asks them`,
      active: r.hwnd === this.hwnd,
      // These are the user's windows: readable and actable with permission, never this session's to close.
      own: false,
    }));
  }

  async focusTarget(id: string): Promise<ActResult> {
    if (id.startsWith("app:")) {
      // A refused bind reads as "the surface disappeared" to the caller (tools/repl.ts `claim`),
      // which would hide why the app was not started (no desktop permission, not found).
      const r = await this.launchAndBind(id.slice(4), id);
      if (!r.ok) throw new Error(`mirasim-cu: ${r.note}`);
      return r;
    }
    const listed = (await this.windows()).find((r) => String(r.hwnd) === id.trim());
    // Which app it is comes first: the question below is about that app, by name.
    const row = listed && !this.gate.cleared(listed.process || "?") ? await this.identified(listed) : listed;
    if (!row) return { ok: false, note: `no window ${id} — list them with computer.surfaces()` };
    if (row.minimized && isSharedFrameHost(row.process)) {
      return { ok: false, note: "This minimized app no longer exposes its UIA app identity. Restore it and bind again; no input was sent" };
    }
    // Thrown, not answered: a refused bind reads as "the surface is gone", and this one is not.
    if (isSharedFrameHost(row.process) && !this.gate.cleared(row.process)) throw new Error(`mirasim-cu: "${row.title}" cannot be bound yet: ${NOT_IDENTIFIED_YET}`);
    // Binding is where the user is asked about an app not cleared yet (app-gate.ts): before any
    // read of it, and outside every read's time bound.
    try {
      this.waitedOnUserMs += await this.gate.authorize(row.process || "?", row.title, this.consentPurpose);
    } catch (e) {
      if (!(e instanceof AppRefused)) throw e;
      this.permissionRefusal = `mirasim-cu: ${e.message}`;
      throw new Error(this.permissionRefusal);
    }
    this.bind(row);
    return { ok: true, note: `bound to "${row.title}" (${row.process}); reads and supported background UIA actions do not activate it; desktop actions do` };
  }

  override async ownershipResources(): Promise<OwnershipResource[]> {
    const row = await this.ensure();
    return [{ key: `windows:window:${row.hwnd}`, mode: "exclusive" }];
  }

  override async currentUrl(): Promise<string> {
    return this.row ? `windows:${this.row.process}:${this.row.hwnd}` : "";
  }

  override async isActiveTarget(id: string): Promise<boolean> {
    // The handle a launch was reached through names the app, and the window it opened is it.
    if (id.startsWith("app:")) return !!this.launched && this.launched.id === id && this.launched.hwnd === this.hwnd && (!this.row || this.gate.cleared(this.row.process || "?"));
    return (await super.isActiveTarget(id)) && (!this.row || this.gate.cleared(this.row.process || "?"));
  }

  protected target(ref: unknown): RefTarget {
    const t = typeof ref === "string" ? this.refTargets.get(ref) : undefined;
    if (!t) throw new Error(`${String(ref)} is not in the latest observation of this window — observe again`);
    return t;
  }
}
