/**
 * Compound act-verb implementations — set_text's fallback ladder, drag, and select_option.
 * Pure page-level logic: no driver state; the driver passes its locate() in, exactly like
 * scroll.ts receives the page.
 */

import { existsSync } from "node:fs";
import type { ElementHandle, Locator, Page } from "playwright-core";
import { Type } from "typebox";
import type { ActResult, VerbSpec } from "../types.ts";
import { coverOf, isEditorProxy } from "./coverer-label.ts";

/**
 * Refuse to act on a control the page has switched OFF, instead of letting Playwright's
 * actionability wait burn 8 s and throw a timeout that never mentions disabled.
 *
 * Only the two states Playwright itself refuses are checked, so this changes NO outcome —
 * just the latency and the wording. The class-name greying `collect.ts` also marks stays out
 * on purpose: it is a heuristic, and a click on a control only guessed to be off may work.
 */
export async function refuseIfGated(loc: Locator, ref?: string, name?: string): Promise<ActResult | null> {
  let gated: { why: string | null; unmet: boolean };
  try {
    gated = await loc.evaluate((el: any) => {
      const why = el.matches && el.matches(":disabled") ? "natively disabled"
        : el.getAttribute && el.getAttribute("aria-disabled") === "true" ? "aria-disabled"
        : null;
      // Is there an unsatisfied FIELD to point at? Scope: the control's own form, else the document.
      const scope = (el.closest && el.closest("form")) || el.ownerDocument;
      const unmet = !!(scope && scope.querySelector
        && scope.querySelector("input:invalid, select:invalid, textarea:invalid"));
      return { why, unmet };
    }, undefined, { timeout: 2000 }) as { why: string | null; unmet: boolean };
  } catch {
    return null; // unreadable target — let the real dispatch be the arbiter, as before
  }
  const { why, unmet } = gated;
  if (!why) return null;
  const who = `${ref ?? "the target"}${name ? ` "${name}"` : ""}`;
  // Verb-neutral (this refuses set_text too). aria-disabled is only a LABEL: a coordinate click
  // still reaches the handler.
  const tail = why === "aria-disabled"
    ? "the page only LABELS it disabled, so a click by x/y from a screenshot may still reach it"
    : "the browser delivers no input to it";
  // Point at fields only when one is unmet: a gate can be a STATE (Undo disabled on an empty
  // history), and fields advice there sends the model hunting for inputs that do not exist.
  const cure = unmet
    ? "fill what it is waiting on (the [empty] / [invalid] fields in the list), then re-observe"
    : "no unfilled field is waiting here, so the gate is a STATE, not a form: some step has not "
      + "happened yet (nothing selected, an empty history, a mode not entered). Do that step, "
      + "then re-observe";
  return {
    ok: false,
    journal: { refused: why, gate: unmet ? "fields" : "state" },
    note: `${who} is ${why} — ${tail}. The page is gating this control, `
      + `so acting on a different element will not unlock it: ${cure} — the [disabled] mark `
      + "disappears once it becomes usable",
  };
}

/** How long a click by ref may wait on actionability before {@link coveredBy} is asked. */
const COVER_CHECK_AFTER_MS = 2_000;
/** The whole actionability budget, unchanged: the second attempt gets what the first left. */
const CLICK_BUDGET_MS = 8_000;

/**
 * Click, but find out early when something is COVERING the target, instead of only after the
 * full 8 s actionability wait. Measured on a front-end QA task: ten clicks on a covered button
 * cost 80 s, a third of all browser time in that run.
 *
 * Two attempts sharing the old budget. The first gets {@link COVER_CHECK_AFTER_MS}, enough for
 * Playwright to try each of its scroll alignments, which is how a click under a sticky header
 * succeeds, so a click that resolves at all resolves inside it. When it times out without having
 * dispatched, a cover still on top is answered at once; anything else (an element still moving
 * or appearing) gets the rest of the budget, as before. A timeout AFTER dispatch is never
 * retried: that click may have landed.
 */
