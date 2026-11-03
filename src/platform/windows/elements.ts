/**
 * One UIA walk (the helper's `tree`) → the driver's element list.
 *
 * What is LISTED is what a person could act on or read: controls with an action pattern or an
 * interactive control type, and named text. Unnamed layout panes and groups are the bulk of every
 * tree (Chromium wraps each control in several) and say nothing a ref could be used for, so they
 * are folded out. Rects are made window-local: the same pixel space as the window screenshot, so a
 * point read off the picture and a ref's box agree.
 */

import type { Element } from "../types.ts";
import { parseDateTime } from "./dates.ts";

/** One node as the helper reports it (`describe` in uia/src/uia.rs). */
interface UiaNode {
  key: string;
  type: string;
  name: string;
  rect: { x: number; y: number; w: number; h: number };
  depth: number;
  actions: string[];
  id?: string;
  disabled?: boolean;
  offscreen?: boolean;
  focused?: boolean;
  value?: string;
  readonly?: boolean;
  toggle?: "on" | "off" | "mixed";
  expanded?: "collapsed" | "expanded" | "partial" | "leaf";
  selected?: boolean;
  range?: number;
  defaultAction?: string;
  help?: string;
  /** A Win32 date/time picker or month calendar (helper `datetime.rs`): what it shows and the exact date. */
  datetime?: { shown: string; iso?: string; none?: boolean; calendar?: boolean };
}

export interface UiaTree {
  title: string;
  frame: { x: number; y: number; w: number; h: number };
  elements: UiaNode[];
  /** Titles of the window's open dialogs, whose controls follow the window's own in `elements`. */
  dialogs: string[];
  /** Open menus, dropdowns and flyouts (captionless windows), listed after the dialogs; absent from older helpers. */
  popups?: number;
  partial: string | null;
}

/** What a ref resolves to when it is acted on. Rect in SCREEN pixels. */
export interface RefTarget {
  key: string;
  type: string;
  name: string;
  actions: string[];
  rect: { x: number; y: number; w: number; h: number };
  /** A Win32 date/time picker: set_text types its fields instead of writing a value. */
  datetime?: boolean;
}

const ROLES: Record<string, string> = {
  Button: "button", SplitButton: "button", CheckBox: "checkbox", RadioButton: "radio", ComboBox: "combobox",
  Edit: "textbox", Document: "document", Hyperlink: "link", Image: "image", ListItem: "listitem", List: "list",
  Menu: "menu", MenuBar: "menubar", MenuItem: "menuitem", ProgressBar: "progressbar", ScrollBar: "scrollbar",
  Slider: "slider", Spinner: "spinbutton", StatusBar: "status", Tab: "tablist", TabItem: "tab", Text: "text",
  ToolBar: "toolbar", AppBar: "toolbar", ToolTip: "tooltip", Tree: "tree", TreeItem: "treeitem", DataGrid: "grid",
  DataItem: "row", Table: "table", Header: "header", HeaderItem: "columnheader", Group: "group", Pane: "pane",
  Window: "window", TitleBar: "titlebar", Thumb: "thumb", Calendar: "calendar", Custom: "custom",
};

const INTERACTIVE = new Set([
  "Button", "SplitButton", "CheckBox", "RadioButton", "ComboBox", "Edit", "Hyperlink", "ListItem", "MenuItem",
  "Slider", "Spinner", "TabItem", "TreeItem", "DataItem", "HeaderItem",
]);

/** Patterns that DO something; `scroll` and `text` alone mark containers, not controls. */
const ACTING = new Set(["invoke", "toggle", "select", "expand", "value", "range"]);

/** The ceiling on listed elements per observation; the rest are counted, never silently lost. */
const MAX_LISTED = 400;

