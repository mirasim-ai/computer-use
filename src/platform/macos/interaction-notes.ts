/** User-visible effects, delivered both at MCP initialization and in the API reference. */
export const MACOS_INTERACTION_RULE =
  "Before an operation that may change the user's foreground, move or hold the real pointer, "
  + "redirect keyboard focus, or use the system clipboard, explain the target app and the effect "
  + "to the user and obtain permission. Reuse permission only while it covers the app, effects and "
  + "operation sequence. App-access permission alone does not authorize interrupting the user. "
  + "If permission is absent or declined, use a non-disruptive route or stop; do not silently "
  + "escalate a background attempt to foreground input.";

export const MACOS_INTERACTION_NOTES: readonly string[] = [
  MACOS_INTERACTION_RULE,
  "click does not automatically repeat a press whose result is uncertain. click(t, {retry:true}) permits that fallback "
    + "only for an action you know is harmless to repeat; it does not grant desktop permission.",
  "Each computer_repl call defaults to interaction:background: driver-controlled real pointer, activation and clipboard routes are blocked, including fallback. "
    + "After obtaining scoped permission, use interaction:desktop for the covered calls. This setting is not proof of consent. "
    + "AX actions can still cause the app itself to present windows or change state; background is not application isolation.",
  "click (including by ref) can fall back to a real mouse click and raise the app within the same call; "
    + "obtain permission before using that unrestricted path. An explicit axAction runs only the named "
    + "accessibility action, without a mouse fallback. Right/middle/double clicks and drag use real mouse events.",
  "activate brings the app's windows forward. hover and pointerMove move the real cursor and leave it there; "
    + "movement alone does not establish foreground activation. pointerPress holds a real button and temporarily "
    + "disconnects the physical mouse; always release in finally, including on failure. Without a held button "
    + "pointerRelease posts no input; pointerState is the read-only state query.",
  "scroll first tries AX paging without moving the pointer; wheel fallback posts system pointer input and requests "
    + "cursor restoration, and needs an uncovered target. Obtain permission before a scroll that may take that fallback.",
  "paste requires the app frontmost and temporarily replaces the system clipboard, then attempts to restore it. "
    + "Copy/Cut commands through keys or menu also affect the system clipboard, even in the background; they do not restore it.",
  "observe/find/text/value and surface selection do not deliberately activate the app. setText/selectText and "
    + "AX actions can change the target app's focus, caret or selection. keys/type can use protected background "
    + "delivery, but share that app's input state; coordinate with anyone using the same app/window. "
    + "A menu command in an already-frontmost app may raise the bound window. App actions can themselves open or activate windows.",
  "Open/Save-panel command shortcuts still need the app frontmost; its fields/buttons can be addressed by ref. "
    + "An instruction to activate, retry with the mouse, or use paste is not permission to do so. "
    + "A hardware-idle check is not user permission or a lock against another agent.",
];