export async function clickNamingCover(
  target: Pick<Locator, "click"> | Pick<ElementHandle, "click">, loc: Locator,
  opts: { button: "left" | "right" | "middle"; clickCount: number }, ref?: string, name?: string,
): Promise<ActResult> {
  try {
    await target.click({ ...opts, timeout: COVER_CHECK_AFTER_MS });
    return { ok: true };
  } catch (e) {
    const after = afterDispatch(e, COVER_CHECK_AFTER_MS);
    if (after) return after;
    if (!undispatchedTimeout(e)) throw e;
  }
  // An editor's input proxy never passes Playwright's hit check: the editor's own text is on top
  // of it by design (coverer-label.ts). A click at its point is the one a person makes there.
  if (await isEditorProxy(loc)) {
    try {
      await target.click({ ...opts, force: true, timeout: CLICK_BUDGET_MS - COVER_CHECK_AFTER_MS });
    } catch (e) {
      const after = afterDispatch(e, CLICK_BUDGET_MS - COVER_CHECK_AFTER_MS);
      if (after) return after;
      throw e;
    }
    return { ok: true };
  }
  const early = await coveredBy(loc, ref, name);
  if (early) return { ok: false, journal: { covered: true }, note: early };
  try {
    await target.click({ ...opts, timeout: CLICK_BUDGET_MS - COVER_CHECK_AFTER_MS });
    return { ok: true };
  } catch (e) {
    const after = afterDispatch(e, CLICK_BUDGET_MS - COVER_CHECK_AFTER_MS);
    if (after) return after;
    const late = await coveredBy(loc, ref, name);
    if (!late) throw e;
    return { ok: false, journal: { covered: true }, note: late };
  }
}

/**
 * A Playwright timeout that came AFTER the click was dispatched, said in this tool's terms.
 *
 * Playwright's own message is its call log, which the model read verbatim ("Timeout 2000ms
 * exceeded. Call log: …") and took for a failed click. Two cases:
 *  · "click action done", then waiting for scheduled navigations: the click LANDED and started a
 *    navigation that was still loading (a form posting to a slow server). That is a click that
 *    worked — the next read is what waits for the page.
 *  · dispatched but never confirmed done: it may have landed, so it is not retried, and says so.
 * Null for a timeout before dispatch, which the caller handles (cover check, second attempt).
 */
function afterDispatch(e: unknown, ms: number): ActResult | null {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name !== "TimeoutError") return null;
  const msg = String(err.message ?? "");
  if (/click action done/.test(msg)) {
    return { ok: true, note: "clicked — it started a navigation that was still loading when the click returned; "
      + "wait({loaded}) or wait({text}) for the next page before reading it" };
  }
  if (/performing \w+ action/.test(msg)) {
    throw new Error(`the click was sent but not confirmed within ${ms / 1000}s — it may have landed; `
      + "observe before clicking again");
  }
  return null;
}

/** A Playwright timeout whose call log never reached the dispatch step ("performing click action"). */
function undispatchedTimeout(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  return err?.name === "TimeoutError" && !/performing \w+ action/.test(String(err.message ?? ""));
}

/**
 * Why an action on the right element failed, when something is COVERING it.
 *
 * Deliberately NOT a pre-check like {@link refuseIfGated}: under a sticky header a "covered"
 * element's click SUCCEEDS (Playwright scrolls it out from under), while under a modal backdrop
 * it times out with no mention of the overlay. So this runs only after a click attempt failed
 * ({@link clickNamingCover}), and turns the timeout into a named culprit ({@link coverOf}). A
 * pseudo-element layer is named as page styling, since it is in no element list and there is
 * nothing to close.
 */
async function coveredBy(loc: Locator, ref?: string, name?: string): Promise<string | null> {
  const found = await coverOf(loc);
  if (!found) return null;
  const target = `${ref ?? "the target"}${name ? ` "${name}"` : ""}`;
  if (found.pseudo) {
    return `${target} is covered by the ${found.pseudo} layer of «${found.who}», which takes the click instead — `
      + "that is the page's own styling, not an element: it is in no element list and there is nothing to "
      + "close, so a user's mouse click does not reach this control either. The keyboard still does "
      + "(Tab to it, then Enter or Space)";
  }
  return `${target} is covered by «${found.who}», which took the click instead — the element is the right one, `
    + "so acting on a different one will not help: close or dismiss what is on top (find('close') reaches its close control when "
    + "the page marks one; an unmarked one shows only in a screenshot), or "
    + (ref ? `scroll({into:'${ref}'}) to bring it clear` : "scroll until this control sits clear of it")
    + ", then act on this ref again";
}

/**
 * The dialog verb: how the NEXT JS dialog gets answered.
 *
 * A dialog blocks the page until answered, so the driver answers on the spot (driver-core.ts)
 * and there is never one on screen to find. The decision must be armed BEFORE the action that
 * raises it: this verb, then the click in the same call's `then`.
 */
export const DIALOG_VERB: VerbSpec = {
  kind: "dialog",
  schema: Type.Object({
    kind: Type.Literal("dialog"),
    answer: Type.Union([Type.Literal("accept"), Type.Literal("dismiss")], {
      description: "\"accept\" or \"dismiss\" for the next JS dialog. Default without this verb: alert accepted, confirm/prompt dismissed.",
    }),
    text: Type.Optional(Type.String({ description: "Text to type into a prompt() before accepting" })),
  }),
};

