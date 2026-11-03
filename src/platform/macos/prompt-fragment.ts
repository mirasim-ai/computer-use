/**
 * The resident PROMPT fragment: what every session on this platform is told before it sees a
 * window — how a click behaves, what stays in the background, which read answers which question.
 *
 * Unlike `narrate.ts` (said ONCE, about something that just happened), this is charged to every
 * session, so app-specific sentences belong in `app-notes.ts`. Reached through
 * `ComputerUseDriver.promptFragment` as this platform's part of the MCP `instructions`
 * (entries/mcp.ts).
 */

import { MACOS_INTERACTION_RULE } from "./interaction-notes.ts";

export function promptFragmentFor(): string {
  return MACOS_INTERACTION_RULE + " Grounding: observations are text lists of one macOS application window's controls with refs, read from the app's accessibility tree. " +
    "Act by ref from the latest observation. Clicks and set_text go through the app's own accessibility actions and work while the app stays in the " +
    "BACKGROUND — the user keeps their keyboard and pointer. When an app accepts a click and ignores it (Electron web content does), the control is " +
    "focused and sent one key instead, still in the background; only if that changes nothing is the click redone as a real mouse event, which can bring the " +
    "app to the front — the result says which of the three acted. That last one waits if the user is typing or moving the pointer right then, and says " +
    "so instead of acting: click again and it goes through once they stop. Right/middle clicks, double clicks and drag are always mouse events. " +
    // Click by position (`clickVerb` branches on x/y) is the way out for a control no ref reaches;
    // said HERE, with the "act by ref" rule it qualifies, not only in the API reference.
    "A control you can SEE and cannot name — self-drawn, with no node of its own in the tree — is reachable by POSITION: take " +
    "w.observe({screenshot: true}) and w.click({x, y}) with the coordinates read off that picture. It is not a raw mouse event: the " +
    "point is hit-tested against the tree first, so when something pressable IS under it the click goes through that element's " +
    "own AXPress and the app stays behind, exactly as a click by ref would; only a point with nothing pressable under it becomes " +
    "a real mouse event that can bring the app forward. What it gives up is identity — there is no ref to go stale and no name to " +
    "disagree — so it acts on whatever is at that spot now: read the coordinates off a fresh picture, never off an old one. " +
    "A ⌘ shortcut (keys cmd+…) uses accessibility equivalents or guarded key events to the bound window in the background; " +
    "`menu` lists the app's commands or runs one by name. Document shortcuts such as Bold and Save can work without activate; " +
    "observe whether the app handled them. Remote Open/Save panels still need the app frontmost for ⌘ shortcuts, and paste still needs " +
    "the app's real focus. An interrupted background shortcut says so — observe before retrying. `activate` deliberately brings the app " +
    "to the front and takes the user's keyboard. " +
    "Plain keys and typing in a native background window use the same protected delivery. Interrupted input reports how much was posted; " +
    "read the field before continuing, since replaying a partial operation can duplicate input. " +
    "set_text fills a field by ref; a field that commits on Enter says so in its result (w.keys('Enter') commits). Where set_text does not stick — a file " +
    "being renamed, a search field that filters as you type — focus the field (click, or selectText with caret) and w.type({text}) sends real keystrokes. " +
    "Background input is bound to the driven window; remote-panel keys and typing go to the panel's own process. " +
    // The ChatGPT-specific half lives in `app-notes.ts`; this is the part any web field needs.
    "A web-content field's VALUE can be its placeholder, so a field whose value is exactly its own label is probably empty — " +
    "accessibility cannot tell you which, so do not treat it as a draft to preserve. " +
    "A read that looks PARTIAL is usually not: text() carries a web-content window's whole transcript even where it has scrolled out " +
    "of sight (measured — a wheel burst changed the window and returned identical text), so scrolling to read more is wasted. " +
    "When a read and the window seem to disagree, take a screenshot and look, rather than scrolling to find out. " +
    "Text that is still ARRIVING reads as fragments: a streaming answer puts one AX node per token, so text() comes back with " +
    "the words broken across lines and the element list churns on every read. That settles by itself — wait for what marks the " +
    "end (w.wait({control_gone:'Stop'}) beats a fixed sleep), then read once. " +
    "A long document or transcript is not a tree problem: to LOCATE a phrase, use the app's own Find — keys cmd+f, " +
    "fill the find field, keys Enter — which is exact where a list is not. Verify typed input by read-back; an app can reformat or ignore it. " +
    "Apps and windows are surfaces: computer.surfaces() lists them as handles, and acting through a handle switches to it. " +
    "The listing carries the apps with a Dock presence; a menu-bar-only app (a status item, the screen-capture toolbar) is " +
    "not in it but IS drivable — name its bundle id. " +
    "Use text() to read all text in the window.";
}