function listed(n: UiaNode): boolean {
  // The root window is the target itself, and its title bar only repeats the title.
  if ((n.type === "Window" && n.depth === 0) || n.type === "TitleBar") return false;
  // A Win32 date picker is a bare Pane with no pattern; without this it was never listed.
  if (n.datetime) return true;
  // Background scrolling needs the exact ScrollPattern container, including unnamed lists.
  if (n.actions.includes("scroll")) return true;
  if (INTERACTIVE.has(n.type)) return true;
  const acts = n.actions.some((a) => ACTING.has(a));
  // Chromium marks whole layout containers clickable; nameless ones would only add noise refs.
  if ((n.type === "Group" || n.type === "Pane" || n.type === "Custom" || n.type === "Document") && !n.name) return false;
  if (acts) return true;
  return (n.type === "Text" || n.type === "Image" || n.type === "Hyperlink") && n.name.trim() !== "";
}

/** WPF's DatePicker: a Custom that expands (its calendar) and whose value is a date. */
function wpfDatePicker(n: UiaNode): boolean {
  return n.type === "Custom" && n.actions.includes("expand") && n.actions.includes("value") && !!n.value && !!parseDateTime(n.value);
}

function stateOf(n: UiaNode): string {
  const parts: string[] = [];
  if (n.value !== undefined && n.actions.includes("value") && !n.readonly) {
    const v = clip(n.value, 80);
    parts.push(v ? `filled:${v}` : "empty");
  }
  if (n.toggle) parts.push(n.type === "CheckBox" || n.type === "RadioButton" ? (n.toggle === "on" ? "checked" : n.toggle === "mixed" ? "mixed" : "unchecked") : (n.toggle === "on" ? "pressed" : ""));
  if (n.expanded === "expanded" || n.expanded === "collapsed") parts.push(n.expanded);
  if (n.selected) parts.push("selected");
  if (n.range !== undefined) parts.push(`value:${n.range}`);
  if (n.datetime) {
    const d = n.datetime;
    parts.push(d.none ? "empty (its checkbox is off)" : d.calendar ? `selected:${d.iso ?? "none"}` : `filled:${clip(d.shown, 40)}${d.iso ? ` (${d.iso})` : ""}`);
  }
  if (n.focused) parts.push("focused");
  if (n.disabled) parts.push("disabled");
  return parts.filter(Boolean).join(" ");
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * Build the listing and the ref table for one walk. On-screen elements are listed first (and
 * capped); off-screen ones get refs too but go to `offscreen`, the base class's separate array.
 */
export function buildElements(tree: UiaTree): { elements: Element[]; offscreen: Element[]; refs: Map<string, RefTarget>; capped: number } {
  const refs = new Map<string, RefTarget>();
  const elements: Element[] = [];
  const offscreen: Element[] = [];
  let capped = 0;
  let n = 0;
  const f = tree.frame;
  for (const node of tree.elements) {
    if (!listed(node)) continue;
    const onScreen = !node.offscreen && node.rect.w > 0 && node.rect.h > 0;
    if (onScreen && elements.length >= MAX_LISTED) { capped++; continue; }
    const ref = `e${++n}`;
    const el: Element = {
      ref,
      role: node.datetime ? (node.datetime.calendar ? "calendar" : "datetime") : wpfDatePicker(node) ? "datetime" : ROLES[node.type] ?? node.type.toLowerCase(),
      name: clip(node.name, 160),
      state: stateOf(node),
      rect: { x: node.rect.x - f.x, y: node.rect.y - f.y, w: node.rect.w, h: node.rect.h },
      ...(node.id && node.id !== node.name && !/^\d+$/.test(node.id) ? { id: node.id } : {}),
      ...(node.help && node.help !== node.name ? { help: clip(node.help, 120) } : {}),
    };
    refs.set(ref, { key: node.key, type: node.type, name: node.name, actions: node.actions, rect: node.rect, ...(node.datetime && !node.datetime.calendar ? { datetime: true } : {}) });
    (onScreen ? elements : offscreen).push(el);
  }
  return { elements, offscreen, refs, capped };
}

/** Every readable string in the window, in tree order: names, and the values of fields. */
export function windowText(tree: UiaTree): string {
  const out: string[] = [];
  for (const n of tree.elements) {
    for (const s of [n.name, n.actions.includes("value") ? n.value : n.datetime?.shown]) {
      const t = s?.trim();
      if (t && out[out.length - 1] !== t) out.push(t);
    }
  }
  return out.join("\n");
}
