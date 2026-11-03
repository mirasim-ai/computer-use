/**
 * WindowsDriver — ComputerUseDriver over native Windows applications through UI Automation, via the
 * resident Rust helper in `uia/` ({@link UiaHelperProcess}). Browsers are not this driver's job:
 * they stay on CDP (`browser/`, `electron/`).
 *
 * Reading never activates a window. Background actions use a separate native operation with
 * AutoSetFocus disabled, a bounded pattern policy, read-back and an interference observer.
 * Desktop interaction activates first and may use real input; only that path has fallbacks.
 * UIA providers can still react by opening windows or moving focus: interruption stops further
 * background actions on that window, without restoring focus or replaying the action.
 *
 * A TARGET is a top-level window, its id the HWND in decimal. Refs are minted per walk and mapped
 * to the helper's element keys; rects are window-local physical pixels — the same space as the
 * window screenshot, so a point read off the picture maps to the screen by the frame's origin.
 */

import type { DiagnosticsAbout } from "../driver-diagnostics.ts";
import type { ActResult, OwnershipResource, UserConsent, VerbSpec } from "../types.ts";
import { WindowsAppGate } from "./app-gate.ts";
import { performBackground } from "./background-verb.ts";
import { paste, selectText, setDate, type TextHost } from "./text-verbs.ts";
import { sameDate } from "./dates.ts";
import { menuVerb } from "./menu-verb.ts";
import type { RefTarget } from "./elements.ts";
import { WindowsDriverApps } from "./driver-apps.ts";
import { fieldText } from "./driver-read.ts";
import { promptFragmentFor, WINDOWS_INTERACTION_NOTES } from "./prompt-fragment.ts";
import { UiaHelperProcess, UiaRequestError, type UiaTransport } from "./uia-client.ts";
import { LAUNCH_NEEDS_DESKTOP } from "./launch.ts";
import { WINDOWS_VERBS } from "./verbs.ts";

function sameText(value: string, text: string): boolean {
  return fieldText(value) === text.replace(/\r\n?/g, "\n");
}

export interface WindowsDriverOptions {
  /** Embedders must obtain scoped permission before choosing desktop input. */
  interaction?: "background" | "desktop";
  env?: NodeJS.ProcessEnv;
  /** The host's way to ask its user whether an app may be used (app-gate.ts). */
  consent?: UserConsent;
  /** Test seam: a canned transport makes the driver hermetic. */
  transport?: UiaTransport;
}

/** Verbs that send real input to the window and therefore need it in front. */
const INPUT_VERBS = new Set(["click", "hover", "set_text", "type", "keys", "scroll", "activate", "uia_action", "drag", "launch_app", "select_text", "paste", "menu"]);

/** Wheel notches per "screen" a scroll count asks for. */
const NOTCHES_PER_SCREEN = 5;
const INPUT_VERIFY_MS = 2500;

export class WindowsDriver extends WindowsDriverApps {
  readonly platform = "windows";
  override readonly screenshotMimeType: string = "image/png";
  override readonly supportsDiagnostics = true;
  override readonly readsOffscreen = true;

  protected readonly uia: UiaTransport;
  protected readonly gate: WindowsAppGate;
  private readonly interruptedBackground = new Set<string>();

  constructor(opts: WindowsDriverOptions = {}) {
    super();
    this.interactionMode = opts.interaction ?? "background";
    this.gate = new WindowsAppGate(opts.consent ?? null, opts.env ?? process.env);
    this.uia = opts.transport ?? new UiaHelperProcess({
      env: opts.env ?? process.env,
      onLog: (line) => this.diagnosticsSink?.push("helper", line),
      onStart: async (pid) => { await this.onExecutorStart?.(pid); },
    });
    this.uia.onReset = () => {
      this.refTargets.clear();
      this.fullShotFrame = null;
      this.resetObservationState();
    };
  }

