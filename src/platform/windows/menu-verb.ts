/**
 * `menu` on Windows — list the window's menu commands, or run one by its path in the system
 * language (`File › Save As` on an English system), the macOS verb's contract (macos/menu-commands.ts).
 *
 * Two kinds of menu bar, two routes:
 *   - a classic Win32 bar (HMENU) is read and run without opening anything: the helper reads the
 *     items from the window manager and posts the WM_COMMAND the menu itself would send;
 *   - every other bar (WinForms MenuStrip, WPF, WinUI/XAML) is UI Automation's: a path is walked
 *     the way a person does it — open each level, then press the item — and a listing opens a
 *     menu only when its items do not exist until it is open (WPF, XAML), and only in desktop mode.
 *
 * Names are matched with their decorations off: the accelerator (`File(&F)`, `&Open`), a trailing
 * `…`, and the shortcut after a tab. The last segment alone also finds a command when it is unique.
 */

import type { ActResult } from "../types.ts";
import type { UiaTree } from "./elements.ts";
import { UiaRequestError } from "./uia-client.ts";

export interface MenuHost {
  call<T>(op: string, params?: Record<string, unknown>): Promise<T>;
  hwnd(): number;
  /** Desktop interaction is allowed and the window is in front: menus may be opened. */
  canOpen: boolean;
}

type Node = UiaTree["elements"][number];

interface Command { path: string[]; enabled: boolean; submenu: boolean; checked?: boolean; id?: number }

/** A menu name without its accelerator, ellipsis or shortcut text. */
function clean(s: string): string {
  return s.split("\t")[0]!.replace(/\s*\(&?[^()\s]\)/g, "").replace(/&(.)/g, "$1").replace(/(…|\.\.\.)\s*$/, "").trim();
}
const same = (a: string, b: string) => clean(a).toLowerCase() === clean(b).toLowerCase();
const show = (path: string[]) => path.map(clean).join(" › ");
const SYSTEM_MENU = new Set(["系统", "system", "系统菜单栏", "system menu bar"]);

function line(c: Command): string {
  return `${show(c.path)}${c.submenu ? " ›" : ""}${c.checked ? " (checked)" : ""}${c.enabled ? "" : " (disabled)"}`;
}

function listing(cmds: Command[], how: string, unopened: string[]): ActResult {
  const runnable = cmds.filter((c) => c.enabled);
  const held = cmds.length - runnable.length;
  // Disabled commands are listed too: "Paste (disabled)" says there is nothing to paste yet, which
  // a count alone does not.
  const tail = (held ? `\n(${held} marked disabled do not apply to what is open or selected right now)` : "")
    + (unopened.length ? `\n(${unopened.map((p) => `${p} ›`).join(", ")} list their items only once opened — that needs interaction:'desktop')` : "");
  // The note IS the answer (as on macOS): a `value` would replace it, and with it the tail that
  // says which menus were not opened.
  return { ok: true, note: `${runnable.length} menu commands runnable (${how}; listed below — this verb returns them):\n${cmds.map(line).join("\n")}${tail}` };
}

/** The command lines of a listing's note (everything between the header and the tail). */
function listed(note: string): string[] {
  return note.split("\n").slice(1).filter((l) => l && !l.startsWith("(") && !l.endsWith("(disabled)"));
}

/** One command for `path`: the full path, or a unique last segment. */
function resolve(cmds: Command[], segs: string[]): Command | string {
  const full = cmds.find((c) => c.path.length === segs.length && c.path.every((p, i) => same(p, segs[i]!)));
  if (full) return full;
  if (segs.length === 1) {
    const tail = cmds.filter((c) => same(c.path[c.path.length - 1]!, segs[0]!));
    if (tail.length === 1) return tail[0]!;
    if (tail.length > 1) return `"${segs[0]}" names ${tail.length} menu commands (${tail.map((c) => show(c.path)).join(", ")}) — give the whole path`;
  }
  return `no menu command "${segs.join(" › ")}" — menu({}) lists them`;
}

// ── Classic Win32 (HMENU) ─────────────────────────────────────────────────────

async function classic(host: MenuHost): Promise<Command[]> {
  try {
    return (await host.call<{ items: Command[] }>("hmenu", { hwnd: host.hwnd() })).items;
  } catch (e) {
    if (e instanceof UiaRequestError && e.code === "unknown_op") return [];
    throw e;
  }
}

