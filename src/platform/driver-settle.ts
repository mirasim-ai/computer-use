/**
 * Letting a server-driven state change LAND before the observation judges it.
 *
 * Two observation notes accuse an action: "no interactive element changed" and "moved the focus
 * but changed nothing else". Both come from a snapshot taken the instant the action returned,
 * which for a click is when the DOM event fired, not when anything changed. A CONTROLLED
 * component (`checked={serverValue}`) only re-renders after the server's frame comes back, so
 * the note is true at that instant and false as a conclusion — and the model, believing the
 * click inert, goes looking for a workaround to a control that worked.
 *
 * - Re-check, don't wait: only an observation about to accuse looks again, so a click that
 *   visibly worked costs nothing.
 * - Not `waitSettled`: it polls page TEXT, and a flipped checkbox need not change any.
 * - Both channels share it: pixels compare the frame hash instead of the element list.
 * - Focus is stripped first: it moves on every click, so a raw comparison would never fire.
 *   `collect.ts` keeps `focused` outermost in the state string so it can be cancelled here.
 */
import type { Element } from "./types.ts";

/** How often to look again while a state change is still in flight. */
const RECHECK_INTERVAL_MS = 200;
/** Ceiling on the whole re-check: a local round-trip plus a render, with room to spare. Spent
 *  only on observations about to report "nothing changed". */
const RECHECK_BUDGET_MS = 1_200;

/** The actions that can change element state, and therefore earn a re-check. Mirrors the set
 *  that can produce the "nothing changed" / "moved the focus" notes in `renderObservation`. */
export const STATE_CHANGING_ACTIONS = new Set(["click", "drag", "keys"]);

/** Element identity + state, focus included — the previous observation's `prevElSig`. Against
 *  an equal {@link substantiveElementSignature} the two differ exactly when the focus moved. */
export function elementSignature(elements: readonly Element[]): string {
  return elements.map((e) => `${e.role}|${e.name}|${e.state}`).join("\n");
}

/** Element identity + state without the focus marker — "did anything SUBSTANTIVE change". `row`
 *  is left out as in `elSig`: page text that moves on its own is not an element changing. */
export function substantiveElementSignature(elements: readonly Element[]): string {
  return elements.map((e) => `${e.role}|${e.name}|${stripFocusState(e.state)}`).join("\n");
}

/** Roles whose state a round trip flips. */
const TOGGLE_ROLES = new Set(["checkbox", "switch", "radio", "tab", "option", "menuitemcheckbox", "menuitemradio", "treeitem"]);
/** The same, read off the state string: an `aria-pressed` button or a disclosure is one too. */
const TOGGLE_STATE = /\b(checked|unchecked|mixed|pressed|expanded|collapsed|selected)\b/;

/**
 * Has the action ALREADY shown its effect, in a channel the substantive signature leaves out? Then
 * the observation accuses nothing and the re-check has nothing to wait for — measured, each of
 * these paid the whole budget for an effect that was on screen at the first capture:
 *
 * - The viewport scrolled (an anchor link, a key that pages down onto a stretch with no controls).
 * - A key moved the focus (Tab): the move IS the key's effect, as the textbox click's is.
 * - Geometry changed (a panel grew, a toast pushed the page down) — except on a control that
 *   carries a toggle state, the one shape the re-check exists for: a hover style can resize it
 *   while its state is still in flight, and reporting the old state invites a second click.
 */
export function effectAlreadyShown(opts: {
  action: string;
  /** The element acted on: the named ref, else the focused element. */
  target: Element | undefined;
  scrolled: boolean;
  focusMoved: boolean;
  geometryMoved: boolean;
}): boolean {
  if (opts.scrolled) return true;
  if (opts.action === "keys" && opts.focusMoved) return true;
  const toggle = opts.target !== undefined
    && (TOGGLE_ROLES.has(opts.target.role) || TOGGLE_STATE.test(stripFocusState(opts.target.state)));
  return opts.geometryMoved && !toggle;
}

/**
 * Did the element list only LOSE elements — some refs gone, none new? Judged on REFS, sticky per
 * element, because weaker keys misread churn as arrivals: a full signature sees a menu trigger's
 * own `expanded` → `collapsed` flip, and `role|name` sees live labels ("6m" → "7m") tick. Strict
 * subset; a platform that re-mints refs never satisfies it, which is the conservative outcome.
 */
export function onlyRefsLost(previous: ReadonlySet<string>, current: readonly Element[]): boolean {
  if (current.length >= previous.size) return false;
  for (const e of current) if (!previous.has(e.ref)) return false;
  return true;
}

/**
 * Did a disclosure CLOSE — a control that read `expanded` in the previous observation reads
 * `collapsed` now? Matched by role|name on the previous full signature ({@link elementSignature}),
 * which keeps no refs. The trigger of a menu that just closed says so here, and the thing its item
 * opens may still be mounting.
 */
export function disclosureClosed(previousFull: string | null, current: readonly Element[]): boolean {
  if (previousFull === null) return false;
  const wasExpanded = new Set<string>();
  for (const line of previousFull.split("\n")) {
    const cut = line.lastIndexOf("|");
    if (cut > 0 && /\bexpanded\b/.test(line.slice(cut + 1))) wasExpanded.add(line.slice(0, cut));
  }
  return current.some((e) => /\bcollapsed\b/.test(e.state) && wasExpanded.has(`${e.role}|${e.name}`));
}

/** Drop the focus marker from a state string. `collect.ts` guarantees it is outermost. */
function stripFocusState(state: string): string {
  if (state === "focused") return "";
  return state.startsWith("focused, ") ? state.slice("focused, ".length) : state;
}

/**
 * Re-take the snapshot while it shows no substantive change, up to {@link RECHECK_BUDGET_MS}.
 *
 * Returns the first capture that differs, or the last one when the budget runs out (a genuinely
 * inert action still gets its note). Never throws: a failed re-capture hands back the one in
 * hand. `previous === null` (first observation, or after a reset) has nothing to guard.
 *
 * `signature` is per channel (focus-stripped elements for the tree, the frame hash for pixels);
 * the wait is one implementation because the gap is one bug. `unsettled` widens what is waited
 * for: the tree channel adds {@link onlyRefsLost}, because a click whose only effect so far is
 * that things DISAPPEARED (a menu closed) is usually mid-transition, with the next thing still to
 * mount — unless the page reflowed into the gap (driver.ts).
 */
export async function settleAfterStateAction<T>(opts: {
  capture: T;
  previous: string | null;
  signature: (capture: T) => string;
  recapture: () => Promise<T>;
  /** Is this capture still worth waiting on, given the previous signature? Defaults to "its
   *  signature is identical to the previous one". Gets the capture, not just its signature, so a
   *  channel can judge on what the signature deliberately leaves out. */
  unsettled?: (previous: string, capture: T) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const { previous, recapture, signature } = opts;
  if (previous === null) return opts.capture;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const unsettled = opts.unsettled ?? ((prev: string, c: T) => prev === signature(c));

  let capture = opts.capture;
  const deadline = now() + RECHECK_BUDGET_MS;
  while (unsettled(previous, capture) && now() < deadline) {
    await sleep(RECHECK_INTERVAL_MS);
    try {
      capture = await recapture();
    } catch {
      return capture; // the surface went away mid-recheck — render what we already have
    }
  }
  return capture;
}
