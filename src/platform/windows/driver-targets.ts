/**
 * Which window, and may we touch it: the first slice of {@link WindowsDriver}'s chain, then
 * `WindowsDriverRead` (the walk and the reads) → `WindowsDriverYield` (giving the foreground back
 * to the user) → `WindowsDriverApps` (starting apps) → the driver itself (its wiring and the
 * verbs). Constructor-owned fields are abstract here and supplied in driver.ts.
 */

import { ComputerUseDriver } from "../driver.ts";
import type { ActResult, OwnershipResource, TargetInfo } from "../types.ts";
import { SurfaceGoneError, SurfaceUnreadableError } from "../types.ts";
import { AppRefused, type WindowsAppGate } from "./app-gate.ts";
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
    if (row.minimized && row.process.toLowerCase() === "applicationframehost") {
      throw new SurfaceUnreadableError("This minimized app no longer exposes its UIA app identity. Restore it and bind again; no input was sent. The shared ApplicationFrameHost is not an app-access substitute");
    }
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
    const row = (await this.windows()).find((r) => String(r.hwnd) === id.trim());
    if (!row) return { ok: false, note: `no window ${id} — list them with computer.surfaces()` };
    if (row.minimized && row.process.toLowerCase() === "applicationframehost") {
      return { ok: false, note: "This minimized app no longer exposes its UIA app identity. Restore it and bind again; no input was sent" };
    }
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
