/**
 * Answering a page's JS dialogs — shared by the two Chromium platforms (`browser/`, `electron/`).
 *
 * A dialog blocks its page until answered, and with no listener Playwright dismisses it
 * SILENTLY. So a platform answers each one itself and says so: alert → accept; confirm/prompt
 * are decisions the model never saw → dismiss; beforeunload → accept, or its navigation hangs.
 * An answer armed by the `dialog` verb overrides that for exactly one dialog: the one the NEXT
 * action raises ({@link DialogArming}).
 */

import type { Dialog } from "playwright-core";

import { cutText } from "../text-cut.ts";

/** An answer the `dialog` verb armed for the next dialog. */
export interface ArmedDialog {
  accept: boolean;
  text?: string;
}

/** What answering one dialog did. */
export interface DialogAnswer {
  /** `alert`, `confirm`, `prompt` or `beforeunload`. */
  kind: string;
  message: string;
  accept: boolean;
  /** Whether the answer LANDED, not whether it was attempted: another CDP client (the user's
   *  DevTools) may answer first, and the note is the model's only evidence. */
  landed: boolean;
  /** The sentence the next result carries; null for beforeunload (plumbing, not a page fact). */
  note: string | null;
}

/** Answer `dialog` with the armed answer, else the default, and word what happened. */
export async function answerJsDialog(dialog: Dialog, armed: ArmedDialog | null): Promise<DialogAnswer> {
  const kind = dialog.type();
  const message = dialog.message();
  const accept = armed ? armed.accept : (kind === "alert" || kind === "beforeunload");
  let landed = true;
  try { await (accept ? dialog.accept(armed?.text) : dialog.dismiss()); } catch { landed = false; }
  if (kind === "beforeunload") return { kind, message, accept, landed, note: null };
  const said = `a JS dialog appeared: «${cutText(message, 120)}»`;
  const note = !landed
    ? `${said} — it was already answered before your ${accept ? "accept" : "dismiss"} `
      + "could land (another client shares this browser), so the page took an answer you did "
      + "not choose. Check what the page did before acting on it"
    // The armed case says who decided; the default note's "did not happen" would lie here.
    : armed
      ? `${said} — ${accept ? "accepted" : "dismissed"} as you asked`
        + (armed.text !== undefined ? ` with text «${cutText(armed.text, 60)}»` : "")
      : `${said} — it was auto-${accept ? "accepted" : "dismissed"}; `
        + "if the flow needs a confirm, it did not happen";
  return { kind, message, accept, landed, note };
}

/**
 * How long an answer the `dialog` verb armed applies. It covers the dialog the NEXT action raises
 * — during that action, or after it until another action starts — and never one after: an answer
 * that action did not use is dropped when another action starts or the call ends, and the result
 * says so. Left standing, it answered whatever unrelated dialog came next: an accept the model
 * armed for one click, unused, accepted a later "Delete record #42?" it never read (M1, every
 * browser connection). A dialog that comes up BEFORE that action starts (a timer, the user's own
 * click) is not the one the model decided on, and gets the default.
 *
 * The platform tells it when an action starts and when the call ends, and asks it for the answer
 * when a dialog comes up; it answers the sentences each of those has to say.
 */
export class DialogArming {
  private armed: (ArmedDialog & { inAction: boolean }) | null = null;

  /** @param where where nothing has changed yet, as the receipt words it: "on the page", "in the app". */
  constructor(private readonly where: string) {}

  /** The `dialog` verb. Arming only: nothing changes yet, so the receipt says what WILL happen. */
  arm(answer: ArmedDialog): string {
    this.armed = { ...answer, inAction: false };
    const verb = answer.accept ? "accepted" : "dismissed";
    return `a JS dialog raised by your NEXT action will be ${verb} — nothing ${this.where} has changed yet; `
      + "if that action raises none, the answer is dropped when another action starts or this call ends";
  }

  /** An action is starting. Answers the note when this drops an answer an EARLIER action left unused. */
  actionStarts(kind: string): string | null {
    if (!this.armed) return null;
    if (!this.armed.inAction) {
      this.armed.inAction = true;
      return null;
    }
    return this.drop(`before this ${kind}: the action it was armed for raised no JS dialog`);
  }

  /** The tool call is over: an armed answer never carries into the next one. */
  callEnds(): string | null {
    return this.armed ? this.drop("when the call that armed it ended: no JS dialog came up during it") : null;
  }

  /** A dialog came up: the armed answer when the action it was armed for has started — used up
   *  here, one dialog, one answer — else null (the default applies). */
  take(): ArmedDialog | null {
    const armed = this.armed;
    if (!armed?.inAction) return null;
    this.armed = null;
    return { accept: armed.accept, ...(armed.text !== undefined ? { text: armed.text } : {}) };
  }

  /** The connection is gone: no answer survives it. */
  clear(): void {
    this.armed = null;
  }

  private drop(when: string): string {
    const verb = this.armed!.accept ? "accept" : "dismiss";
    this.armed = null;
    return `the dialog answer you armed (${verb}) was not used and was dropped ${when} — `
      + "a later dialog gets the default answer (alert accepted, confirm dismissed); arm it again right before the action that raises the dialog";
  }
}
