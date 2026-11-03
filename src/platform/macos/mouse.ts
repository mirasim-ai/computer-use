/**
 * The mouse: a synthesised click, hover and drag on the session event tap — the pointer itself.
 * WHEN the driver reaches for it is `click-verb.ts`'s decision; the cost described here is why it
 * is the LAST rung.
 *
 * AXPress stays first: it presses without moving the cursor, stealing focus or occupying the
 * keyboard. But some Electron web buttons advertise AXPress, answer `success`, and do nothing,
 * in the background and the foreground alike. Of the two ways to post a mouse event:
 *
 *   · `CGEventPostToPid` — the delivery the keys use — lands NOWHERE, on Electron or AppKit,
 *     behind or in front;
 *   · the session tap — what the scroll already rides — lands, and being a real click as far as
 *     macOS is concerned, RAISES the app.
 *
 * Mouse input uses the user's real pointer and can change foreground/key-window focus. Right and
 * middle clicks were observed to leave the foreground unchanged, so dispatch alone must not claim
 * activation. For left click this is a FALLBACK; right and middle buttons and multi-clicks have no
 * AX vocabulary, so for them the mouse is the only route and is taken at once.
 */

import { Type } from "typebox";
import type { ActResult, VerbSpec } from "../types.ts";
import type { ElementActs } from "./act-element.ts";
import { AxRequestError } from "./ax-client.ts";
import { PressMemory, type MouseHost } from "./press-rungs.ts";

// Re-exported so the driver imports the click's vocabulary from one place.
export { PressMemory, type MouseHost };

/** How long `activate` is given to raise the window before a mouse event is posted at a point it had
 *  not owned — the window server, not AppKit's menu validation, so far shorter than the paste wait. */
const ACTIVATE_SETTLE_MS = 400;


export const DRAG_VERB: VerbSpec = {
  kind: "drag",
  schema: Type.Object({
    kind: Type.Literal("drag"),
    ref: Type.Optional(Type.String({ description: "Element to drag — REQUIRED unless x/y are given" })),
    name: Type.Optional(Type.String({ description: "Visible name of the dragged element" })),
    x: Type.Optional(Type.Number({ description: "Drag start x in the latest screenshot (instead of ref)" })),
    y: Type.Optional(Type.Number({ description: "Drag start y" })),
    toRef: Type.Optional(Type.String({ description: "Element to drop onto — REQUIRED unless toX/toY are given" })),
    toX: Type.Optional(Type.Number({ description: "Destination x (instead of toRef)" })),
    toY: Type.Optional(Type.Number({ description: "Destination y" })),
  }, { description: "Drag with the user's real pointer and potentially bring the app/window forward; explain these effects and obtain permission first. Needs a start (ref or x/y) AND a destination (toRef or toX/toY)." }),
};

export type Point = { x: number; y: number };


/** Marks the refusal `mouse()` returns when the helper predates mouse events (§ "unsupported"). */
export const NO_MOUSE = { mouse: "unsupported" } as const;
export const centre = (r: { x: number; y: number; w: number; h: number }): Point => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
const raised = (app: string, liftedFirst = false) => liftedFirst
  ? `— another window covered the point, so ${app} was requested to come to the front first; real pointer input was posted and cursor restoration requested`
  : `— real pointer input was posted and cursor restoration requested; this can bring ${app} to the front and change keyboard focus, but dispatch alone does not verify activation`;

/**
 * `hover` — put the pointer on a control and LEAVE it there.
 *
 * AX has no hover, but web content gates whole controls on the pointer (ChatGPT's per-message
 * Copy/Edit bar): until hovered they are not hit-testable and the tree reports them with a
 * COLLAPSED frame, so a click by ref silently lands in the window chrome.
 *
 * It moves the real pointer through the session tap and does not put it back. Unlike a click,
 * this posts no button event and does not activate the app; the target must already be uncovered.
 */
export async function hoverVerb(host: MouseHost, acts: ElementActs, a: Record<string, any>): Promise<ActResult> {
  if (typeof a.ref === "string" && a.ref && host.offWindow(a.ref)) return outOfReach(`${a.name ? `"${String(a.name)}"` : String(a.ref)}`, a.ref, "hover");
  const hasPoint = typeof a.x === "number" && typeof a.y === "number";
  const target = hasPoint ? null : acts.resolve(a.ref, a.name);
  if (target && !("key" in target)) return target;
  const at = hasPoint ? host.toScreen(a.x, a.y) : (() => { const r = host.rectOf(String(a.ref)); return r ? centre(r) : null; })();
  const what = hasPoint ? "the point" : `${target!.role} "${target!.name}"`;
  if (!at) return { ok: false, note: `${what} has no frame on this walk, so there is nowhere to hover — observe and act on a listed control` };
  await host.call("hover", { pid: host.pid(), ...at });
  // The web-view half is said only where there IS one: native apps have hover-gated controls too
  // (QuickTime Player's transport HUD).
  return {
    ok: true,
    note: `moved the user's real pointer onto ${what} and left it there; no app activation was requested. `
      + `Observe: controls that only exist while hovered${host.hadWeb() ? " (a web view's included)" : ""} `
      + "are in the tree now, with real frames.",
  };
}