/** Both upload routes start here: a missing file would make the page report a generic failure
 *  that reads as "upload not supported". */
export function refuseMissingFiles(paths: string[]): ActResult | null {
  const missing = paths.filter((f) => !existsSync(f));
  if (!missing.length) return null;
  return { ok: false, note: `no such file: ${missing.join(", ")} — `
    + "give an absolute path to a file that exists on this machine" };
}

/**
 * The file input a visible control triggers. An attach button is often a `<button>` with a
 * `display:none` `<input type=file>` behind it, which no ref names, so `ref` names what the
 * model CAN see and the input is found from there.
 *
 * Deliberately narrow: the NEAREST ancestor holding a file input, and only when it holds
 * exactly one. A page can show several composers at once, so a page-wide search would fill a
 * neighbour's.
 */
export async function fileInputFor(loc: Locator): Promise<Locator | null> {
  // Duck-typed: naming a DOM global (`instanceof HTMLInputElement`) would need the DOM lib,
  // which the tsconfig does not carry.
  const isInput = await loc
    .evaluate((el: { tagName?: string; type?: string }) => el.tagName === "INPUT" && el.type === "file")
    .catch(() => false);
  if (isInput) return loc;
  // ancestor-or-self is a reverse axis, so [1] is the closest match, not the outermost.
  const found = loc.locator('xpath=ancestor-or-self::*[.//input[@type="file"]][1]//input[@type="file"]');
  return (await found.count().catch(() => 0)) === 1 ? found : null;
}

/**
 * Set files on a visible `<input type=file>` directly, so no native chooser opens — the ONLY
 * upload route an app shell has (electron/driver.ts).
 */
export async function performUploadToRef(
  paths: string[],
  ref: string,
  locate: () => Promise<Locator | null>,
  missing: () => Promise<ActResult>,
): Promise<ActResult> {
  const loc = await locate();
  if (!loc) return await missing();
  try {
    await loc.setInputFiles(paths, { timeout: 8000 });
  } catch (e) {
    // Usually the ref is the BUTTON next to the file input, which has a precise fix.
    const why = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
    return { ok: false, note: `${ref} did not take the files (${why}) — `
      + "pass ref only for an element the list shows as `file`" };
  }
  return { ok: true, note: `set ${paths.length} file${paths.length === 1 ? "" : "s"} on ${ref}` };
}

/**
 * The upload verb, two routes:
 *  - `ref` names a visible `<input type=file>` → the files are set on it directly;
 *  - no `ref` → the next file chooser a click opens is answered with these files, armed like
 *    the dialog verb because a native chooser blocks the page.
 */
export const UPLOAD_VERB: VerbSpec = {
  kind: "upload",
  schema: Type.Object({
    kind: Type.Literal("upload"),
    paths: Type.Array(Type.String(), {
      description: "Absolute path(s) of the file(s) to upload. They must already exist on this machine.",
      minItems: 1,
    }),
    ref: Type.Optional(Type.String({ description: "A visible file input to fill directly. Omit to answer the next file chooser a click opens." })),
  }),
};

/** The drag verb's schema. Start and destination each take a ref OR coordinates — a slider's
 * knob is an element but its target position usually is not. */
export const DRAG_VERB: VerbSpec = {
  kind: "drag",
  schema: Type.Object({
    kind: Type.Literal("drag"),
    ref: Type.Optional(Type.String({ description: "Element to drag — REQUIRED unless x/y are given (this pair is drag-only; click/hover still require ref or x/y)" })),
    name: Type.Optional(Type.String({ description: "The ref's expected name — an identity check on ref, never a start of its own; a non-control (a list row) has no ref, so take its x/y off a screenshot" })),
    x: Type.Optional(Type.Number({ description: "Drag start x (instead of ref)" })),
    y: Type.Optional(Type.Number({ description: "Drag start y" })),
    toRef: Type.Optional(Type.String({ description: "Element to drop onto — REQUIRED unless toX/toY are given" })),
    toX: Type.Optional(Type.Number({ description: "Destination x (instead of toRef)" })),
    toY: Type.Optional(Type.Number({ description: "Destination y" })),
  }, { description: "Press, drag, release: move sliders, resize handles, reorder/sort items, drag into bins, or select text by dragging across it. Needs a start (ref or x/y) AND a destination (toRef or toX/toY)." }),
};


