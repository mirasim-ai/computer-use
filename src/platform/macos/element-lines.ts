/**
 * One element → one LINE: what a single control's row says.
 *
 * `elements.ts` walks the TREE and decides which nodes become rows; this decides what each row
 * READS like — role name, name and value caps, the state bracket, and the action marks hoisted out
 * of it when every control shares them.
 */

import type { AxElement } from "./element-shapes.ts";

/**
 * `AXButton` → `button`, in the vocabulary the browser driver taught the model. Only roles a
 * model treats differently get a name; the rest keep their AX name minus the prefix, because a
 * coarser vocabulary loses information (an outline is not a table).
 */
const ROLE_NAMES: Record<string, string> = {
  AXButton: "button",
  AXPopUpButton: "combobox",
  AXMenuButton: "button",
  AXDisclosureTriangle: "button",
  AXColorWell: "button",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXTextField: "textbox",
  AXTextArea: "textbox",
  // NOT "textbox": a document area and its find field would render as two nameless `textbox`
  // rows side by side, and a set_text aimed at one lands in the other (in TextEdit it replaced a
  // whole document). `searchbox` is the browser platform's word too (chromium/collect.ts).
  AXSearchField: "searchbox",
  AXComboBox: "combobox",
  AXLink: "link",
  AXMenuItem: "menuitem",
  AXSlider: "slider",
  AXIncrementor: "spinbutton",
  AXTabGroup: "tablist",
  AXStaticText: "text",
  AXImage: "image",
  AXWebArea: "webarea",
  AXCell: "cell",
  AXRow: "row",
};

/**
 * Subroles that say more than the role does; the SUBROLE wins where both answer. AppKit reports a
 * find field as `AXTextField` with subrole `AXSearchField` (TextEdit), so a split on the role alone
 * never fires; the role table keeps its own entry for apps that report it there instead.
 */
const SUBROLE_NAMES: Record<string, string> = {
  AXSearchField: "searchbox",
};

export function roleOf(e: AxElement): string {
  const bySub = SUBROLE_NAMES[e.subrole];
  if (bySub) return bySub;
  const named = ROLE_NAMES[e.role];
  if (named) return named;
  if (e.actions.includes("AXPress")) return "button";
  return e.role.replace(/^AX/, "").toLowerCase() || "element";
}

/**
 * The two bounds an element LINE lives under, verbatim from the browser's (`chromium/collect.ts`)
 * so a model meets ONE vocabulary. Whitespace is collapsed because a multi-line value would split
 * one element over several lines, breaking the one-element-per-line contract the delta diffs.
 *
 * A NAME is capped with NO marker: it is the identity the caller passes back, so it stays literal.
 * A VALUE is capped with the cut MARKED, so a trimmed value never reads as the whole value.
 */
export const collapse = (s: string): string => (s ?? "").trim().replace(/\s+/g, " ");
export const clean = (s: string): string => collapse(s).slice(0, 80);
const cut = (s: string): string => {
  const v = collapse(s);
  return v.length > 60 ? v.slice(0, 60) + "\u2026" : v;
};

/**
 * AX actions worth telling the model about: the ones that DO something a click cannot (a popup's
 * menu, a menu item's pick, a stepper's increment). Rendered as `+menu` / `+pick` in the state
 * bracket and accepted back by `ax_action` under either spelling.
 *
 * A WHITELIST because the common extras are noise: AXScrollToVisible sits on nearly every node,
 * AXShowDefaultUI / AXShowAlternateUI are hover affordances. Anything left out stays reachable —
 * `ax_action` takes any action the element advertises, and a refusal lists them.
 *
 * A mark is NOT a capability: apps advertise their NSAccessibility defaults, often fictions
 * (Calculator's toolbar buttons list AXIncrement/AXDecrement). Only the observation after the act
 * is evidence; the verb's own description carries this warning, because the model reads that.
 */
export const SECONDARY_ACTIONS: Record<string, string> = {
  AXShowMenu: "menu",
  AXIncrement: "increment",
  AXDecrement: "decrement",
  AXConfirm: "confirm",
  AXOpen: "open",
  AXPick: "pick",
};

// AXRaise and AXCancel are deliberately absent. AppKit implements them on the WINDOW, which the
// walk never lists (`ax-tree.swift` starts at the window element), and `+cancel` shows up only
// where running it does nothing (every item of a context menu leaves the menu up). Leaving them
// out costs no reach — `axActionName` accepts any `AX...` spelling. Cancelling a sheet is `click`
// on its button; raising a window is `activate`, which says out loud that the keyboard moves.

/** The short names of the notable actions this element advertises, in whitelist order so two
 *  elements offering the same actions always render the same string — these lines are what
 *  the delta diffs. */
export function secondaryActions(actions: string[]): string[] {
  return Object.entries(SECONDARY_ACTIONS).filter(([ax]) => actions.includes(ax)).map(([, short]) => short);
}

/**
 * A mark almost every listed control shares says nothing about WHICH control to act on, and costs
 * per element on every observation. Native windows measured 12–50% marked; Chromium / Electron
 * 69–99%, because a Chromium AX tree advertises AXShowMenu on every node (one window: ~400 tokens
 * of `,+menu` per observation). Such marks are HOISTED, not dropped: the header names them once
 * (`sharedMarksNote`), keeping e.g. `ax_action pick` discoverable.
 *
 * 90% sits above the transient case — an open context menu whose items all advertise pick (86% of
 * a small TextEdit window), where the mark is the reason to act — and keeps the decision stable,
 * since a set that flips across observations rewrites every element line.
 */
