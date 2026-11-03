/**
 * What a NAVIGATION's outcome is called: its budget, the verdict when it runs out, and the line
 * that says where the browser actually landed.
 *
 * Saying either wrong — an unfinished navigation as a failure, a redirect as the requested URL —
 * sends the model looking for a page that is already on screen.
 */

import type { ActResult } from "../types.ts";

/** Honest budget for navigations: past this the act reports "still loading" WITH the partial
 * observation, rather than a silent 30s wait a caller cannot tell from success. */
export const NAV_TIMEOUT_MS = 15_000;
/** The verdict on a navigation that did not complete. A timeout is NOT a failure (the page may
 * be usable) but must be SAID; anything else (bad URL, DNS) is a failure with the reason. */
export function navVerdict(e: unknown): ActResult {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Timeout.*exceeded|TimeoutError/i.test(msg)) {
    return { ok: true, mayHaveActed: true, note: `navigation still loading after ${NAV_TIMEOUT_MS / 1000}s — the observation shows what has rendered so far` };
  }
  return { ok: false, mayHaveActed: true, note: msg.split("\n")[0] ?? "navigation failed" };
}

/** Where a navigation actually landed. A redirect (login wall, locale hop, canonical rewrite) is
 * invisible otherwise, and acting on the assumed page derails a run steps later. */
export function landedNote(verb: "opened" | "reloaded", requested: string, final: string): string {
  const same = (u: string) => u.replace(/\/+$/, "");
  return same(requested) === same(final) ? `${verb} ${final}` : `${requested} redirected to ${final}`;
}
