/**
 * `click` — the DECISION: which rung acts, and what the model is told about the one that did.
 *
 * Four rungs, cheapest for the USER first: `AXPress` on the control → the container that owns the
 * click, for a control carrying no action of its own → focusing it and posting one key → a
 * synthesised mouse event. The first three leave the app where it is; the last raises it and takes
 * the user's pointer, which is why it is last and why every note it writes says so. `mouse.ts` is
 * the pointer itself, `press-rungs.ts` is what is tried before it.
 *
 * An uncertain press is never repeated by default. `retry:true` opts a repeat-safe action into
 * the remaining rungs; irreversible names still require a separately requested second click.
 * Physical fallback also requires desktop mode and yields to active human input.
 */

import type { ActResult } from "../types.ts";
import type { ElementActs } from "./act-element.ts";
import { AxRequestError } from "./ax-client.ts";
import { roleOf } from "./element-lines.ts";
import type { AxElement } from "./element-shapes.ts";
import { centre, mouse, NO_MOUSE, outOfReach, type Point } from "./mouse.ts";
import {
  activateByAncestor,
  activateByKey,
  keyRoute,
  changedSince,
  changeNote,
  heardOnly,
  markChanges,
  surfaceGone,
  SURFACE_GONE_MSG,
  evidence,
  PRESS_SETTLE_MS,
  type MouseHost,
} from "./press-rungs.ts";

/**
 * How long the human must have been off the keyboard and pointer before the driver may take the
 * screen from them, and how long a click waits for that rather than refusing at once.
 *
 * Chosen off the cost asymmetry: refusing costs a note and a retry, while raising an app under
 * someone mid-sentence sends their next keystrokes into it. So the quiet window is generous and the
 * wait short: a human who touched the machine within 500 ms of the click (2000 − 1500) is never
 * clicked over. Checked against a real person working: the idle counter re-arms every ~0.2 s at
 * the median, so the guard holds through a whole burst of activity.
 */
const HUMAN_QUIET_MS = 2000;
const HUMAN_WAIT_MS = 1500;

/** Names of controls whose action, done twice, is done twice: no mouse click follows an accepted
 *  AXPress on one of these without a second click from the model. "Accepted, nothing changed" is
 *  also what a Send still in flight looks like, and a mouse click on top of it would send twice. */
const IRREVERSIBLE = /\b(send|submit|delete|remove|pay|purchase|buy|confirm|post|publish|order|checkout)\b|发送|提交|删除|移除|支付|购买|确认|发布|下单/i;

/**
 * The last question before the screen changes hands: is the user at the machine right now? A mouse
 * click rides the session tap, so it RAISES the app and moves the real cursor (`ax-input.swift` →
 * `mouseClick`).
 *
 * Asked HERE and not inside {@link mouse}: this guards only the escalation the DRIVER chose — a
 * plain left `click` that ran out of gentler rungs. A right, middle or double click, a `drag`, and
 * `activate` have no other route; refusing those would remove a capability, and their notes already
 * say the app comes forward.
 *
 * The reading is the human only: helper keys go `postToPid`, which moves no idle counter, and its
 * session-tap mouse events move the combined counter but not the hardware one (`humanIdleSeconds`
 * in `ax-apps.swift`). Posting a key on the session tap would break this.
 *
 * Fails OPEN: a packaged app may pin `COMPUTER_USE_MACOS_AX_BIN` to a prebuilt helper that predates
 * the op, and failing closed would break the mouse fallback there.
 */
