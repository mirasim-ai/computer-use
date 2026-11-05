/**
 * What the macOS surface SAYS — every message this driver hands back (as `driver-narrate.ts` is
 * for the base class). Pure functions only, so a wording change never touches the code that acts.
 */

import type { AxWindowRow } from "./ax-shapes.ts";

/** The refusal under a fallback list: this host cannot ask, so the list is all there is. */
export function notAllowedNote(bundle: string, fallback: Set<string> | null): string {
  return `${bundle} is not one of the apps this session may drive, and its host cannot ask the user to allow more `
    + `(it does not support MCP elicitation)${fallback?.size ? `; allowed: ${[...fallback].join(", ")}` : ""}`;
}

/** What the user is asked. The app's name first — it is what they recognise — and the bundle id
 *  after it, because two apps can share a name. */
export function consentQuestion(name: string, bundle: string): string {
  return `Allow Computer Use to use "${name}" (${bundle})?`;
}

/** Any answer but an allow. The host's own reason (nobody could be asked, nobody answered in time)
 *  is appended when it gave one: "declined" is the wrong thing to report for a prompt no one saw.
 *
 *  `allowAhead`: the command that allows the app with no prompt, when this platform keeps the
 *  "always allow" list itself (approvals.ts) — the only way to say yes at all when the host
 *  declines every question unseen (a non-interactive run such as `claude -p`). The model passes
 *  it on to the user; it never runs it. */
export function declinedNote(name: string, bundle: string, reason?: string, allowAhead?: string): string {
  return `permission to drive ${name} (${bundle}) was not granted${reason ? ` — ${reason}` : ""}. `
    + "Do not retry and do not ask again in this task; continue without it, or tell the user what you could not do"
    + (allowAhead
      ? ` — and, if nobody was there to answer (a non-interactive run declines every question), that they can allow it ahead of time with \`${allowAhead}\``
      : "");
}

/** The listing's line for an app the session has not been cleared for: nameable, never read. */
export function unclearedAppNote(): string {
  return "not allowed yet; binding it asks the user";
}

/** Why a read of an off-screen window has nothing in it, worded so the model stops rather than
 *  concluding the app has no controls. The lock comes first: it is the normal state of an
 *  unattended run. While locked the tree reads zero elements but a window capture still answers
 *  from the backing store — until the DISPLAY sleeps, when capture is refused too; hence "may",
 *  and "stop" rather than a promise of pixels. */
export function windowUnreadableNote(locked: boolean): string {
  return locked
    ? "the screen is LOCKED — while it is, macOS reports every window as off-screen with no frame and no controls, so the accessibility tree cannot be read. "
      + "This app HAS controls; the tree cannot see them until the user unlocks the screen. A screenshot may still answer from the window's backing store "
      + "(screenshot()); if it does not, report the locked screen and stop — every other app reads the same while it is locked."
    : "this window is not on screen — minimised, on another Space, or its display is asleep — so macOS reports it with no frame and no controls. "
      + "That is not an app without controls: a screenshot may still answer (screenshot()), and computer.surfaces() lists the windows that ARE "
      + "on screen; bringing this one back is the user's call.";
}

/**
 * What a launch actually DID — one wording for both callers (`driver-apps.ts`'s transparent path
 * and `launch_app`). Found vs started matters: a window the USER opened is theirs, and a set_text
 * into it is not the same act as one into a window this session just made.
 *
 * `started` comes from the helper, which asks BEFORE opening; it is never inferred here.
 */
export function launchedNote(name: string, pid: number, started: boolean): string {
  return started
    ? `${name} was not running: it was launched in the background (pid ${pid}), the user's front window untouched — what follows is a fresh start, not a window the user had open`
    : `${name} was already running (pid ${pid}), so its windows are the user's own — opened before this session, not by it`;
}

/**
 * The app came up showing only an Open/Save PANEL — no document. That panel is a remote view
 * hosted by openAndSavePanelService: keys and menu commands posted to the app do not reach it.
 * The helper detects it by window identifier (`open-panel` vs a document's `main`), because the
 * subrole is `AXStandardWindow` for both.
 */