/**
 * The pointer cannot reach a control the window is not showing.
 *
 * The walk lists rows scrolled out of view, and AXPress reaches them, but their frame is off
 * screen: a mouse event there lands on the desktop or another window. The refusal names the two
 * routes that DO work rather than sending the model to another element.
 */
export function outOfReach(what: string, ref: unknown, verb: string): ActResult {
  return {
    ok: false,
    note: `${what} is not on screen — the window lists it but does not show it, so there is no point to ${verb}. `
      + `It is still the right element: run one of the actions it offers (axAction({ref:'${String(ref)}', action:…})), `
      + "or scroll it into view first and then act by ref",
  };
}


/** `drag` — mouse-down at the start, mouse-up at the destination, on the session tap. */
export async function dragVerb(host: MouseHost, acts: ElementActs, a: Record<string, any>): Promise<ActResult> {
  const from = await endpoint(host, acts, a.ref, a.name, a.x, a.y, "start");
  if ("ok" in from) return from;
  const to = await endpoint(host, acts, a.toRef, undefined, a.toX, a.toY, "destination");
  if ("ok" in to) return to;
  try {
    await host.call("drag", { pid: host.pid(), x: from.x, y: from.y, toX: to.x, toY: to.y });
  } catch (e) {
    if (e instanceof AxRequestError && e.code === "no_window") return covered(e.message);
    if (e instanceof AxRequestError && e.code === "unsupported") return noMouse("drag");
    throw e;
  }
  return { ok: true, note: `dragged ${from.what} to ${to.what} with mouse events ${raised(host.appName())}` };
}

async function endpoint(host: MouseHost, acts: ElementActs, ref: unknown, name: unknown, x: unknown, y: unknown, which: string): Promise<(Point & { what: string }) | ActResult> {
  if (typeof x === "number" && typeof y === "number") return { ...host.toScreen(x, y), what: `${x},${y}` };
  if (typeof ref !== "string") return { ok: false, note: `drag needs a ${which}: a ref or x/y` };
  const k = acts.resolve(ref, name);
  if (!("key" in k)) return k;
  const r = host.rectOf(ref);
  if (!r) return { ok: false, note: `${k.role} "${k.name}" has no frame on this walk — observe and try again` };
  return { ...centre(r), what: `${k.role} "${k.name}"` };
}

/**
 * What a mouse fallback BY REF cannot promise, said once where it applies.
 *
 * The click goes to the centre of the walk's rect, and a hover-gated web control is reported with
 * a frame COLLAPSED onto its container's edge until revealed, so the event can land on a different
 * control. A HINT, not a refusal: AX's hit test answers an unnamed `AXGroup` at the centre of EVERY
 * Chromium control, collapsed or not, so a guard built on it would refuse everything.
 */
export const COLLAPSED_FRAME_HINT = "NOTE: the click went to a ref whose frame a web view may have COLLAPSED — such a control is only "
  + "revealed on hover, so the click may have landed elsewhere: hover it, re-observe, and act on the fresh ref, or screenshot and click by x/y.";

export async function mouse(host: MouseHost, at: Point, button: string, count: number, what: string, reason?: string, byRef = false): Promise<ActResult> {
  // By REF means the point came from the walk's frame, which can be a lie. Told to the driver, not
  // written into the note: the note is composed before the observation, and a "may have missed" on
  // every click that worked is noise.
  if (byRef) host.flagCollapsedFrameRisk?.();
  const post = () => host.call("mouse", { pid: host.pid(), x: at.x, y: at.y, button, count });
  let liftedFirst = false;
  try {
    await post();
  } catch (e) {
    if (e instanceof AxRequestError && e.code === "unsupported") return noMouse(count > 1 ? `${count}× click` : `${button} click`);
    if (!(e instanceof AxRequestError && e.code === "no_window")) throw e;
    // Another app's window covers the point. This is the click's explicit foreground escalation,
    // covered by its advance permission warning; scroll instead refuses a covered point. Once
    // forward, the point is ours or the window really is not there (minimised, another Space).
    await host.call("activate", { pid: host.pid() });
    await new Promise((r) => setTimeout(r, ACTIVATE_SETTLE_MS));
    liftedFirst = true;
    try {
      await post();
    } catch (e2) {
      if (e2 instanceof AxRequestError && e2.code === "no_window") return covered(e2.message);
      throw e2;
    }
  }
  const verb = count > 1 ? `${count}× clicked` : button === "left" ? "clicked" : `${button}-clicked`;
  return {
    ok: true,
    note: `${reason ? `${reason}; ` : ""}${verb} ${what} with a mouse event at its centre ${raised(host.appName(), liftedFirst)}`,
  };
}

/** The helper answered `unsupported`: it predates mouse events (a packaged app pins
 *  COMPUTER_USE_MACOS_AX_BIN to the helper it shipped with). The AX route is unaffected. */
const noMouse = (verb: string): ActResult => ({
  ok: false, journal: NO_MOUSE,
  note: `this helper build predates mouse events, so a ${verb} is not available until the app's next update (a dev checkout compiles the helper from source); AXPress, keys and set_text are unaffected`,
});

/** Still covered after the app was brought forward: the window is not where its frame says. */
const covered = (message: string): ActResult => ({
  ok: false,
  note: `${message} even after activate brought the app forward — a mouse event lands on whatever is under the point, so the window is not on screen there (minimised, another Space, or a stale frame): observe again and act on what is listed`,
});