/**
 * drag — press, interpolated move, release. Start and destination each resolve from a ref
 * (element center) or raw coordinates. Returns the release point for the journal.
 *
 * Raw mouse events get no actionability scroll, so an off-screen element would measure a
 * negative center and "succeed" into nothing. Both refs are therefore scrolled into view
 * FIRST and measured after — measuring one before scrolling the other lets the second scroll
 * move the first end away. Ends that no single scroll position holds refuse by name.
 */
export async function performDrag(
  page: Page,
  a: Record<string, any>,
  locate: (ref: string, name: string | undefined) => Promise<Locator | null>,
): Promise<{ res: ActResult; point: { x: number; y: number } | null }> {
  /** A ref's locator, scrolled into view; coordinates resolve to no locator at all. */
  const reveal = async (ref: unknown, name: string | undefined, what: string): Promise<Locator | ActResult | null> => {
    if (typeof ref !== "string") return null;
    const loc = await locate(ref, name);
    if (!loc) return { ok: false, note: `no element for ${what} ${ref}` };
    await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    return loc;
  };
  const center = async (loc: Locator, what: string, ref: unknown): Promise<{ x: number; y: number } | ActResult> => {
    const box = await loc.boundingBox().catch(() => null);
    if (!box) return { ok: false, note: `no element for ${what} ${String(ref)}` };
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const hasFromPoint = typeof a.x === "number" && typeof a.y === "number";
  const hasToPoint = typeof a.toX === "number" && typeof a.toY === "number";
  if (!hasFromPoint && typeof a.ref !== "string") return { res: { ok: false, note: `drag needs a start: ref or x/y${typeof a.name === "string" ? " — name only checks a ref, it does not locate one; find() it for a ref, or read x/y off a screenshot for a non-control" : ""}` }, point: null };
  if (!hasToPoint && typeof a.toRef !== "string") return { res: { ok: false, note: "drag needs a destination: toRef or toX/toY" }, point: null };

  // Both scrolls happen before either measurement.
  const fromLoc = hasFromPoint ? null : await reveal(a.ref, a.name, "ref");
  if (fromLoc && "ok" in fromLoc) return { res: fromLoc, point: null };
  const toLoc = hasToPoint ? null : await reveal(a.toRef, undefined, "toRef");
  if (toLoc && "ok" in toLoc) return { res: toLoc, point: null };

  let from: { x: number; y: number };
  if (hasFromPoint) from = { x: a.x, y: a.y };
  else {
    const r = await center(fromLoc as Locator, "ref", a.ref);
    if ("ok" in r) return { res: r, point: null };
    from = r;
  }
  let to: { x: number; y: number };
  if (hasToPoint) to = { x: a.toX, y: a.toY };
  else {
    const r = await center(toLoc as Locator, "toRef", a.toRef);
    if ("ok" in r) return { res: r, point: null };
    to = r;
  }

  // Both ends must be reachable by the pointer at the same time.
  const size = await page.evaluate("({ w: innerWidth, h: innerHeight })").catch(() => null) as { w: number; h: number } | null;
  const outside = (p: { x: number; y: number }) => !!size && (p.x < 0 || p.y < 0 || p.x > size.w || p.y > size.h);
  if (outside(from) || outside(to)) {
    return {
      res: { ok: false, note: `drag needs both ends on screen at once, and (${Math.round(from.x)},${Math.round(from.y)}) → (${Math.round(to.x)},${Math.round(to.y)}) is not — scroll until both are visible, then drag` },
      point: null,
    };
  }
  // Interpolated moves, not a jump: mousemove-driven widgets only follow a pointer that
  // travels, and many arm the drag only after a small movement threshold.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  // Where the grabbed element ENDED (a handle at its limit stops short). Reported, not judged:
  // a text-selection drag or a drop into a bin legitimately leaves the start where it was.
  let landed = "";
  if (fromLoc) {
    const end = await center(fromLoc as Locator, "ref", a.ref).catch(() => null);
    if (end && !("ok" in end)) {
      const off = Math.round(Math.hypot(end.x - to.x, end.y - to.y));
      const moved = Math.round(Math.hypot(end.x - from.x, end.y - from.y));
      landed = moved < 2
        ? ` — ${String(a.ref)} did not move`
        : off < 2
          ? ` — ${String(a.ref)} followed to the release point`
          : ` — ${String(a.ref)} now sits at (${Math.round(end.x)},${Math.round(end.y)}), ${off}px short of the release point`;
    }
  }
  return {
    res: {
      ok: true,
      note: `dragged (${Math.round(from.x)},${Math.round(from.y)}) → (${Math.round(to.x)},${Math.round(to.y)})${landed}`,
      journal: { fromX: Math.round(from.x), fromY: Math.round(from.y) },
    },
    point: to,
  };
}