export function panelOnLaunchNote(name: string): string {
  return `${name} came up asking which document to open, not showing one: that panel is a remote view `
    + "(openAndSavePanelService), so drive it BY REF — the app's menu commands do not reach it, and a ⌘-chord for the "
    + "panel itself (⌘⇧G Go To Folder) needs the app frontmost. "
    + "Its Cancel button leaves the app running with no document open";
}

/** An app that answers Accessibility and has NO window — said, because an empty observation
 *  reads as an app with nothing in it. `menu` is the way out, not another launch. */
export function noWindowYetNote(name: string): string {
  return `${name} has no window open: a document app with everything closed is a real state, not a failure, so the next observation will be empty. menu({}) lists its commands — File › New (named in the system language) or the like opens one; an app with no menu bar (a toolbar-only agent such as Screenshot) is opened from outside, not from here`;
}

/**
 * Nothing was named, so nothing is driven. The platform never chooses which of the user's apps to
 * operate — not the frontmost, not "the only one running": this is a required argument enforced
 * at run time. It does NOT list candidates; `computer.surfaces()` does, and inlining the app list
 * would pay for it on every first call.
 */
export const NAME_AN_APP = "mirasim-cu: no app was named, and naming one is the caller's call, not this platform's. "
  + "Take one with computer.surface('<bundle id or app name>') — binding a quit app starts it; "
  + "computer.surfaces() lists what this session can drive.";

/**
 * A host app this agent runs inside (`COMPUTER_USE_HOST_APPS`): not listed, and naming it is
 * refused. Both halves of the listing must filter it, or the "not running" half puts it back.
 */
export function ownAppNote(bundle: string): string {
  return `${bundle} is the app this agent runs inside, so it does not drive it — an observation of it would `
    + "contain this session's own UI. Drive it through its own CLI instead, and name another bundle id here.";
}

/** A named target that is a process with no UI at all (`appRow`'s `background`). Its own note:
 *  walking it spends the AX timeout and reads as a broken app, and omitting it says "not running"
 *  about a process that is. */
export function backgroundOnlyNote(bundle: string, pid: number): string {
  return `${bundle} is running (pid ${pid}) but it is a BACKGROUND-ONLY process (LSBackgroundOnly): no windows, `
    + "no accessibility tree, nothing to drive. If you meant an app with a UI, name that bundle id instead.";
}

/**
 * Elements whose AX frame lies beyond the window's bounds. The walk carries them, so `find` and
 * ref verbs reach them without scrolling; only the POINTER needs them shown, since click and hover
 * would land on the desktop (`mouse.ts` → `outOfReach`).
 */
export function offscreenWindowNote(count: number): string {
  return `${count} outside the window — NOT unreachable: they are in this observation's element `
    + `set, so find('<name>') returns one and you can act on it by ref without scrolling. Only the `
    + `POINTER needs them on screen — click/hover refuse a ref the window does not show and name `
    + `the action to run instead. Scrolling buys no TEXT in web content either: text() already has `
    + `what scrolled away, so read it before scrolling to find a phrase`;
}

/** Static text past its own budget. Separate from the control cap's note because the way out
 *  differs: a control cap means "narrow the target", while text has `text()`, never trimmed. */
export function textRunsNote(count: number): string {
  return `${count} static text runs past this observation's text budget — the element list keeps the `
    + "window's CONTROLS complete and only a leading slice of its text; text() returns all of it "
    + "(a long transcript or document is normal here, and no control is missing because of it)";
}

/**
 * A window that publishes its CHROME and nothing else — the app draws its whole interface itself
 * (Blender: three window buttons and a title). Unlike `driver-read.ts`'s nudged case (web content
 * not published YET), this one never will. The two warnings: `menu({})` lists only macOS window
 * commands for such an app, and the change verdict is a signature over this same tree, so it
 * reads `frozen` after an action that landed.
 */
