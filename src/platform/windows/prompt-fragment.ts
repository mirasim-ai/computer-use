/**
 * What every session on the Windows platform is told before it sees a window (the MCP initialize
 * `instructions`, via `ComputerUseDriver.promptFragment`), and the interaction notes the API reference
 * carries.
 *
 * Background UIA disables AutoSetFocus and only admits tested pattern/control families.
 * Desktop interaction activates the window and can use the user's mouse/keyboard. An app can
 * still react to UIA by opening windows or moving focus; background interference stops the run.
 *
 * Under it sits the per-APP consent (app-gate.ts): an app the user has not allowed is listed by its
 * program name only, and the first read or action on it asks them.
 */


/** Per-app consent, said wherever the surfaces are introduced: a model that does not know it reads
 *  a title-less listing as a broken one and an answered refusal as something to retry. */
const WINDOWS_APP_CONSENT =
  "Every app — reading it included — must be cleared for this session. One not cleared yet is listed by its program name only "
  + "(\"WINWORD — not cleared in this session yet…\"); bind it by that name, and the bind clears it: at once when the user always allows it, "
  + "otherwise by asking them (pass `purpose` to say why). If they decline, do not retry or ask again in this task.";

const WINDOWS_INTERACTION_RULE =
  "Windows defaults to limited background UIA: supported setText, click, uiaAction and scroll by ref do not activate the window "
  + "or inject mouse/keyboard input, and never fall back to those routes. Apps may still react by opening windows or changing "
  + "focus; detected interference stops background actions on that window. Do not automatically replay uncertain actions. "
  + "They are refused while the target window is in front, where the user may be typing: they would move focus inside it. "
  + "Coordinates, type, keys, hover, activation and unsupported controls need interaction:'desktop', which brings the window "
  + "to the FRONT and can use the real pointer/keyboard. Explain those effects and obtain permission before choosing desktop. "
  + "Reading never activates the window; app-access approval is required in both modes.";

