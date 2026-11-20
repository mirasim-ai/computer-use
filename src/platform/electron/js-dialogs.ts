/**
 * JS dialogs in an Electron app: the `dialog` verb's answer, and the app's own box for each one.
 *
 * ANSWERING. Answered over CDP like a browser tab's (chromium/js-dialogs.ts), so the next result
 * says a dialog appeared and how it was answered. Without a listener Playwright dismisses every
 * confirm silently and the result says only `click`.
 *
 * AN ARMED ANSWER LIVES FOR ONE ACTION. `dialog({answer})` covers the dialog the NEXT action
 * raises — during that action, or after it until the next one starts — and never one after: an
 * answer that action did not use is dropped when another action starts or the call ends, and the
 * result says so. Left standing, it would answer whatever unrelated dialog came next (an accept
 * the model armed for one delete, used by a later one it never read).
 *
 * THE APP'S BOX. Electron shows the dialog itself, as a native message box from its main process
 * that it takes down only when the page navigates or closes. An answer over CDP reaches the page
 * but not that box: it stays on screen, keeps the window disabled, and its buttons no longer
 * change anything, while the agent, still driving the page over CDP, never notices. The box lives
 * in the app's main process, which no debugging port reaches, so on Windows the UI Automation
 * helper closes it (`jsdialog` in windows/uia/src/jsdialog.rs): only a box of the app's own
 * process that shows this dialog's message, by its own OK or Cancel. Where that cannot be done
 * the note says the box may still be there, so the model can tell the user.
 */

import type { Dialog } from "playwright-core";

import { answerJsDialog, type ArmedDialog } from "../chromium/js-dialogs.ts";
import { UiaRequestError, type UiaTransport } from "../windows/uia-client.ts";

/** How long the app's box may take to come up after the answer. Measured on a slow Windows
 *  laptop: 60–150 ms for a small app, 1–2 s for a busy one (Mirasim's own window). */
const BOX_WAIT_MS = 5_000;
/** How long an action's result waits for its dialogs' boxes to be dealt with: the wait above,
 *  plus the close and the helper's first start. */
const SETTLE_MS = BOX_WAIT_MS + 3_000;

const MAY_REMAIN = "the app may still show its own box for this dialog: it no longer changes anything, "
  + "but it blocks the app's window until someone closes it — tell the user";

interface Armed extends ArmedDialog {
  /** Whether the action it was armed for has started. */
  inAction: boolean;
}

export interface ElectronDialogsOptions {
  /** The app's main (browser) process id, or null when it cannot be told. */
  appPid: () => Promise<number | null>;
  /** Whether the app's windows are on this machine's desktop (a loopback debugging port). */
  local: () => boolean;
  /** Starts the helper that closes the box, on the first dialog that needs it. Windows only. */
  helper: () => UiaTransport;
  platform?: NodeJS.Platform;
}

/** The dialog side of one Electron driver: the armed answer, the answers, the boxes. */
export class ElectronDialogs {
  private armed: Armed | null = null;
  private note: string | null = null;
  /** Dialogs being answered and their boxes closed; an action's result waits for them. */
  private readonly jobs = new Set<Promise<void>>();
  private uia: UiaTransport | null = null;
  /** Set once the helper said it has no `jsdialog` (an older one a host ships): not asked again. */
  private helperLacksOp = false;

  constructor(private readonly opts: ElectronDialogsOptions) {}