const MARK_UBIQUITOUS_SHARE = 0.9;
/**
 * How many CONTROLS a window must list before a share means anything. The denominator is
 * controls, not elements, because text runs never carry these marks and would dilute a 99%
 * toolkit fact (ChatGPT: 206 of 208 controls, 69% of all rows).
 *
 * The floor keeps out the small window an open context menu makes up most of; on real windows a
 * context menu is 5–7% of the controls, while toolkit-marked windows listed 157–208 controls.
 */
const MARK_MIN_CONTROLS = 40;

/** Marks carried by at least {@link MARK_UBIQUITOUS_SHARE} of the listed CONTROLS, in whitelist
 *  order so the header line is stable across observations. */
export function ubiquitousMarks(perControl: string[][]): string[] {
  if (perControl.length < MARK_MIN_CONTROLS) return [];
  const tally = new Map<string, number>();
  for (const marks of perControl) for (const m of marks) tally.set(m, (tally.get(m) ?? 0) + 1);
  const bar = perControl.length * MARK_UBIQUITOUS_SHARE;
  return Object.values(SECONDARY_ACTIONS).filter((m) => (tally.get(m) ?? 0) >= bar);
}

/**
 * Help strings worth nothing per element, as with a ubiquitous MARK (Excel puts one shortcut hint
 * on twenty ribbon controls). The bar is lower than the marks' share because a help string is a
 * whole clause: five controls sharing one already costs more than it tells.
 */
const HELP_UBIQUITOUS_MIN = 5;
export const HELP_MAX = 80;

/** Letters and digits only, for comparing a help string with its name: `Close group: Its sessions
 *  keep running` vs `Close group (Its sessions keep running)` with full-width parentheses differ only in punctuation. */
const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** What a help string adds OVER the name, or "" when it adds nothing. A tooltip that opens with the
 *  control's own name is common (`Search` helps `Search ⌘K`): only the tail tells anything. */
export function helpBeyond(help: string, name: string): string {
  if (!help) return "";
  if (!name) return help;
  if (bare(help) === bare(name)) return "";
  const tail = help.toLowerCase().startsWith(name.toLowerCase())
    // Separators only — never an opening bracket, which would leave its partner behind
    // (`Copilot Assistant(⌃⌘I)` came out as `⌃⌘I)`).
    ? help.slice(name.length).replace(/^[\s:：,，、.。\-—]+/u, "").trim()
    : help;
  return bare(tail) === bare(name) ? "" : tail;
}

export function ubiquitousHelp(helps: string[]): Set<string> {
  const tally = new Map<string, number>();
  for (const h of helps) if (h) tally.set(h, (tally.get(h) ?? 0) + 1);
  return new Set([...tally].filter(([, n]) => n >= HELP_UBIQUITOUS_MIN).map(([h]) => h));
}

/** A model-written action name → the AX action to send. Takes the rendered short name (`menu`),
 *  the full one a refusal lists (`AXShowMenu`), either case — the model reads both. Null when the
 *  string names no AX action at all. */
export function axActionName(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const [ax, short] of Object.entries(SECONDARY_ACTIONS)) {
    if (short === lower || ax.toLowerCase() === lower) return ax;
  }
  return /^AX[A-Za-z]+$/.test(raw) ? raw : null;
}

/** Toolbar segments are `AXCheckBox` with a `0`/`1` value; sliders carry a number.
 *  `marks` arrives already filtered — see {@link ubiquitousMarks} for what the walk takes out.
 *  `name` is the line's own name, which a `text` row needs — see the readout rule below. */
export function stateOf(e: AxElement, role: string, focusIsExclusive: boolean, marks: string[], name: string): string {
  const parts: string[] = [];
  if (!e.enabled) parts.push("disabled");
  // A folded run says so: the line carries a preview, and how many fragments are behind it.
  if (e.runOf) parts.push(`${e.runOf} text runs`);
  if (role === "textbox" || role === "combobox") parts.push(e.value ? `filled:${cut(e.value)}` : "empty");
  else if (role === "checkbox" || role === "radio") parts.push(/^(1|true|yes)$/i.test(e.value) ? "checked" : "unchecked");
  // A READOUT — a `text` node whose value is not its label (a calculator's display: label
  // "edit field", value 77) — must show the value: otherwise the model cannot read it, and
  // `press-rungs.ts`, judging an AXPress by whether the lines CHANGED, reads a repeated digit as
  // ignored and redoes it with the mouse (entering it twice). A text row whose name already IS
  // its value stays out.
  else if (e.value && (role !== "text" || clean(e.value) !== name)) parts.push(`value:${cut(e.value)}`);
  // A checkbox or radio already says so above; for a button, row or cell it is the only word on
  // which one of a set is chosen (System Settings' Light / Dark / Auto carry nothing else).
  if (e.selected && role !== "checkbox" && role !== "radio") parts.push("selected");
  // Focus is exclusive, so a tree claiming it many times means the app does not track it
  // (TextEdit's Open dialog: all 14 source-list cells): dropped unless exactly one element claims
  // it. menu-commands.ts picks the focused element by this mark, else asks the app directly.
  //
  // The action marks go BEFORE focus, never after: `stripFocus` cancels a focus-only diff by
  // matching a trailing " [focused]", and anything appended past it would un-anchor that regex.
  if (marks.length) parts.push(`+${marks.join(",")}`);
  if (e.focused && focusIsExclusive) parts.push("focused");
  return parts.join(",");
}