  override get diagnosticsAbout(): DiagnosticsAbout {
    return {
      empty: "complaints from the UI Automation helper (this platform's diagnostics are the helper's own log, never the app's)",
      header: "the Windows UI Automation helper's own log — what went wrong inside the platform, not inside the app",
    };
  }

  override promptFragment(): string {
    return promptFragmentFor();
  }

  override interactionNotes(): readonly string[] {
    return WINDOWS_INTERACTION_NOTES;
  }

  override extraVerbs(): VerbSpec[] {
    return WINDOWS_VERBS;
  }

  override async actionResources(kind: string): Promise<OwnershipResource[]> {
    return this.interactionMode === "desktop" && INPUT_VERBS.has(kind) ? [{ key: "windows:desktop-input", mode: "exclusive" }] : [];
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  async perform(kind: string, a: Record<string, any>): Promise<ActResult> {
    if (kind === "list_apps") return this.listApps(typeof a.query === "string" ? a.query : "");
    if (!INPUT_VERBS.has(kind)) return { ok: false, note: `unknown action kind ${kind}` };
    if (this.interactionMode === "background") {
      if (kind === "launch_app") return { ok: false, note: LAUNCH_NEEDS_DESKTOP };
      if (kind === "drag") {
        return { ok: false, note: "drag holds the user's real mouse button and moves their pointer, so it needs interaction:'desktop'; "
          + "explain that and obtain permission first. Nothing was sent" };
      }
      // A listing reads; it opens no menu in background mode, and running one is refused there.
      if (kind === "menu") {
        await this.authorized();
        return menuVerb(this.menuHost(false), a.path);
      }
      if (kind === "paste" || kind === "select_text") {
        return { ok: false, note: `${kind} moves the window's keyboard focus${kind === "paste" ? " and borrows the user's clipboard" : ""}, so it needs `
          + "interaction:'desktop'; explain that and obtain permission first. Nothing was sent" };
      }
      return this.performBackground(kind, a);
    }
    if (kind === "launch_app") return this.launchAndBind(String(a.app ?? ""));
    const row = await this.authorized();
    // An explicit activate is the model taking the window back on purpose, so it skips the
    // takeover check; it still waits for the user to pause like every other action.
    const refused = (kind === "activate" ? null : await this.takenOver(row)) ?? await this.yieldToHuman(kind, row.title);
    if (refused) return refused;
    const front = await this.activate(row);
    if (!front.ok) return front;
    this.leftFront = { pid: row.pid, at: Date.now() };
    if (kind === "activate") return front;
    try {
      switch (kind) {
        case "click": return await this.click(a);
        case "hover": {
          const p = a.ref ? this.center(this.target(a.ref)) : this.toScreen(a.x, a.y);
          await this.call("move", p);
          return { ok: true, note: `moved the real pointer to ${p.x},${p.y} on screen and left it there` };
        }
        case "set_text": return await this.setText(a.ref, String(a.text ?? ""));
        case "type": {
          const result = await this.call<{ verified?: boolean; note?: string }>("type", {
            hwnd: row.hwnd, text: String(a.text ?? ""), verifyMs: INPUT_VERIFY_MS,
          });
          return { ok: true, ...(typeof result.verified === "boolean" ? { verified: result.verified } : {}),
            note: result.note ?? "typed into the focused control; read-back unavailable — the value was not verified" };
        }
        case "keys":
          await this.call("key", { chord: String(a.chord ?? ""), count: Number(a.count ?? 1) || 1 });
          return { ok: true };
        case "scroll": return await this.scroll(a);
        case "menu": return await menuVerb(this.menuHost(true), a.path);
        case "select_text": return await selectText(this.textHost, a);
        case "paste": return await paste(this.textHost, a);
        case "drag": {
          const from = this.dragPoint(a.ref, a.x, a.y, "start");
          const to = this.dragPoint(a.toRef, a.toX, a.toY, "destination");
          if ("ok" in from) return from;
          if ("ok" in to) return to;
          const r = await this.call<{ steps: number }>("drag", { x: from.x, y: from.y, toX: to.x, toY: to.y, steps: Number(a.steps ?? 20) || 20 });
          return { ok: true, journal: { via: "mouse", steps: r.steps },
            note: `dragged ${from.what} to ${to.what} with the real pointer (left button held over ${r.steps} moves, then released) — observe for the result` };
        }
        case "uia_action": {
          const r = await this.call<{ via: string; pending?: boolean; state?: number }>("pattern", { key: this.target(a.ref).key, action: String(a.action ?? "") });
          return { ok: true, journal: { via: r.via, ...(r.pending ? { pending: true } : {}) },
            note: r.pending ? `${r.via} sent; the app is still handling it — typically a dialog it opened. Observe to see it; do not repeat it`
              : `${r.via} through UI Automation — observe for its effect` };
        }
      }
    } catch (e) {
      if (e instanceof UiaRequestError && e.code === "stale_key") return { ok: false, note: e.message };
      if (e instanceof UiaRequestError && (e.code === "no_action" || e.code === "bad_request")) return { ok: false, note: `${e.message}; nothing was sent` };
      if (e instanceof UiaRequestError && e.code === "unknown_op") return { ok: false, note: `this Windows native helper predates ${kind}; update @mirasim/computer-use, or the app that bundles it. Nothing was sent` };
      if (e instanceof UiaRequestError && e.code === "human_input") {
        return { ok: false, note: `${e.message}. The rest was NOT sent. Do not resend it blindly: observe what landed, `
          + "and let the user finish — the next action waits until they pause" };
      }
      throw e;
    }
    return { ok: false, note: `unknown action kind ${kind}` };
  }

  private menuHost(canOpen: boolean) {
    return { call: <T>(op: string, p?: Record<string, unknown>) => this.call<T>(op, p), hwnd: () => this.hwnd!, canOpen };
  }

  private readonly textHost: TextHost = {
    target: (ref) => this.target(ref), call: (op, p) => this.call(op, p), hwnd: () => this.hwnd!,
  };

  private async performBackground(kind: string, a: Record<string, any>): Promise<ActResult> {
    return performBackground({
      authorized: () => this.authorized(), target: (ref) => this.target(ref),
      call: (op, p) => this.call(op, p), interrupted: this.interruptedBackground,
    }, kind, a);
  }

  /** A drag endpoint in screen pixels: a ref's centre or a point in the latest screenshot. */
  private dragPoint(ref: unknown, x: unknown, y: unknown, which: string): ({ x: number; y: number; what: string }) | ActResult {
    if (typeof x === "number" && typeof y === "number") return { ...this.toScreen(x, y), what: `${x},${y}` };
    if (typeof ref !== "string") return { ok: false, note: `drag needs a ${which}: a ref, or x and y from the latest screenshot. Nothing was sent` };
    const t = this.target(ref);
    return { ...this.center(t), what: `${t.type.toLowerCase()} "${t.name}"` };
  }

  private async click(a: Record<string, any>): Promise<ActResult> {
    const button = String(a.button ?? "left");
    const count = Math.max(1, Math.min(3, Number(a.count ?? 1) || 1));
    let point: { x: number; y: number };
    if (a.ref) {
      const t = this.target(a.ref);
      if (button === "left" && count === 1) {
        try {
          const r = await this.call<{ via: string; pending?: boolean }>("press", { key: t.key });
          if (r.pending) {
            return { ok: true, journal: { via: r.via, pending: true },
              note: `pressed through UI Automation (${r.via}); the app is still handling it — typically a dialog it opened is waiting for an answer. Observe to see it; do not press again` };
          }
          return { ok: true, note: `pressed through UI Automation (${r.via})`, journal: { via: r.via } };
        } catch (e) {
          if (!(e instanceof UiaRequestError) || (e.code !== "no_action" && e.code !== "prefer_mouse")) throw e;
        }
      }
      point = this.center(t);
    } else {
      point = this.toScreen(a.x, a.y);
    }
    await this.call("click", { ...point, button, count });
    return { ok: true, note: `real ${button} click${count > 1 ? ` ×${count}` : ""} at ${point.x},${point.y} on screen — the user's pointer moved there`, journal: { via: "mouse" } };
  }

  private async setText(ref: unknown, text: string): Promise<ActResult> {
    const t = this.target(ref);
    if (t.datetime) return setDate(this.textHost, t, text);
    try {
      await this.call("setvalue", { key: t.key, text });
      return { ok: true, ...await this.verifyText(t.key, text) };
    } catch (e) {
      // Only these refusals prove SetValue sent nothing. A generic UIA error may have applied
      // the write already; let the caller inspect it instead of typing a second time.
      if (!(e instanceof UiaRequestError) || (e.code !== "no_value" && e.code !== "read_only")) throw e;
    }
    // No settable value: focus the control the way a person would, replace its content, type.
    await this.call("focus", { key: t.key }).catch(() => this.call("click", { ...this.center(t), button: "left", count: 1 }));
    await this.call("key", { chord: "ctrl+a" });
    await this.call("type", { text });
    return { ok: true, ...await this.verifyText(t.key, text) };
  }

  /** Poll only the original control. Never replay input or accept whichever field is focused later. */
  private async verifyText(key: string, expected: string): Promise<Pick<ActResult, "verified" | "note">> {
    const deadline = Date.now() + INPUT_VERIFY_MS;
    for (;;) {
      let value: string;
      try { value = (await this.call<{ value: string }>("value", { key })).value; }
      catch { return { note: "write dispatched; the original field could not be read — the value was not verified" }; }
      if (sameText(value, expected)) return { verified: true, note: "the original field reads back the requested text" };
      // A date control answers in its own format (WPF's DatePicker: "2026/8/20 0:00:00" for "2026/8/20").
      if (sameDate(value, expected)) return { verified: true, note: `the original field reads back the requested date as "${fieldText(value)}"` };
      if (Date.now() >= deadline) return { verified: false, note: "the original field did not retain the requested text before verification timed out; do not automatically replay input" };
      await new Promise(r => setTimeout(r, Math.min(50, deadline - Date.now())));
    }
  }

  private async scroll(a: Record<string, any>): Promise<ActResult> {
    const point = a.ref && a.ref !== "window" ? this.center(this.target(a.ref)) : this.windowCenter();
    const dir = String(a.direction ?? "down");
    const n = a.to ? 60 : Math.max(1, Number(a.count ?? 1) || 1) * NOTCHES_PER_SCREEN;
    const down = a.to ? a.to === "bottom" : dir === "down";
    const horizontal = !a.to && (dir === "left" || dir === "right");
    await this.call("scroll", horizontal ? { ...point, dx: dir === "right" ? n : -n } : { ...point, dy: down ? n : -n });
    return { ok: true, note: `${n} wheel notches ${a.to ? `toward the ${a.to}` : dir} at ${point.x},${point.y} — observe to see how far it moved`, journal: { notches: n } };
  }

  private center(t: RefTarget): { x: number; y: number } {
    return { x: Math.round(t.rect.x + t.rect.w / 2), y: Math.round(t.rect.y + t.rect.h / 2) };
  }

  private windowCenter(): { x: number; y: number } {
    const f = this.frame ?? this.row!.rect;
    return { x: Math.round(f.x + f.w / 2), y: Math.round(f.y + f.h / 2) };
  }

  /** A point from the window screenshot → screen pixels. Both are physical pixels, so it is the frame's origin. */
  private toScreen(x: unknown, y: unknown): { x: number; y: number } {
    const f = this.frame ?? this.row?.rect;
    if (!f) throw new Error("no frame for this window yet — observe it first");
    return { x: Math.round(f.x + Number(x)), y: Math.round(f.y + Number(y)) };
  }

  async close(): Promise<void> {
    // Stop OUR helper only; the windows are the user's.
    try { await this.uia.close(); }
    finally { await this.disconnected(); }
  }
}