async function yieldToHuman(host: MouseHost, what: string, reason: string): Promise<ActResult | null> {
  const deadline = Date.now() + HUMAN_WAIT_MS;
  for (;;) {
    let idle: number;
    try {
      idle = (await host.call<{ seconds: number }>("humanidle", {})).seconds;
    } catch (e) {
      if (e instanceof AxRequestError) return null;
      throw e;
    }
    if (idle * 1000 >= HUMAN_QUIET_MS) return null;
    if (Date.now() >= deadline) {
      // The refusal carries the REASON the mouse was next: the model cannot otherwise know AXPress
      // and the key rung are already spent on this control.
      return {
        ok: false,
        note: `${reason}, so the mouse was next — but it was NOT clicked: the user touched the keyboard or pointer `
          + `${idle.toFixed(1)} s ago, and a mouse click would raise ${host.appName()} and pull their cursor off `
          + "whatever they are doing. No mouse event was posted; no visible change was detected. Wait and click again — it goes through once "
          + "they stop. If it cannot wait for them, activate first, which takes the front window deliberately",
      };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** What a fallback refused for a disabled control says, with the REASON the mouse was next as in
 *  {@link yieldToHuman}. Names the escape hatch: a point click hit-tests the tree rather than
 *  consulting this flag. */
function disabledRefusal(host: MouseHost, what: string, reason: string): string {
  return `${reason}, so the mouse was next — but it was NOT clicked: ${what} reads as disabled in ${host.appName()}'s `
    + "own accessibility tree, which is why the press was ignored, and a synthesised click would raise the app and take "
    + "the user's front window to press something that is still not listening. No mouse event was posted; no visible change was detected. "
    + "Whatever gates the control — a selection, a field, a mode — has to change first; then click again. If the tree is "
    + "wrong about this control, click({x, y}) reaches the mouse deliberately.";
}

/** What a click says when the mouse was next and the call is background-only: names the rungs
 *  already spent, unlike the helper's bare "mouse requires desktop interaction". */
function backgroundRefusal(host: MouseHost, reason: string, keyTried: boolean): string {
  return `${reason}${keyTried ? ", and focusing it and sending one key changed nothing either" : ""} — so the mouse was next, `
    + "but this call is background-only: it was NOT clicked and no mouse event was posted. A real click would raise "
    + `${host.appName()} and use the user's pointer. Inspect the result first; to use the mouse, explain that effect, `
    + "obtain the user's permission, and click again with interaction:'desktop'.";
}

/**
 * `click` — AXPress first, the mouse when AXPress cannot do it or demonstrably did not.
 * `a` is the verb's arguments (ref/name or x/y, button, count); `times` is the click count.
 */
export async function clickVerb(host: MouseHost, acts: ElementActs, a: Record<string, any>, times: number): Promise<ActResult> {
  const button = a.button === "right" || a.button === "middle" ? a.button : "left";
  const hasPoint = typeof a.x === "number" && typeof a.y === "number";
  // The ref is checked against the name the model gave BEFORE anything is posted: a stale ref
  // that now sits on another control is refused here, never clicked blind at whatever its rect is.
  const target = hasPoint ? null : acts.resolve(a.ref, a.name);
  if (target && !("key" in target)) return target;
  const what = hasPoint ? "the point" : `${target!.role} "${target!.name}"`;
  const point = (): Point | null => hasPoint ? host.toScreen(a.x, a.y) : (() => { const r = host.rectOf(String(a.ref)); return r ? centre(r) : null; })();
  /** Every road into the mouse as a FALLBACK goes through {@link yieldToHuman} first. Asked this
   *  late on purpose: by the time the free rungs have failed the human may have stopped, so a check
   *  here refuses strictly less often than one at the top would. */
  /** Set when {@link fallbackToMouse} refused WITHOUT clicking — the one case where a change seen
   *  afterwards can only be the press's own. */
  let mouseRefused = false;
  /** Set once the keyboard rung has been tried on this control, for the note that follows it. */
  let keyTried = false;
  const byKey = async (base: string | null): Promise<ActResult | null> => {
    if (target && keyRoute(target.role)) keyTried = true;
    return activateByKey(host, acts, a.ref, a.name, base);
  };
  const fallbackToMouse = async (at: Point, reason: string, byRef: boolean): Promise<ActResult> => {
    const refused = await refuseMouse(reason, byRef);
    if (refused) { mouseRefused = true; return refused; }
    return mouse(host, at, "left", 1, what, reason, byRef);
  };
  const refuseMouse = async (reason: string, byRef: boolean): Promise<ActResult | null> => {
    if (!host.pointerAllowed()) return { ok: false, note: backgroundRefusal(host, reason, keyTried) };
    if (byRef && host.offWindow(String(a.ref))) return outOfReach(what, a.ref, "click");
    // A control the app reports DISABLED: the mouse would buy the user's front window for a press
    // that will be ignored too. Asked here, not at the top: AXEnabled lies often enough that vetoing
    // the free rungs would remove a capability.
    if (target && !target.enabled) return { ok: false, note: disabledRefusal(host, what, reason) };
    return yieldToHuman(host, what, reason);
  };

  // Right, middle, double: no AX action says it, so the mouse is the route, not the fallback.
  if (button !== "left" || times > 1) {
    if (!hasPoint && host.offWindow(String(a.ref))) return outOfReach(what, a.ref, `${button}-click`);
    const at = point();
    if (!at) return { ok: false, note: `${what} has no frame on this walk, so there is nowhere to ${button}-click — observe and act on a listed control` };
    return mouse(host, at, button, times, what);
  }

  // Left, on the irreversible control whose press was accepted and ignored last click: the model has
  // observed and clicked again, which is the decision to redo it with the mouse.
  const redo = host.memory.takeRedo(host.bundle(), what);
  // Left, on an app this session has already caught ignoring AXPress: the mouse goes first, and the
  // note says on what evidence — no baseline walk, no press, no settle.
  const remembered = host.memory.count(host.bundle());
  if (redo || host.memory.ignores(host.bundle())) {
    // The keyboard rung goes before the mouse on an app whose controls have answered it this
    // session, on a `redo` (the note the model acted on names both routes, key first), and whenever
    // the mouse is off the table (background interaction), where it may be the only route that lands.
    if (target && (redo || host.memory.keyActivates(host.bundle()) || !host.pointerAllowed())) {
      let base: string | null = null;
      try { base = await evidence(host); } catch { /* no baseline */ }
      const keyed = await byKey(base);
      if (keyed) return keyed;
    }
    const at = point();
    if (!at) return { ok: false, note: `${what} has no frame on this walk, so there is nowhere to click — observe and act on a listed control` };
    return fallbackToMouse(at, redo
      ? `the last click on ${what} was an AXPress the app accepted and ignored, and this second click is the decision to redo it with the mouse`
      : `${host.appName()} has ignored AXPress ${remembered} times this session, so the mouse goes first`, !hasPoint);
  }
  // Left: the baseline (tree + windows; not the last observation, since a click may follow a click
  // with no observation between), the press, then the same read again after the settle. A
  // baseline that cannot be read is no evidence either way, so the press alone decides — and
  // ungranted, it is the PRESS that has to fail, because its refusal names the Accessibility grant
  // where a failed read would talk about a tree that cannot be read (test/macos-grants.ts pins it).
  let before: string | null = null;
  try { before = await evidence(host); } catch { /* no baseline */ }
  // The baseline's listing (what the effect is named against), and the app's change notifications
  // from here on. After the baseline on purpose: a walk can make a lazy list build rows, and what
  // the app says about THAT is not the press.
  const was = before === null ? undefined : host.listing?.();
  const minted = host.minted?.();
  const mark = before === null ? null : await markChanges(host);
  /** What an effect reads as: the window's listing changed, or only the app said so. */
  const effect = (after: string): { how: string; diff: string | null } => {
    const said = heardOnly(after);
    return {
      how: said === null ? "the window changed" : `${host.appName()} reported changes (${said}) though nothing listed inside the window differs`,
      diff: changeNote(was, host.listing?.(), minted),
    };
  };
  let pressed: ActResult;
  if (hasPoint) {
    const at = host.toScreen(a.x, a.y);
    // An errored hit test is NO INFORMATION, not a refusal: Excel's grid answers AXError -25208 to
    // `at` for every point, and a self-drawn area is precisely what a point click exists to reach.
    // Only a grant or a lost app still propagates.
    let hitFailed = "";
    const hit = await host.call<{ element: AxElement }>("at", { pid: host.pid(), ...at })
      .catch((e: unknown) => {
        if (e instanceof AxRequestError && (e.code === "no_element" || e.code === "ax_error")) {
          hitFailed = e.code === "no_element" ? "nothing pressable under the point" : `the tree could not say what is under the point (${e.message})`;
          return null;
        }
        return Promise.reject(e);
      });
    // Nothing pressable under the point is exactly a self-drawn control — the mouse's case.
    if (!hit) return fallbackToMouse(at, hitFailed || "nothing pressable under the point", false);
    // Nor is a press the element under the point refuses: it is often a container with no action
    // of its own (Blender publishes only its window). Only a grant or a lost app still propagates.
    const under = `${roleOf(hit.element)} "${hit.element.title || hit.element.desc}"`;
    let pressFailed = "";
    await host.call("press", { key: hit.element.key }).catch((e: unknown) => {
      if (e instanceof AxRequestError && (e.code === "no_element" || e.code === "ax_error")) {
        pressFailed = `the ${under} under the point does not take a press (${e.message})`;
        return;
      }
      return Promise.reject(e);
    });
    if (pressFailed) return a.retry === true ? fallbackToMouse(at, pressFailed, false)
      : { ok: false, mayHaveActed: true, note: `${pressFailed}. The press result is uncertain; no mouse retry was sent. Inspect the result before retrying.` };
    pressed = { ok: true, note: `pressed ${under} under the point` };
  } else {
    // A label with no action is a request to its owning row. Resolve that route before
    // posting an unsupported press; otherwise even a harmless row selection becomes an
    // uncertain dispatch that cannot safely be followed by another action.
    if (target && !target.actions.length) {
      const ancestor = await activateByAncestor(host, acts, a.ref, a.name, before);
      if (ancestor) return ancestor;
    }
    // An element with AXOpen and no AXPress is most often a FILE ROW's name, where AXOpen is a
    // double click (it opens the file). A single click there selects the row, which the ancestor
    // rung does; only when nothing up the chain selects does AXOpen stand in.
    if (target && !target.actions.includes("AXPress") && target.actions.includes("AXOpen")) {
      const selected = await activateByAncestor(host, acts, a.ref, a.name, before);
      if (selected) return selected;
    }
    pressed = await acts.press(a.ref, a.name, 1);
    // A refusal decided before any call (stale ref, wrong name) stands; only a press that REACHED
    // the app and was refused or ignored there is the mouse's to redo.
    if (!pressed.ok && !pressed.mayHaveActed) return pressed;
    // A SUBSTITUTE action ran (AXOpen, AXPick — act-element.ts names it in the note): the app's own
    // open or selection, which may do more than a click and must not be followed by one.
    if (pressed.ok && pressed.note) return pressed;
  }
  let reason: string;
  if (!pressed.ok) {
    // The refusal's first sentence says what the control offers instead; its advice ("act on a
    // listed control…") is superseded by the click that follows.
    reason = pressed.note?.split(/\. /)[0] || `the app refused AXPress on ${what}`;
    // An AXError is a report about the CALL, not a verdict on the EFFECT: Office's start-gallery
    // buttons answer -25205 and open the document anyway. Same baseline and same judge as the
    // accepted road below.
    const after = before === null ? null : await changedSince(host, before, mark);
    if (after !== null) {
      host.memory.noteHonoured(host.bundle());
      const { how, diff } = effect(after);
      // Claim what this driver DID, never where the app ended up: opening a document raises Word on
      // its own.
      return { ok: true, note: `${reason} — but ${surfaceGone(after) ? SURFACE_GONE_MSG : how}, so it acted: the error was about the call, not about the effect. It was not redone with the mouse, so nothing here brought ${host.appName()} to the front${diff ? `. It ${diff}` : ""}` };
    }
    if (a.retry !== true) {
      return { ok: false, mayHaveActed: true, note: `${reason}. The result is uncertain; no keyboard or mouse retry was sent. `
        + "Inspect the result before retrying. click(t, {retry:true}) permits another dispatch only when repeating the action is known to be harmless." };
    }
  } else {
    if (before === null) return pressed;
    const after = await changedSince(host, before, mark);
    if (after !== null) {
      host.memory.noteHonoured(host.bundle());
      // A press that took the surface with it says so: the caller cannot read the window any more,
      // and "which button did I just press" must not be left to inference from the next failure.
      if (surfaceGone(after)) return { ...pressed, note: `${pressed.note ?? "pressed"} — ${SURFACE_GONE_MSG}` };
      // What the press changed, in refs the caller can act on at once. A change only the app
      // reported is said as that: the listing inside the window is the same, so the note is the
      // one place the caller learns the press did land.
      const { how, diff } = effect(after);
      const said = heardOnly(after) === null ? "" : how;
      const note = [pressed.note, said, diff].filter(Boolean).join(" — ");
      return note ? { ...pressed, note: pressed.note ? note : `pressed ${what} — ${note}` } : pressed;
    }
    host.memory.noteIgnored(host.bundle());
    reason = `AXPress on ${what} was accepted but nothing in the window changed within ${PRESS_SETTLE_MS} ms`;
    // An unchanged screen cannot distinguish a no-op from a request still in flight.
    // Do not infer that repeating is safe from the control's name alone.
    if (a.retry !== true || (target && IRREVERSIBLE.test(target.name))) {
      host.memory.armRedo(host.bundle(), what);
      // Both remaining routes are named, in the order they run, so a background caller learns of the
      // keyboard route and does not read the click as needing desktop permission.
      const keyNext = target && keyRoute(target.role)
        ? `focusing it and sending one key (${host.appName()} stays where it is), then a real mouse click` : "a real mouse click";
      return { ok: true, mayHaveActed: true, note: `${reason}. It was not repeated: pressing ${what} twice could act twice. `
        + `What is left is ${keyNext}${host.pointerAllowed() ? "" : " (not in a background-only call)"}. `
        + "Inspect the actual result; only after ruling out a completed or pending action, click it again to try that. "
        + "For an action known to be harmless to repeat, click(t, {retry:true}) permits it in the same call. The mouse still requires desktop permission." };
    }
  }
  // The control may still answer the keyboard. Reached on both roads into the mouse (refused, and
  // accepted-and-ignored), never on the irreversible control, which returned above.
  if (target) {
    const keyed = await byKey(before);
    if (keyed) return keyed;
  }
  const at = point();
  if (!at) return { ...pressed, note: `${pressed.note ?? reason} — and it has no frame on this walk for a mouse click to fall back to` };
  const clicked = await fallbackToMouse(at, reason, !hasPoint);
  // A helper too old for mouse events: the press's own result stands, and the note says what is missing.
  if (clicked.journal === NO_MOUSE) return { ...pressed, mayHaveActed: true, note: `${reason}; ${clicked.note}` };
  // The mouse was refused without clicking, and the refusal took its time (it waits for the user).
  // A press whose effect arrives after the settle (a popover opened as its own window) has landed by
  // now; one more read, where nothing but the press can have caused a change.
  if (!clicked.ok && mouseRefused && before !== null) {
    const late = await evidence(host).catch(() => null);
    if (late !== null && late !== before) {
      host.memory.noteHonoured(host.bundle());
      return {
        ok: true,
        note: `${reason} — but the window HAD changed by the time the mouse was refused (${surfaceGone(late) ? SURFACE_GONE_MSG : "a late redraw or a new window"}), `
          + "so the press landed after the settle; the mouse was not used",
      };
    }
  }
  // The press was ACCEPTED, this app has honoured presses this session, and the mouse could not run
  // to check. Failing would report a correct no-op (clearing a clear display) as broken; claim only
  // what is known — the press landed, the confirmation did not happen.
  if (!clicked.ok && pressed.ok && host.memory.hasHonoured(host.bundle())) {
    return {
      ok: true,
      mayHaveActed: true,
      note: `${reason}, and the mouse could not confirm it — ${clicked.note}. This app HAS honoured AXPress in this `
        + "session, so the likeliest reading is that the press landed and had nothing to change. Observe before "
        + "deciding it failed, and click again if the screen says otherwise",
    };
  }
  return clicked.ok ? clicked : { ...clicked, mayHaveActed: true };
}
