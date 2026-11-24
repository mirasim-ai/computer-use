/**
 * What a repl run COSTS and what comes back: the caps on one run, and the trim that decides how
 * much of the closing observation the result carries. Pure functions and numbers, no session
 * state.
 */


import type { SurfaceData } from "../driver-select.ts";
import { type ToolResult } from "../types.ts";


export const MAX_ACTIONS = 100;
/** Wall clock for one call. */
export const MAX_MS = 60_000;
/**
 * Longest a snippet may run WITHOUT yielding. {@link MAX_MS} is checked before each verb, so it
 * never sees code that never reaches one (`while (true) {}` held the whole server). V8 interrupts
 * synchronous code only through `runInContext`'s timeout, which covers the snippet up to its first
 * `await`. Ten seconds is far beyond any legitimate synchronous stretch and under the host's
 * call timeout.
 */
export const SYNC_MAX_MS = 10_000;
/**
 * How far past {@link MAX_MS} a call may go before it is ENDED from outside. The cap is checked
 * when a verb starts, so it never sees a verb that does not come back (a key press sent to a page
 * whose script never returns), nor code waiting on a promise nothing will settle. The longest a
 * verb may legitimately take once started is run_js's 45 s; past that the call is stuck, and the
 * only way to end it is to drop the connection it is waiting on (tools/repl.ts).
 */
export const STUCK_GRACE_MS = 45_000;
/** How long an ended call's verb gets to fail once its connection was dropped. */
export const ABANDON_DRAIN_MS = 5_000;
/**
 * How long a call its client cancelled may still take to come back. It starts no verb once
 * cancelled, so this is the time the verb already out gets to finish (a click settling, a short
 * wait): a call that ends that way keeps its runtime and its connection. Past it the call is
 * ended like a stuck one, which costs both, because until it ends every later call queues behind
 * it. The same patience a turn's end has (entries/mcp.ts `ENDING_WAIT_MS`).
 */
export const CANCEL_GRACE_MS = 5_000;
/**
 * Characters of a returned value that reach the model. Sized for one window's full text (a
 * four-turn ChatGPT.app conversation reads 13,000–17,500 chars); smaller caps make the model
 * re-read in slices. 12,000 chars is ~3-4K tokens, under one observation of the same window.
 */
export const RETURN_CAP = 12_000;
/** Refs whose minting surface is remembered; oldest forgotten first. */
export const MAX_REF_OWNERS = 4000;

export type Render = "full" | "brief" | "none";

/**
 * Hand back less of the observation than was rendered — never less than was TAKEN.
 *
 * The observation is always made: the change verdict, the delta base and the ref bookkeeping are
 * updated from it, and skipping the read would corrupt them for every later call. Only the
 * printing is dropped — on an app holding the user's content, the element list IS that content.
 *
 * What survives is decided by the driver, not by matching text: `actionLines` is everything about
 * THIS ACTION (journal, pending fact, frozen verdict), `headLines` adds the head describing the
 * LISTING, and `keep` rides along whatever is cut (a swallowed-action note, once-per-session
 * knowledge). Don't keep every `NOTE:` line instead: listing notes would outlive their listing,
 * and the app knowledge pack, which has no `NOTE:` prefix, would be consumed and dropped.
 */
export function trimObservation(r: ToolResult, render: Render): ToolResult {
  if (render === "full") return r;
  const part = r.content.find((c) => c.type === "text");
  if (!part || part.type !== "text") return r;
  const lines = part.text.split("\n");
  // `headLines` counts every line before the element listing, so it is the cut for `brief`;
  // `actionLines` stops at what this action did, which is all `none` was asked for.
  const shape = render === "brief" ? r.details.headLines : (r.details.actionLines ?? r.details.ledgerLines);
  // A result that declares NO shape is not an observation: every line is what happened, and
  // trimming it to `Number(undefined ?? 0)` would answer empty after a side effect.
  if (shape === undefined) return r;
  const kept = lines.slice(0, Number(shape));
  const keep = Array.isArray(r.details.keep) ? r.details.keep as string[] : [];
  // A `keep` entry can be a BLOCK of lines (the app knowledge pack): compare line by line, or a
  // pack already inside the head is appended a second time.
  const have = new Set(kept);
  for (const l of keep) if (!l.split("\n").every((one) => have.has(one))) kept.push(l);
  part.text = kept.join("\n");
  // Drop any image the observation carried. A screenshot the SCRIPT took is pushed after this
  // and survives.
  r.content = r.content.filter((c) => c.type !== "image");
  r.details.observation = render;
  return r;
}

/** A bounded snapshot for a timeout reply, never a source of actionable refs. */
export function budgetObservation(data: SurfaceData) {
  return {
    title: data.title, url: data.url, partial: data.partial,
    elements: data.elements.slice(0, 24).map(({ role, name, state }) => ({
      role, name: name.slice(0, 120), state: state.slice(0, 160),
    })),
  };
}
