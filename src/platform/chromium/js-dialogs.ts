/**
 * Answering a page's JS dialogs — shared by the two Chromium platforms (`browser/`, `electron/`).
 *
 * A dialog blocks its page until answered, and with no listener Playwright dismisses it
 * SILENTLY. So a platform answers each one itself and says so: alert → accept; confirm/prompt
 * are decisions the model never saw → dismiss; beforeunload → accept, or its navigation hangs.
 * An answer armed by the `dialog` verb overrides that for exactly one dialog. WHEN an armed answer
 * stops applying is the platform's call (`browser/driver-connect.ts`, `electron/js-dialogs.ts`).
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
