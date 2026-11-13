/**
 * Element location — by ref with an identity check, then by name. Pure page-level logic: no
 * driver state. The compound act verbs that USE this live in actions.ts / actions-value.ts.
 */

import type { Locator, Page } from "playwright-core";
import { nameAgrees } from "../driver-refs.ts";
import { ELEM_NAME_JS, pageFn } from "./collect.ts";
import { readableFrames } from "./frames.ts";
import { refSelector } from "./page-refs.ts";

/** How long the identity check waits for the name of the node a ref has just matched. */
const NAME_WAIT_MS = 2_000;

/** Find the element for a ref (verifying its identity has not moved) or, failing that,
 * by role+name. Returns null when neither road leads anywhere. */
export async function locateOnPage(page: Page, ref: string | undefined, name: string | undefined, fill: boolean): Promise<Locator | null> {
  const want = name || "";
  if (ref) {
    const sel = await refSelector(page, ref);
    for (const frame of readableFrames(page)) {
      try {
        const loc = frame.locator(sel);
        if (!(await loc.count())) continue;
        const cand = loc.first();
        // Bounded: a node the page removed since count() is waited on for 30 s otherwise. An
        // unread name is "nothing to check against", as it was after that wait.
        const actual = await cand.evaluate(pageFn(ELEM_NAME_JS) as any, undefined, { timeout: NAME_WAIT_MS }).catch(() => "");
        if (nameAgrees(actual as string, want)) return cand;
        break; // ref moved to a different element → fall back to name
      } catch { /* frame unreadable, try next */ }
    }
  }
  if (!want) return null;
  const roles = fill ? ["textbox", "searchbox", "combobox"] : ["button", "link", "menuitem", "tab"];
  for (const frame of readableFrames(page)) {
    for (const r of roles) {
      try {
        const cand = frame.getByRole(r as any, { name: want, exact: false });
        if (await cand.count()) return cand.first();
      } catch { /* ignore */ }
    }
  }
  return null;
}