async function runClassic(host: MenuHost, cmds: Command[], segs: string[]): Promise<ActResult> {
  const c = resolve(cmds, segs);
  if (typeof c === "string") return { ok: false, note: c };
  if (c.submenu) return listing(cmds.filter((x) => x.path.length === c.path.length + 1 && c.path.every((p, i) => p === x.path[i])), `items of ${show(c.path)}`, []);
  if (!c.enabled) return { ok: false, note: `${show(c.path)} is disabled right now — the app does not offer it for what is open or selected. Nothing was run` };
  // `item`, not `id`: `id` is the request's own correlation id on the helper's wire.
  await host.call("hmenucmd", { hwnd: host.hwnd(), item: c.id });
  return { ok: true, note: `ran ${show(c.path)} through the menu's own command (no menu was opened) — observe for its effect; a dialog it opens is listed with the window` };
}

// ── UI Automation menus ───────────────────────────────────────────────────────

interface Walk { nodes: Node[]; parent: number[] }

async function walk(host: MenuHost): Promise<Walk> {
  const nodes = (await host.call<UiaTree>("tree", { hwnd: host.hwnd(), max: 3000 })).elements;
  const parent: number[] = [];
  const stack: number[] = [];
  nodes.forEach((n, i) => {
    while (stack.length && nodes[stack[stack.length - 1]!]!.depth >= n.depth) stack.pop();
    parent.push(stack.length ? stack[stack.length - 1]! : -1);
    stack.push(i);
  });
  return { nodes, parent };
}

/**
 * The window's own menu bar — not the title bar's system menu. WinForms and XAML report a MenuBar;
 * WPF's Menu control reports Menu (measured: no MenuBar in its tree at all), so a Menu that holds
 * menu items and sits inside no menu item counts too.
 */
function menuBar(w: Walk): number {
  const ok = (n: Node, i: number) => {
    if (n.id === "SystemMenuBar" || SYSTEM_MENU.has(clean(n.name).toLowerCase())) return false;
    for (let p = w.parent[i]!; p !== -1; p = w.parent[p]!) if (["TitleBar", "MenuItem"].includes(w.nodes[p]!.type)) return false;
    return children(w, i).length > 0;
  };
  const bar = w.nodes.findIndex((n, i) => n.type === "MenuBar" && ok(n, i));
  return bar !== -1 ? bar : w.nodes.findIndex((n, i) => n.type === "Menu" && ok(n, i));
}

/** Menu items whose nearest menu-item ancestor is `of` (the bar counts as one). */
function children(w: Walk, of: number): number[] {
  const out: number[] = [];
  w.nodes.forEach((n, i) => {
    if (n.type !== "MenuItem") return;
    let p = w.parent[i]!;
    while (p !== -1 && p !== of && w.nodes[p]!.type !== "MenuItem") p = w.parent[p]!;
    if (p === of) out.push(i);
  });
  return out;
}

const shown = (n: Node) => !n.offscreen && n.rect.w > 0 && n.rect.h > 0;
const sig = (n: Node) => `${n.name}|${n.rect.x},${n.rect.y}`;
const hasSub = (n: Node) => n.expanded === "collapsed" || n.expanded === "expanded";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open a menu item's submenu: its ExpandCollapse when it has one, else a press (bounded or real click). */
async function open(host: MenuHost, n: Node): Promise<void> {
  try { await host.call("pattern", { key: n.key, action: "expand" }); }
  catch (e) {
    if (!(e instanceof UiaRequestError)) throw e;
    await press(host, n);
  }
  await sleep(250);
}

async function press(host: MenuHost, n: Node): Promise<{ pending?: boolean; via: string }> {
  try { return await host.call<{ via: string; pending?: boolean }>("press", { key: n.key }); }
  catch (e) {
    if (!(e instanceof UiaRequestError) || (e.code !== "no_action" && e.code !== "prefer_mouse")) throw e;
    await host.call("click", { x: Math.round(n.rect.x + n.rect.w / 2), y: Math.round(n.rect.y + n.rect.h / 2), button: "left", count: 1 });
    return { via: "mouse" };
  }
}

/**
 * The items a just-opened submenu shows: the item's own children, and menu items on screen now that
 * were not before (a WPF or XAML submenu lives in a popup, outside the item). Children are kept even
 * when they claim to be off screen: WinForms reports an item that has a submenu of its own as
 * off screen inside an OPEN dropdown (measured: File › Recent was missing as a result).
 */
function opened(before: Walk, after: Walk, item: Node): number[] {
  const was = new Set(before.nodes.filter((n) => n.type === "MenuItem" && shown(n)).map(sig));
  const at = after.nodes.findIndex((n) => n.type === "MenuItem" && sig(n) === sig(item));
  const own = at === -1 ? [] : children(after, at);
  const fresh = after.nodes.map((n, i) => (n.type === "MenuItem" && shown(n) && !was.has(sig(n)) ? i : -1)).filter((i) => i !== -1);
  // One item can be walked twice — under its menu item and again in the popup window that shows
  // it (WPF: every item came out three times) — so it is one item per name and place.
  const seen = new Set<string>();
  return [...own, ...fresh].filter((i) => {
    const s = sig(after.nodes[i]!);
    return !seen.has(s) && !!seen.add(s);
  });
}