export function selfDrawnWindowNote(appName: string, webShell = false): string {
  // The permanence clause differs: an Electron app refusing both accessibility switches can still
  // publish its tree later in the session, so it must not be told "no later read will improve".
  const permanence = webShell
    ? "Its interface is Chromium, and Chromium publishes its tree LATER under continued accessibility traffic — so this "
      + "may well read normally after an act or two. Use the picture now, and take one ordinary observe() again before "
      + "deciding the tree is never coming"
    : "This is NOT an app with nothing in it and no later read will improve: everything you can see is drawn by the app "
      + "itself";
  return `${appName} publishes only this window's own chrome to accessibility, so there is no control tree to act on. `
    + `${permanence}. What works here is the picture — observe({screenshot: true}), then click({x, y}) with coordinates `
    + "read off it, hover({x, y}) to place the pointer (an app that routes shortcuts by pointer position needs it there), "
    + "and keys at the app's own keyboard focus. Two things will mislead you: menu({}) lists only the app- and "
    + "window-level commands macOS owns, never this app's own features, and the change verdict is computed from this "
    + "same tree — it will say frozen after an action that worked, so judge by a fresh screenshot instead";
}

/**
 * The one line that replaces an action mark repeated on every element line. In the head, like the
 * omission note: it describes the whole list, and a delta round would drop a body line. It names
 * the verb, since the marks are the only place `ax_action pick` is discoverable.
 */
export function sharedMarksNote(marks: string[]): string {
  return `NOTE: every control below also offers ${marks.join(", ")} (ax_action) — listed here rather than on each `
    + "line because they all carry it, so it says nothing about which control to act on. An action being offered is "
    + "not a promise it works; the observation after the act is what says whether anything happened.";
}

/**
 * The app this session was driving is no longer running. Reached from the helper's `no_app` (which
 * names only a pid) and from the ambiguous "did not answer Accessibility" path: one fact, one
 * sentence.
 */
export function appExitedNote(name: string, op: string): string {
  return `${name} exited while computer-use was mid-call (${op}) — it is no longer running. `
    + "Whatever the action was, the app is gone: this is not a failed call to retry. "
    + "computer.surfaces() lists what is left; binding this app again starts a fresh one.";
}

/** A macOS window has no navigation and no tabs: refs are minted per walk against the app's
 *  accessibility tree, so one dies when its control leaves that tree or the target moves. */
export function staleRefCauseNote(): string {
  return "the control it named is gone from the window, or the target window changed";
}

// The resident prompt fragment (said to every session, not about one event) is in prompt-fragment.ts.
export { promptFragmentFor } from "./prompt-fragment.ts";



/**
 * A window the app did not have at the last walk, named in the next result.
 *
 * The read is PINNED to one window (see {@link walk}), and a modal sheet is a window of its own
 * that BLOCKS its parent — without this, a dialog raised by the model's own menu command goes
 * unsaid and every later act on the pinned window does nothing.
 *
 * Named, never FOLLOWED: this app is not ours, and the new window may be one the USER just opened.
 *
 * Two signals, because the window server numbers a window later than AX reports it (a sheet sits
 * at id `-1` past the act's own walk at ~40 ms): a new PINNABLE id is named with its focus target,
 * and a still-unnumbered window is COUNTED and said anyway, so the warning lands on the raising
 * action and the id one read later.
 *
 * Uses the existing `windows` op so a packaged app's prebuilt helper answers it too; one extra
 * round trip per walk (3–9 ms warm vs the tree's 16–20 ms).
 */
export function newWindowsNote(pid: number, fresh: AxWindowRow[], unnumberedGrew: boolean): string | null {
  // A POSSIBILITY, not a verdict: Finder's rename field is a small untitled window that closes
  // on its own.
  const blocks = "If it is a sheet or alert it BLOCKS the window you are reading, so acting here may do "
    + "nothing until it is answered; a small untitled window right after a rename or a menu command "
    + "may instead be a transient editor or popover that goes away by itself";
  if (fresh.length) {
    const named = fresh.map((w) => `"${w.title || "(untitled)"}" (focus ${pid}:${w.id})`).join(", ");
    return `this app opened a window it did not have before — ${named}. ${blocks}; focus it to see what it asks`;
  }
  if (unnumberedGrew) {
    return `this app opened a window it did not have before — macOS has not numbered it yet, `
      + `so it has no target id to focus until the next read. ${blocks}`;
  }
  return null;
}

