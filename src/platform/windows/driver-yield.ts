/**
 * Giving the screen back to the user: every desktop action takes the foreground, so before one
 * this slice checks whether the user took over or is still typing, and brings the window forward
 * only when it may. Third slice of {@link WindowsDriver}'s chain, after {@link WindowsDriverRead}.
 */

import type { ActResult } from "../types.ts";
import { WindowsDriverRead } from "./driver-read.ts";
import type { WindowRow } from "./driver-targets.ts";
import { UiaRequestError } from "./uia-client.ts";

/**
 * How long nobody but us must have touched the keyboard or pointer before an action may take the
 * foreground, and how long it waits for that before refusing. The macOS values and reasoning
 * (macos/click-verb.ts): refusing costs a retry, while raising a window under someone mid-sentence
 * puts their next keystrokes in it. On Windows EVERY action raises the window, so every action asks.
 */
const HUMAN_QUIET_MS = 2000;
const HUMAN_WAIT_MS = 1500;

/** Hosts of Windows' credential/consent UI: while one is in front nothing else may take it. */
const SECURE_PROMPTS = new Set(["pickerhost", "credentialuibroker", "consent", "logonui", "lockapp"]);

export abstract class WindowsDriverYield extends WindowsDriverRead {
  /** Seconds since anyone but this helper used the keyboard or pointer; null when the helper cannot
   *  tell them apart (one predating `listening` counts its own input), in which case the human
   *  checks fail open rather than refuse every action after the first. */
  private async humanIdleSeconds(): Promise<number | null> {
    try {
      const r = await this.call<{ seconds: number; listening?: boolean }>("humanidle");
      return typeof r.listening === "boolean" ? r.seconds : null;
    } catch (e) {
      if (e instanceof UiaRequestError) return null;
      throw e;
    }
  }

  /**
   * The user took the screen back: since our last action they used the keyboard or pointer AND a
   * different app is now in front. Pulling the window back after a short pause would yank it out
   * from under someone reading, so this refuses until the model takes it back on purpose
   * (`activate`), which the prompt ties to the user's say-so. A change of window inside the same
   * app (a dialog, a second window) is the app's own doing and is not a takeover.
   */
  protected async takenOver(row: WindowRow): Promise<ActResult | null> {
    const left = this.leftFront;
    if (!left) return null;
    const idle = await this.humanIdleSeconds();
    if (idle === null || idle * 1000 >= Date.now() - left.at) return null;
    const fg = await this.call<{ pid: number; process: string }>("foreground");
    if (fg.pid === left.pid) return null;
    return {
      ok: false,
      note: `the user switched to ${fg.process || "another window"} since your last action on "${row.title}" — they have taken over the screen. `
        + "Nothing was sent and the window was not brought back. Tell them what is left and wait; once they agree, activate it "
        + "deliberately (kind:'activate') and continue",
    };
  }

  /**
   * Every desktop action takes the foreground, so every one waits for the user to pause first.
   * `justAnswered`: the user has this moment answered a question of ours, with the same keyboard
   * or pointer this listens to — so the wait is long enough for that answer to stop counting as
   * them being busy, and only input after it refuses the action.
   */
  protected async yieldToHuman(kind: string, title: string, justAnswered = false): Promise<ActResult | null> {
    const deadline = Date.now() + HUMAN_WAIT_MS + (justAnswered ? HUMAN_QUIET_MS : 0);
    for (;;) {
      const idle = await this.humanIdleSeconds();
      if (idle === null || idle * 1000 >= HUMAN_QUIET_MS) return null;
      if (Date.now() >= deadline) {
        return {
          ok: false,
          note: `${kind} was NOT sent: the user touched the keyboard or pointer ${idle.toFixed(1)} s ago, and acting now would bring `
            + `"${title}" to the front under them — their next keystrokes would land in it. Nothing was sent. Wait and retry; `
            + `it goes through once they pause for ${HUMAN_QUIET_MS / 1000} s`,
        };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Bring the window forward (restoring it if minimized) and refuse rather than type into another app. */
  protected async activate(row: WindowRow): Promise<ActResult> {
    const r = await this.call<{ foreground: boolean; method: string; restored: boolean }>("activate", { hwnd: row.hwnd });
    if (!r.foreground) return { ok: false, note: await this.frontRefusal(row) };
    return { ok: true, note: r.method === "already" ? `"${row.title}" was already in front`
      : `brought "${row.title}" to the front${r.restored ? " (restored from minimized)" : ""} — the user's keyboard now goes to it`, journal: { activation: r.method } };
  }

  /**
   * Why the window did not come forward, naming what holds the front. A Windows security prompt
   * (credential or consent UI) keeps every other process from taking the foreground until the
   * user answers it — measured: a "Windows Security" PickerHost left open refused every activation,
   * Alt rung included — so retrying is pointless and only the user can clear it. Any other app is
   * named by its program only: its title is the user's content, and it may not be cleared.
   */
  private async frontRefusal(row: WindowRow): Promise<string> {
    const fg = await this.call<{ hwnd: number; process: string; title: string }>("foreground").catch(() => null);
    const head = `Windows would not bring "${row.title}" to the front; nothing was sent`;
    if (!fg || !fg.hwnd) return `${head} — no window holds the foreground (the screen may be locked or the desktop switching). Wait, or ask the user to unlock`;
    if (SECURE_PROMPTS.has(fg.process.toLowerCase())) {
      return `${head} — a Windows security prompt (${fg.process}${fg.title ? `: "${fg.title}"` : ""}) is in front, and Windows lets no other window take the foreground until the user answers it. `
        + "Do not retry or try to close it: tell the user it is waiting for them";
    }
    return `${head} — ${fg.process || "another app"} is in front and Windows kept it there (the user may be working in it). Try again, or ask the user to switch to it`;
  }
}
