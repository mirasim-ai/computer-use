/**
 * What the stubbed macOS app IS: one Calculator-shaped accessibility tree, the element sets each
 * suite switches on, and the app lists the real helper keeps apart (`apps` answers from a snapshot
 * taken when it started, `lookup` from what is running now).
 *
 * This is the DATA; `macos-fixtures.ts` is the transport that answers about it.
 */

import type { AxElement, AxTree } from "../src/platform/macos/elements.ts";

/** A window on a display ABOVE the main one: negative screen y, like the measured Calculator. */
export const WINDOW = { id: 62106, title: "计算器", onScreen: true, x: 1602, y: -121, w: 458, h: 408 };
/** The same app once its window is off the window server's list (a LOCKED screen, a minimised
 *  window or a sleeping display): no id, a zero frame, the title degraded to the app's own name,
 *  and a walk that succeeds with nothing. */
export const OFFSCREEN_WINDOW = { id: -1, title: "计算器", onScreen: false, x: 0, y: 0, w: 0, h: 0 };
export const el = (o: Partial<AxElement> & { key: string; role: string }): AxElement => ({
  subrole: "", title: "", desc: "", value: "", x: 0, y: 0, w: 48, h: 48, enabled: true, focused: false, actions: ["AXPress"], depth: 4, ...o,
});
/** A document longer than the helper's walk carries: the preview is the first 400 chars. */
export const LONG_VALUE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}: the quick brown fox jumps over the lazy dog`).join("\n");

export const TREE: AxTree = {
  window: WINDOW,
  visited: 36,
  capped: false,
  offscreen: 0,
  overflow: 0,
  textOverflow: 0,
  nudged: false,
  locked: false,
  // `seq` is the walk's visit counter — the app's own document order. The visible rows take the
  // MIDDLE of it so the scrolled-away pair in `macos-fixtures.ts` sits one above and one below:
  // only that shape tells an ordered merge from one that appends (elements.ts `inDocumentOrder`).
  elements: [
    el({ key: "k0", seq: 10, role: "AXStaticText", value: "56,088", x: 1721, y: -32, w: 101, h: 36, actions: [] }),
    el({ key: "k3", seq: 11, role: "AXButton", desc: "全部清除", x: 1666, y: 12 }),
    el({ key: "k6", seq: 12, role: "AXButton", desc: "7", x: 1612, y: 66 }),
    el({ key: "k9", seq: 13, role: "AXButton", desc: "乘", x: 1774, y: 66 }),
    el({ key: "k12", seq: 14, role: "AXTextField", title: "Expression", value: "", x: 1612, y: 120, w: 200, h: 24, actions: [] }),
    el({ key: "k13", seq: 15, role: "AXCheckBox", subrole: "AXSegment", desc: "粗体", value: "1", x: 1612, y: 160, w: 20, h: 20 }),
    el({ key: "k14", seq: 16, role: "AXButton", desc: "Disabled thing", enabled: false, x: 1612, y: 200 }),
  ],
};

/** A source-list pair, the shape of TextEdit's Open dialog: the ROW offers nothing that can act as
 *  a click, the CELL under it advertises AXOpen and no AXPress; both nameless (the name sits on a
 *  static-text child). Appended only under {@link Stub.sourceList}, so other checks' refs hold. */
export const SOURCE_LIST: AxElement[] = [
  el({ key: "k15", role: "AXRow", x: 1612, y: 240, w: 180, h: 24, actions: ["AXShowDefaultUI", "AXShowAlternateUI"] }),
  el({ key: "k16", role: "AXCell", x: 1612, y: 240, w: 180, h: 24, actions: ["AXOpen"] }),
];
/** Finder's sidebar item: the LABEL carries no action at all. Its cell and row are not in the
 *  walk's flat list here — they are what `ancestors` answers for it. */
export const SIDEBAR: AxElement[] = [
  el({ key: "k30", role: "AXStaticText", value: "文稿", x: 1612, y: 300, w: 180, h: 24, actions: [] }),
];
/** What appears once that row is selected: the pane it navigated to. */
export const SIDEBAR_PANE: AxElement[] = [
  el({ key: "k31", role: "AXStaticText", value: "文稿 — 8 项", x: 1810, y: 300, w: 200, h: 24, actions: [] }),
];
/** A hover-gated web control as Chromium reports it BEFORE the pointer arrives: a real name and a
 *  frame collapsed onto another control's (ChatGPT's per-message Copy buttons). Its centre is
 *  inside "All Clear", which a mouse fallback would click. Appended under {@link Stub.collapsed}. */
export const COLLAPSED: AxElement[] = [
  // The web area comes WITH it: a frame collapses onto its container's edge only in a web view,
  // so an app with no web view cannot produce one.
  el({ key: "k23", role: "AXWebArea", desc: "ChatGPT", x: 1612, y: 0, w: 400, h: 400, actions: [] }),
  el({ key: "k24", role: "AXButton", desc: "Copy message", x: 1666, y: 12, w: 40, h: 20 }),
];
/**
 * A window's own text area and a find bar's search field, adjacent and BOTH nameless: they must
 * not render as two identical rows, or a set_text aimed at the field lands in the document. As in
 * TextEdit, the document carries an identifier and the search field none.
 */
export const FIND_BAR: AxElement[] = [
  el({ key: "k30", role: "AXTextArea", ident: "First Text View", value: "第一行\n第二行", x: 1612, y: 240, w: 400, h: 120, actions: [] }),
  // The search field is a TEXT FIELD whose SUBROLE says what it is; its identifier is an
  // AppKit serial the helper must not send.
  el({ key: "k31", role: "AXTextField", subrole: "AXSearchField", ident: "_NS:98", x: 1612, y: 370, w: 200, h: 22, actions: ["AXShowMenu", "AXConfirm"] }),
];
/** The control whose accepted-and-ignored press is never redone unasked (mouse.ts IRREVERSIBLE). */
export const SEND = el({ key: "k19", role: "AXButton", desc: "Send", x: 1612, y: 330, w: 60, h: 24 });
/** A label, the nameless checkbox on its row, a nameless checkbox on the NEXT row (no label of its
 *  own — must stay nameless), and a search field offering only AXConfirm. */
export const FORM_ROW = [
  el({ key: "k22", role: "AXStaticText", value: "启动时播放声音", x: 1612, y: 380, w: 140, h: 20, actions: [] }),
  el({ key: "k21", role: "AXCheckBox", value: "1", x: 1800, y: 378, w: 40, h: 24 }),
  el({ key: "k23", role: "AXCheckBox", value: "0", x: 1800, y: 410, w: 40, h: 24 }),
  el({ key: "k20", role: "AXTextField", value: "", x: 1612, y: 440, w: 200, h: 24, actions: ["AXConfirm"] }),
];

/** Two more controls carrying an existing name — see {@link Stub.sameNames}. */
export const SAME_NAMES: AxElement[] = [
  el({ key: "k25", role: "AXButton", desc: "全部清除", x: 1666, y: 300, w: 40, h: 20 }),
  el({ key: "k26", role: "AXButton", desc: "全部清除", x: 1666, y: 330, w: 40, h: 20 }),
];

/** A control that carries BOTH developer facts: an id that is not its name, and a tooltip that
 *  opens with its name (so only the tail is worth a line), next to one whose help merely repeats
 *  the name in other punctuation. `Stub.helpAndId` appends them. */
export const HELP_AND_ID: AxElement[] = [
  el({ key: "k60", role: "AXButton", title: "搜索", ident: "SearchButton", help: "搜索 ⌘K", x: 1700, y: 300 }),
  el({ key: "k61", role: "AXButton", title: "关闭窗口：其标签页保持打开", ident: "关闭窗口：其标签页保持打开", help: "关闭窗口（其标签页保持打开）", x: 1760, y: 300 }),
];

/** A pair whose value is in the actions BESIDE the click: a stepper that increments and a popup
 *  that drops a menu — the two shapes `ax_action` exists for. Appended only under
 *  {@link Stub.secondary}, so every other check's refs stay where they are. */
export const SECONDARY: AxElement[] = [
  el({ key: "k17", role: "AXIncrementor", desc: "Repeat", value: "3", x: 1612, y: 280, w: 40, h: 30,
    actions: ["AXIncrement", "AXDecrement"] }),
  el({ key: "k18", role: "AXPopUpButton", desc: "Base", x: 1660, y: 280, w: 90, h: 30,
    actions: ["AXPress", "AXShowMenu"] }),
];
/** A window full of text rows — ChatGPT's conversation shape. None of the text carries a mark,
 *  which is why the share is taken over controls: counting these rows dilutes a toolkit fact. */
export const CHATTY: AxElement[] = Array.from({ length: 120 }, (_, i) => el({
  key: `x${i}`, role: "AXStaticText", value: `line ${i} of a long transcript`, x: 1610, y: 1400 + i * 12, w: 300, h: 11,
  actions: [],
}));

/** Few controls, all marked — an open context menu in a SMALL window. Below the control floor,
 *  so the marks stay on the lines where they are the reason to act. */
export const TINY_MENU: AxElement[] = Array.from({ length: 18 }, (_, i) => el({
  key: `m${i}`, role: "AXMenuItem", title: `item ${i}`, x: 1610, y: 40 + i * 16, w: 120, h: 14,
  actions: ["AXPress", "AXPick"],
}));

/** A Chromium-shaped tree: enough controls for a share to mean something, and nearly all of them
 *  advertising AXShowMenu, as an Electron app's window does. */
export const CROWDED: AxElement[] = Array.from({ length: 80 }, (_, i) => el({
  key: `c${i}`, role: "AXButton", desc: `control ${i}`, x: 1610, y: 40 + i * 16, w: 80, h: 14,
  actions: i === 0 ? ["AXPress"] : ["AXPress", "AXShowMenu"],
}));

// TextEdit's menu bar with the app in the BACKGROUND: app-level commands enabled, document
// commands disabled (AppKit validates them against the key window, which an inactive app lacks).
export const MENU = [
  { key: "m1", path: "文件 › 新建", title: "新建", enabled: true, cmd: "N", mods: 0 },
  { key: "m2", path: "文件 › 关闭", title: "关闭", enabled: false, cmd: "W", mods: 0 },
  { key: "m3", path: "文件 › 保存…", title: "保存…", enabled: false, cmd: "S", mods: 0 },
  { key: "m4", path: "文件 › 存储为…", title: "存储为…", enabled: false, cmd: "S", mods: 1 },
  { key: "m5", path: "编辑 › 全选", title: "全选", enabled: false, cmd: "A", mods: 0 },
  // Paste is validated against the key window too, so it reads disabled in the background —
  // why `paste` must check it BEFORE it overwrites the clipboard. {@link Stub.frontmost} flips it.
  { key: "m7", path: "编辑 › 粘贴", title: "粘贴", enabled: false, cmd: "V", mods: 0 },
  { key: "m6", path: "TextEdit › 退出 TextEdit", title: "退出 TextEdit", enabled: true, cmd: "Q", mods: 0 },
];
// 1×1 transparent PNG — the driver only decodes base64 and trusts the helper's scale.
export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Helper ops that answer without the Accessibility grant, as verified against the real helper
 *  ungranted: enumeration is `NSWorkspace`, `launch` is `open -b`, `activate` is
 *  `NSRunningApplication`, and `shot` is gated by Screen Recording instead. `windows` is NOT here:
 *  `axWindows` guards on `AXIsProcessTrusted`, so an ungranted session lists apps and no windows —
 *  the shape {@link MacosDriver.targetsNote} describes. Every ACT op is gated; ungated,
 *  `press`/`setvalue`/`focus` answer `stale_key` and the CGEvent posts (`key`/`type`/`scroll`)
 *  answer SUCCESS while the event is discarded. */
export const UNGATED_OPS = new Set(["capabilities", "apps", "lookup", "installed", "launch", "shot", "activate", "humanidle"]);

export interface StubApp { bundle: string; name: string; pid: number; active: boolean; hidden: boolean; background?: boolean }

/** Installed but NOT running — what the `installed` op answers for a bundle no process holds.
 *  `com.example.nope` is deliberately absent: a bundle nothing installs yields no row at all. */
export const INSTALLED_NOT_RUNNING: Record<string, string> = {
  "com.apple.Notes": "备忘录",
  "com.apple.QuickTimePlayerX": "QuickTime Player",
};
/** What is running when the helper starts. */
export const APPS_AT_START: StubApp[] = [
  { bundle: "com.example.agenthost", name: "Agent Host", pid: 19428, active: true, hidden: false },
  { bundle: "com.apple.calculator", name: "计算器", pid: 49403, active: false, hidden: false },
  { bundle: "com.apple.TextEdit", name: "TextEdit", pid: 777, active: false, hidden: false },
];
/** Running, but only a NAMED lookup can see them: the real helper's enumeration keeps the
 *  `.regular` filter while a lookup does not (ax-apps.swift `liveApps`). A menu-bar app is
 *  drivable; a `.prohibited` process has no UI at all and says so through `background`. */
export const LOOKUP_ONLY: StubApp[] = [
  { bundle: "com.bjango.istatmenus.status", name: "iStat Menus Status", pid: 1983, active: false, hidden: false },
  { bundle: "com.apple.chronod", name: "chronod", pid: 671, active: false, hidden: false, background: true },
];

/** Apps `launch` can produce — none of them running when the helper starts. */
export const LAUNCHABLE: Record<string, StubApp> = {
  "com.apple.Notes": { bundle: "com.apple.Notes", name: "备忘录", pid: 888, active: false, hidden: false },
};
