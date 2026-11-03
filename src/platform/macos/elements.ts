/**
 * An AX tree from the helper → the element list the observation layer speaks. Pure functions so
 * the hermetic test can assert the mapping without a helper.
 *
 * Rects come in as GLOBAL screen points (negative on a display above the main one) and leave as
 * WINDOW-LOCAL points: a screenshot is of one window, and a point the model
 * reads off it must land on the same element the tree lists.
 */

import type { Element } from "../types.ts";
import { clean, roleOf, secondaryActions, stateOf, ubiquitousHelp, ubiquitousMarks, helpBeyond, HELP_MAX } from "./element-lines.ts";
import { foldTextRuns, textOf } from "./element-text.ts";
import type { AxElement, AxTree } from "./element-shapes.ts";

// Re-exported so callers keep ONE import site.
export type { AxElement, AxMenuItem, AxTree, AxWindow } from "./element-shapes.ts";
export { axActionName, roleOf, SECONDARY_ACTIONS } from "./element-lines.ts";
export { textOf } from "./element-text.ts";



/**
 * Hands out the ref for an element's SIGNATURE — `role|name|n` (n = its rank among same-named
 * elements of that role). The driver's allocator reuses the ref a signature had in the previous
 * snapshot, so a static text appearing above a keypad does not renumber every key.
 */
export type RefAllocator = (signature: string) => string;

export interface MappedTree {
  elements: Element[];
  /** The same shape, for what the walk found OUTSIDE the window — separate because the ref cap
   *  and row budget are priced over what the model is SHOWN ({@link Snapshot.offscreenElements}).
   *  Their refs are in `keys`/`rects` like any other, so `find` and verbs reach them. */
  offscreenElements: Element[];
  /** ref → helper key, for acting on what was observed. `enabled` rides along so the act path can
   *  see the same thing the LISTING shows as `disabled` (`act-element.ts` → `RefTarget`). */
  keys: Map<string, { key: string; name: string; role: string; actions: string[]; enabled: boolean }>;
  /** ref → window-local rect, for scoped screenshots and point fallbacks. */
  rects: Map<string, { x: number; y: number; w: number; h: number }>;
  /** Every visible string, one per line — the `text` channel. */
  text: string;
  /** Action marks every listed control shares, taken off the element lines and named once in
   *  the header instead. Empty on most windows — see {@link ubiquitousMarks}. */
  sharedMarks: string[];
}

const positional: RefAllocator = (() => {
  let n = 0;
  return () => `e${++n}`;
})();


/** Form controls that customarily sit to the right of their label — the ones {@link mapTree} names
 *  from the text beside them when the app gave them no name. Buttons are not among them: a
 *  toolbar's nameless buttons follow a title, not a label. */
const LABELLED_BY_ROW = new Set(["checkbox", "radio", "slider", "combobox", "textbox"]);