async function close(host: MenuHost, levels: number): Promise<void> {
  if (levels > 0) await host.call("key", { chord: "escape", count: levels + 1 }).catch(() => {});
}

async function listUia(host: MenuHost, w: Walk, bar: number): Promise<ActResult> {
  const cmds: Command[] = [];
  const unopened: string[] = [];
  for (const t of children(w, bar)) {
    const top = w.nodes[t]!;
    cmds.push({ path: [top.name], enabled: !top.disabled, submenu: true });
    let kids = children(w, t).map((i) => w.nodes[i]!);
    if (!kids.length && host.canOpen && !top.disabled) {
      await open(host, top);
      const after = await walk(host);
      kids = opened(w, after, top).map((i) => after.nodes[i]!);
      await close(host, 1);
    } else if (!kids.length) unopened.push(clean(top.name));
    for (const k of kids) cmds.push({ path: [top.name, k.name], enabled: !k.disabled, submenu: hasSub(k), ...(k.toggle === "on" ? { checked: true } : {}) });
  }
  return listing(cmds, "the window's menu bar", unopened);
}

async function runUia(host: MenuHost, w: Walk, bar: number, segs: string[]): Promise<ActResult> {
  // A lone name that is not a top-level menu is looked up in the listing first.
  if (segs.length === 1 && !children(w, bar).some((i) => same(w.nodes[i]!.name, segs[0]!))) {
    const all = await listUia(host, w, bar);
    const cmds = listed(all.note ?? "").map((l) => ({ path: l.replace(/ ›$| \((checked|disabled)\)/g, "").split(" › "), enabled: true, submenu: false }));
    const c = resolve(cmds, segs);
    if (typeof c === "string") return { ok: false, note: c };
    segs = c.path;
    w = await walk(host);
  }
  let level = children(w, bar).map((i) => w.nodes[i]!);
  let openLevels = 0;
  for (const [i, seg] of segs.entries()) {
    const n = level.find((x) => same(x.name, seg) && shown(x)) ?? level.find((x) => same(x.name, seg));
    const at = segs.slice(0, i + 1).join(" › ");
    if (!n) {
      await close(host, openLevels);
      const names = level.map((x) => clean(x.name)).filter(Boolean);
      return { ok: false, note: `no "${seg}" in ${i ? segs.slice(0, i).join(" › ") : "the menu bar"} (it has: ${names.join(", ") || "nothing readable"}). Nothing was run` };
    }
    if (n.disabled) {
      await close(host, openLevels);
      return { ok: false, note: `${at} is disabled right now — the app does not offer it for what is open or selected. Nothing was run` };
    }
    const last = i === segs.length - 1;
    if (last && !hasSub(n) && i > 0) {
      const r = await press(host, n);
      return { ok: true, journal: { via: r.via }, note: r.pending
        ? `ran ${at}; the app is still handling it — typically the dialog it opened. Observe to see it; do not run it again`
        : `ran ${at} (${r.via === "mouse" ? "clicked" : `pressed through UI Automation (${r.via})`}) — observe for its effect` };
    }
    if (!host.canOpen) return { ok: false, note: "running a menu command opens the menu and moves the window's focus, so it needs interaction:'desktop'; explain that and obtain permission first. Nothing was run" };
    const before = await walk(host);
    await open(host, n);
    openLevels++;
    const after = await walk(host);
    level = opened(before, after, n).map((k) => after.nodes[k]!);
    if (last) {
      await close(host, openLevels);
      const cmds = level.map((k) => ({ path: [...segs, k.name], enabled: !k.disabled, submenu: hasSub(k) }));
      return listing(cmds, `items of ${segs.map(clean).join(" › ")}`, []);
    }
  }
  return { ok: false, note: "menu needs a path" };
}

export async function menuVerb(host: MenuHost, rawPath: unknown): Promise<ActResult> {
  const path = typeof rawPath === "string" ? rawPath.trim() : "";
  const segs = path ? path.split(/\s*(?:›|>|\/)\s*/).filter(Boolean) : [];
  const hm = await classic(host);
  if (hm.length) {
    if (!segs.length) return listing(hm.filter((c) => !c.submenu || c.path.length > 1), "the window's classic menu bar, state refreshed the way opening it would", []);
    if (!host.canOpen) return { ok: false, note: "running a menu command acts on the app, so it needs interaction:'desktop'; explain that and obtain permission first. Nothing was run" };
    return runClassic(host, hm, segs);
  }
  const w = await walk(host);
  const bar = menuBar(w);
  if (bar === -1) return { ok: false, note: "this window has no menu bar UI Automation can see — its commands are buttons, a ribbon or a toolbar: observe and click them" };
  return segs.length ? runUia(host, w, bar, segs) : listUia(host, w, bar);
}