  private get platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform;
  }

  /** The `dialog` verb. Arming only: nothing changes yet, so the receipt says what WILL happen. */
  arm(answer: ArmedDialog): string {
    this.armed = { ...answer, inAction: false };
    const verb = answer.accept ? "accepted" : "dismissed";
    return `a JS dialog raised by your NEXT action will be ${verb} — nothing in the app has changed yet; `
      + "if that action raises none, the answer is dropped when another action starts or this call ends";
  }

  /** An action is starting: an answer armed for an EARLIER action that went unused is dropped. */
  actionStarts(kind: string): void {
    if (!this.armed) return;
    if (!this.armed.inAction) {
      this.armed.inAction = true;
      return;
    }
    this.dropArmed(`before this ${kind}: the action it was armed for raised no JS dialog`);
  }

  /** The tool call is over: an armed answer never carries into the next one. */
  callEnds(): void {
    if (this.armed) this.dropArmed("when the call that armed it ended: no JS dialog came up during it");
  }

  private dropArmed(when: string): void {
    const verb = this.armed!.accept ? "accept" : "dismiss";
    this.armed = null;
    this.append(`the dialog answer you armed (${verb}) was not used and was dropped ${when} — `
      + "a later dialog gets the default answer (alert accepted, confirm dismissed); arm it again right before the action that raises the dialog");
  }

  /** Every dialog of the app while attached: answered at once, its box closed after. */
  onDialog(dialog: Dialog): void {
    // Only the action it was armed for gets it: a dialog that comes up before that action starts
    // (a timer, the user's own click) is not the one the model decided on.
    const armed = this.armed?.inAction ? this.armed : null;
    if (armed) this.armed = null; // one dialog, one answer — never a standing policy
    const job = (async () => {
      const answer = await answerJsDialog(dialog, armed);
      // beforeunload shows no box (Electron emits `will-prevent-unload` instead), nor does a
      // prompt (Electron has none). An answer that never landed was someone else's.
      if (!answer.note) return;
      if (!answer.landed || (answer.kind !== "alert" && answer.kind !== "confirm")) {
        this.append(answer.note);
        return;
      }
      const box = await this.closeBox(answer.message, answer.kind === "confirm" && !answer.accept ? "cancel" : "ok");
      this.append(box ? `${answer.note}; ${box}` : answer.note);
    })().catch(() => {});
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }

  /** Close the app's box for the dialog just answered, the one showing `message`. Answers the
   *  sentence that says how it went, or null when there is nothing worth saying. */
  private async closeBox(message: string, button: "ok" | "cancel"): Promise<string | null> {
    if (this.platform !== "win32" || !this.opts.local() || this.helperLacksOp) return MAY_REMAIN;
    const pid = await this.opts.appPid().catch(() => null);
    if (!pid) return MAY_REMAIN;
    try {
      this.uia ??= this.opts.helper();
      const r = await this.uia.request("jsdialog", { pid, message, button, waitMs: BOX_WAIT_MS }) as {
        found?: boolean; closed?: boolean; ownerEnabled?: boolean;
      };
      if (r.closed) return "the app's own box for it was closed too";
      if (r.found) {
        return "the app's own box for it is still on screen and its buttons no longer change anything; "
          + "it blocks the app's window until someone closes it — tell the user";
      }
      // None came up in time: the page navigated or closed (which takes the box down), or someone
      // answered the box itself. Nothing of it is left to report.
      return null;
    } catch (e) {
      if (e instanceof UiaRequestError && e.code === "unknown_op") this.helperLacksOp = true;
      return MAY_REMAIN;
    }
  }

  /** Wait for the dialogs answered so far, their boxes included, within {@link SETTLE_MS}. */
  async settled(): Promise<void> {
    if (!this.jobs.size) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([...this.jobs]),
      new Promise((resolve) => { timer = setTimeout(resolve, SETTLE_MS); }),
    ]);
    clearTimeout(timer);
  }

  private append(note: string): void {
    if (!this.note) this.note = note;
    else if (!this.note.includes(note)) this.note = `${this.note}; ${note}`;
  }

  /** What the next result must carry, once. */
  takeNote(): string | null {
    const note = this.note;
    this.note = null;
    return note;
  }

  /** The connection is gone: no answer survives it, and the helper is stopped. */
  async close(): Promise<void> {
    this.armed = null;
    const uia = this.uia;
    this.uia = null;
    await uia?.close().catch(() => {});
  }
}