export function mapTree(tree: AxTree, refFor: RefAllocator = positional): MappedTree {
  const elements: Element[] = [];
  /** Everything an element line needs (`rows`), held until the whole list is known — the action
   *  marks cannot be rendered before then. */
  const offscreenElements: Element[] = [];
  const rows: Array<{ e: AxElement; role: string; name: string; ref: string;
    rect: { x: number; y: number; w: number; h: number }; marks: string[] }> = [];
  const keys: MappedTree["keys"] = new Map();
  const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
  const seen = new Map<string, number>();
  const focusIsExclusive = tree.elements.filter((e) => e.focused).length <= 1;
  const { x: ox, y: oy } = tree.window;
  // The last few static texts, for a control with no name of its own: SwiftUI lays a form out as a
  // `text` label then a nameless `checkbox` on the same row. Same row (vertical overlap), to the
  // left only. A FEW, not one: a caption under the title arrives last and sits below the row.
  let lastTexts: Array<{ name: string; x: number; y: number; h: number }> = [];
  // Controls' own names. A `text` row that only repeats one is the label read twice (web content
  // lists a button AND its text node), so it is dropped. Taken from the app's title/desc BEFORE
  // the loop, so a label a nameless control borrows is never dropped: it is that name's only home.
  const namedByApp = new Set(
    tree.elements.filter((e) => roleOf(e) !== "text").map((e) => clean(e.title || e.desc)).filter(Boolean),
  );
  /**
   * One pass over a set of nodes, in the app's own order. Called separately for on- and off-screen
   * nodes because text folding and label borrowing read NEIGHBOURS. `seen`/`refFor` are shared, so
   * refs stay unique; `lastTexts` is reset, so a hidden control never borrows a visible label.
   */
  const addRows = (list: AxElement[]) => {
  lastTexts = [];
  // The roles of the nearest listed ancestors, by depth — the walk is pre-order, so the last
  // element seen at a smaller depth is the parent (or the closest ancestor that was listed).
  const ancestors: Array<{ depth: number; role: string }> = [];
  for (const e of foldTextRuns(list)) {
    const role = roleOf(e);
    while (ancestors.length && ancestors[ancestors.length - 1]!.depth >= e.depth) ancestors.pop();
    const inListItem = ancestors.some((a) => a.role === "cell" || a.role === "row");
    ancestors.push({ depth: e.depth, role });
    let name = clean(e.title || e.desc || (role === "text" ? e.value : ""));
    // A nameless text field inside a list row is that row's item NAME: Finder's list view and
    // Open/Save panels publish a file as `cell > textbox value="note-01.txt"`, so `find` needs the
    // value. Applied last (below), so the ref key never sees it and a rename does not churn refs.
    const itemName = !name && role === "textbox" && inListItem && e.value ? clean(e.value) : "";
    if (role === "text" && name) lastTexts = [...lastTexts.slice(-2), { name, x: e.x, y: e.y, h: e.h }];
    const borrowed = !name && !itemName && LABELLED_BY_ROW.has(role)
      ? [...lastTexts].reverse().find((t) => t.x < e.x && t.y < e.y + e.h && e.y < t.y + t.h)
      : undefined;
    const labelled = !!borrowed;
    if (borrowed) name = borrowed.name;
    // Static text is listed only when it has content; it is what the model READS, not clicks.
    if (role === "text" && !name) continue;
    // ...and not when it only repeats a control's own name (`namedByApp`). `lastTexts` is set above
    // either way; `textOf` never filters — the text channel stays complete.
    if (role === "text" && namedByApp.has(name)) continue;
    // Still nameless: fall back to the developer's `AXIdentifier` (ax-tree.swift). Marked `#`
    // because nothing on screen says it — `find('#First Text View')` asks for it honestly. After
    // the two `text` guards on purpose: a static text with no content stays unlisted, id or not.
    const ident = !name && e.ident ? `#${clean(e.ident)}` : "";
    if (ident) name = ident;
    if (itemName) name = itemName;
    // The ref key carries what IDENTIFIES the element, never what changes while it stays put: a
    // `text` name IS its value, so a calculator display would re-mint on every keystroke. With only
    // the rank left, a text appearing ABOVE another would take its ref (`test/macos-ui.ts`), so an
    // unlabelled element is keyed by its ROW (`y`/`h`; a right-aligned display's `x`/`w` move).
    // Unnamed controls sharing a row (close/minimise/zoom) fall back to the rank. A LABELLED
    // control keys on its label (a changed label is a changed function); a developer id joins the
    // key too. Not a structural path: the helper drops what is outside the window, so a path would
    // re-mint every row of a scrolled list.
    const label = labelled ? name : (clean(e.title || e.desc) || ident);
    const head = label ? `${role}|${label}` : `${role}|@row${Math.round(e.y - oy)}+${Math.round(e.h)}`;
    const rank = (seen.get(head) ?? 0) + 1;
    seen.set(head, rank);
    const ref = refFor(`${head}|${rank}`);
    const rect = { x: Math.round(e.x - ox), y: Math.round(e.y - oy), w: Math.round(e.w), h: Math.round(e.h) };
    rows.push({ e, role, name, ref, rect, marks: secondaryActions(e.actions) });
    keys.set(ref, { key: e.key, name, role, actions: e.actions, enabled: e.enabled });
    rects.set(ref, rect);
  }
  };
  addRows(tree.elements);
  addRows(tree.offscreenElements ?? []);
  // Second pass: whether a mark is worth a per-element line is a fact about the ON-SCREEN SET
  // (ubiquitousMarks); rows the model never sees must not move it.
  const sharedMarks = ubiquitousMarks(rows.filter((r) => !r.e.off && r.role !== "text").map((r) => r.marks));
  // The id is carried on every control that has one, shown or not: `find` needs it (on a localised
  // interface the NAME goes wrong first; `AXIdentifier` does not move).
  const sharedHelp = ubiquitousHelp(rows.filter((r) => !r.e.off && r.role !== "text").map((r) => clean(r.e.help ?? "")));
  for (const r of rows) {
    const marks = sharedMarks.length ? r.marks.filter((m) => !sharedMarks.includes(m)) : r.marks;
    const ident = clean(r.e.ident ?? "");
    // `name.startsWith('#')` is the nameless fallback above — the id IS the name there, so
    // repeating it would print it twice.
    const id = ident && r.role !== "text" && r.name && !r.name.startsWith("#") ? ident : "";
    const rawHelp = clean(r.e.help ?? "");
    const beyond = r.role !== "text" && !sharedHelp.has(rawHelp) ? helpBeyond(rawHelp, r.name) : "";
    const help = beyond.length > HELP_MAX ? `${beyond.slice(0, HELP_MAX)}\u2026` : beyond;
    const el = { ref: r.ref, role: r.role, name: r.name, state: stateOf(r.e, r.role, focusIsExclusive, marks, r.name), rect: r.rect,
      ...(id ? { id } : {}), ...(help ? { help } : {}) };
    (r.e.off ? offscreenElements : elements).push(el);
  }
  return { elements, offscreenElements, keys, rects, text: textOf(tree), sharedMarks };
}