export const WINDOWS_INTERACTION_NOTES: readonly string[] = [
  WINDOWS_INTERACTION_RULE,
  WINDOWS_APP_CONSENT,
  "Background setText requires a readable, writable ValuePattern on an editor in a standard Win32/WinForms/WPF window (including "
    + "Notepad), a Chromium page (Chrome, Edge), an Electron app or a XAML app; password fields and unsupported editors are refused "
    + "before writing. It never focuses, selects all or types as a fallback.",
  "In a Chromium page, an Electron app (VS Code…) or a XAML/DirectUI app (Settings, Calculator, Explorer), background click does "
    + "what a desktop click does through UIA: it selects an item, presses a button or link, toggles a checkbox, or expands/collapses; "
    + "uiaAction({ref, action}) runs a named one. Elsewhere it only selects standard list items and toggles WinForms/WPF checkboxes; "
    + "other Win32/WinForms/WPF buttons, menus and expansion are excluded. Those apps must be unminimized (they may stay covered). "
    + "A press is dispatched, not verified: observe its result. Missing patterns are refusals, not a reason to switch modes automatically.",
  "Background scroll needs a specific ScrollPattern container ref from observe/find; window-wide scrolling has no background "
    + "fallback. count is 1–20 UIA large increments; to:'top'/'bottom' uses the scroll percentage.",
  "In desktop mode, click by ref does what a single click does: it SELECTS a list/tree/table item (open one with count:2), "
    + "picks an entry of an open combo box list, and presses a control through its UIA action — WinForms buttons and menu items "
    + "with the real mouse, since their handlers run inside UIA and a dialog they open would freeze it. A press that opens a dialog "
    + "reports the app as still busy; observe and answer the dialog, never press again. Right/middle/double clicks and point clicks "
    + "use the real mouse. A tree node [collapsed] is expanded with uiaAction({ref, action:'expand'}), not by clicking it. "
    + "interaction:desktop is not proof of consent; obtain it first.",
  "Open menus, dropdown lists and context menus are read with the window: their items are listed last.",
  "An app with no window open is started by binding its Start-menu name (computer.surface('Calculator')) or, from a bound window, "
    + "launchApp({app}); listApps({query}) gives the names, which are in the system language. Starting one opens its window in "
    + "front of the user, so both need interaction:'desktop' and the user's permission; the app itself is cleared like any bind, "
    + "before it is started — one the user declines is never started.",
  "A menu-bar command runs by its path: menu({path:'File › Save As'}) — names in the system language, so list them first with "
    + "menu({}); the last segment alone works when unique, and a path ending at a submenu lists it. A classic Win32 menu bar runs "
    + "the command directly; others are opened level by level. Prefer it to clicking through menus yourself.",
  "A datetime element (a Win32/WinForms date or time picker) shows its text and exact date; setText(ref, '2026-03-09'), "
    + "'14:30' or '2026-03-09 14:30' types it field by field as a person would (the app sees each step) and reads it back. "
    + "A calendar element is read-only here: pick a day by clicking it in a screenshot.",
  "To change part of a field, selectText({ref, text, near}) selects that text (read back from the field) and focuses it; type, "
    + "keys or paste then replace just that. caret:'before'/'after' puts the caret there instead; caret alone goes to the start/end. "
    + "paste({text, html, ref}) uses Ctrl+V through the user's clipboard, which is put back afterwards and kept out of clipboard "
    + "history: tell the user, and pass ref so a paste into the wrong field is refused before the clipboard is touched.",
  "drag({ref or x/y, toRef or toX/toY}) holds the real left button along a path and releases it: files onto folders, slider "
    + "thumbs, strokes on a drawing canvas (which often has no ref — take a screenshot and drag by coordinates inside it).",
  "If the user is typing in another window, Windows can refuse to bring the target forward; the action then reports that and sends nothing. "
    + "While a Windows security prompt is in front, nothing can come forward until the user answers it: tell them, do not retry.",
  "The user comes first. A desktop action waits up to 1.5 s for them to pause the keyboard and pointer for 2 s, and otherwise is refused "
    + "with nothing sent — wait and retry. If they switched to another app since your last action, they have taken over: actions "
    + "are refused until you tell them what is left and, once they agree, take the window back with kind:'activate'. A type or "
    + "keys call stops part-way when they touch the keyboard or mouse; observe what landed instead of resending.",
  "setText waits for the requested value. type captures the focused editor and its selection before input, then waits for that same "
    + "editor to match the expected edit when readable. A mismatch stops subsequent actions; unavailable read-back is explicitly unverified. "
    + "Do not replay uncertain input. Field comparisons normalize CRLF/LF; real trailing newlines are retained.",
  "keys accepts Multiply, Add, Subtract and Divide (also NumpadMultiply, NumpadAdd, NumpadSubtract and NumpadDivide), "
    + "case-insensitively. These send the native keypad key, without depending on Shift+8 or a keyboard layout.",
  "Decimal and NumpadDecimal enter the system's decimal separator as text, without changing NumLock. They do not accept modifiers. "
    + "NumLock itself is available only as an explicit keypress; Decimal never toggles it.",
];

export function promptFragmentFor(): string {
  return WINDOWS_INTERACTION_RULE + " Grounding: observations are text lists of one Windows application window's controls with refs, "
    + "read from its UI Automation tree (the same tree screen readers use). Act by ref from the latest observation. "
    + "set_text uses a field's UI Automation value; focusing/selecting/typing fallback exists only in desktop mode. "
    + "A control you can SEE and cannot name (self-drawn, no node in the tree) is reachable by position: take w.observe({screenshot: true}) "
    + "and w.click({x, y}) with coordinates read off that picture. Chromium/Electron apps publish their tree a moment after the first read, "
    + "so a near-empty first observation of one is worth repeating once. Windows are surfaces: computer.surfaces() lists every visible "
    + "application window by title and program name — " + WINDOWS_APP_CONSENT + " "
    + "Use text() to read all text in the window.";
}
