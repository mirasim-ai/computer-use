/**
 * macOS menu commands and ⌘-chords: named menu acts use AXPress; a background chord uses the
 * helper's guarded window delivery when no AX equivalent applies.
 *
 * AXPress on a menu item runs APP-LEVEL items (New, Preferences) with the app in the background.
 * Items AppKit validates against the key window (Select All, Close, Save, Undo, Copy, Paste) read
 * `enabled=false` while the app is inactive and the press is a no-op. Two of those have an AX
 * primitive that does not care (select range, the window's close button). Other document
 * shortcuts use guarded, app-local activation and targeted key events; menu commands without a
 * shortcut still require a runnable menu item.
 */

import type { ActResult } from "../types.ts";
import type { AxMenuItem, MappedTree } from "./elements.ts";

/** What these verbs need from the driver: the helper channel, a tree walk, and the target. */
export interface MenuHost {
  checkCommand?(pid: number, item: AxMenuItem): Promise<void>;
  call<T>(op: string, params?: Record<string, unknown>): Promise<T>;
  walk(): Promise<{ mapped: MappedTree }>;
  appName(): string;
  windowId(): number | null;
  keyPostedAt(at: number): void;
  /** Press the target window's close button (the AX stand-in for a disabled ⌘W). */
  closeWindow(pid: number): Promise<void>;
  /** Make the target window the app's main one, so a menu command lands on it; true when it was
   *  not already. A session driving no particular window answers false. */
  raiseWindow(pid: number): Promise<boolean>;
  /** Is the app frontmost RIGHT NOW — asked fresh, never read off a cached app record. Separates
   *  "needs activate" from "AppKit has not re-validated the menu yet" ({@link waitForCommand}). */
  isFrontmost(pid: number): Promise<boolean>;
  /** Which ref currently stands for a helper key, or null when the walk never listed it. Lets
   *  `paste` report the focused element as the model knows it (`e12`) instead of a description. */
  refForKey(key: string): string | null;
  /** The pid a KEY EVENT must go to for this app right now: the app's own, unless its focused
   *  element belongs to another process — a remote Open/Save panel — which is then the target. */
  keyPid(pid: number): Promise<number>;
  /** Did THIS session start the app, as opposed to finding it already running? The quit guard
   *  turns on it. @see runMenuItem */
  startedHere(pid: number): boolean;
}

/** How long a just-activated app is given to re-validate its key-window commands: AppKit validates
 *  a menu when it is about to be shown, not when the app comes forward (TextEdit: still disabled
 *  at 800 ms, enabled by 2.8 s). */
const VALIDATE_TIMEOUT_MS = 4000;
const VALIDATE_POLL_MS = 250;
/** How long the pasted content stays on the clipboard before the user's own is put back: a menu
 *  AXPress returns before AppKit runs the command, so the app needs time to read the pasteboard.
 *  Long enough for a local app, short enough that the user does not notice. */
const PASTE_SETTLE_MS = 400;

/**
 * The shortcut as a person would press it, modifiers included: printing only `⌘${cmd}` makes
 * ⌥⌘N / ⇧⌘N / ⌃⌘N all read as ⌘N, and a model pressing that would match no item.
 *
 * Mask: 1 = ⇧, 2 = ⌥, 4 = ⌃, 8 = no ⌘ at all. Symbols in the order macOS itself prints them.
 */
const chordOf = (m: AxMenuItem): string =>
  `${m.mods & 4 ? "⌃" : ""}${m.mods & 2 ? "⌥" : ""}${m.mods & 1 ? "⇧" : ""}${m.mods & 8 ? "" : "⌘"}${m.cmd.toUpperCase()}`;

/** Quit and Keep Windows: refused for user-opened apps, allowed for an app this session started. */
const isQuit = (m: AxMenuItem): boolean => m.cmd.toLowerCase() === "q" && (m.mods === 0 || m.mods === 2);

async function menuItems(host: MenuHost, pid: number): Promise<AxMenuItem[]> {
  return (await host.call<{ items: AxMenuItem[] }>("menu", { pid })).items;
}

/**
 * Wait for a command to become enabled on an app that is ALREADY frontmost — the gap between
 * `activate` returning and AppKit re-validating its menus ({@link VALIDATE_TIMEOUT_MS}). Checking
 * once would refuse a command about to work and send the model back to `activate` in a loop.
 * Polling costs nothing when the command is already enabled.
 *
 * Only ever called with the app frontmost: in the background the answer will not change.
 */
async function waitForCommand(host: MenuHost, pid: number, match: (m: AxMenuItem) => boolean): Promise<AxMenuItem | null> {
  const deadline = Date.now() + VALIDATE_TIMEOUT_MS;
  let seen: AxMenuItem | null = null;
  for (;;) {
    seen = (await menuItems(host, pid)).find(match) ?? null;
    if (!seen || seen.enabled || Date.now() >= deadline) return seen;
    await new Promise((r) => setTimeout(r, VALIDATE_POLL_MS));
  }
}

/**
 * A chord copied out of a menu listing (`⌥⌘N`) written the way this API takes it (`alt+cmd+n`).
 * A chord that carries no symbol is returned untouched.
 */
export function normalizeChord(raw: string): string {
  const SYMBOLS: Record<string, string> = { "\u2318": "cmd", "\u21e7": "shift", "\u2325": "alt", "\u2303": "ctrl" };
  if (![...raw].some((c) => c in SYMBOLS)) return raw;
  const mods: string[] = [];
  let rest = "";
  for (const c of raw) {
    if (c in SYMBOLS) mods.push(SYMBOLS[c]!);
    else if (c !== "+" && c.trim()) rest += c;
  }
  return [...mods, rest.toLowerCase()].filter(Boolean).join("+");
}

/** A command chord: foreground menu delivery, or guarded delivery to a background window. */
export async function menuChord(host: MenuHost, pid: number, chord: string, count = 1): Promise<ActResult> {
  const parts = chord.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const key = parts[parts.length - 1] ?? "";
  // AX modifier mask: 1 = ⇧, 2 = ⌥, 4 = ⌃ (0 = ⌘ alone).
  const mods = (parts.includes("shift") ? 1 : 0) | (parts.includes("alt") || parts.includes("opt") ? 2 : 0) | (parts.includes("ctrl") ? 4 : 0);
  if (key === "q" && (mods === 0 || mods === 2) && !host.startedHere(pid)) {
    return { ok: false, note: `${chord} would quit ${host.appName()}, which the user had open — leave it running` };
  }
  const match = (m: AxMenuItem) => m.cmd.toLowerCase() === key && m.mods === mods;
  let item = (await menuItems(host, pid)).find(match);
  // A background sequence shares one protected activation. AX equivalents and foreground
  // menu delivery repeat individually, re-reading menu handles after every command.
  if (!(await host.isFrontmost(pid)) && !(item && !item.enabled && item.mods === 0 && ["a", "w"].includes(key))) {
    return backgroundChord(host, pid, chord, count);
  }
  const window = host.windowId();
  let completed = 0;
  let result: ActResult = { ok: true };
  try {
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        if (window !== null) {
          const { windows } = await host.call<{ windows: Array<{ id: number }> }>("windows", { pid });
          if (!windows.some((w) => w.id === window)) {
            return { ok: false, mayHaveActed: completed > 0, note: `${completed} of ${count} commands were dispatched; the bound window closed, so no more were sent. Observe before retrying` };
          }
        }
        item = (await menuItems(host, pid)).find(match);
      }
      if (item) result = await runMenuItem(host, pid, item, chord);
      else {
        await host.call("key", { pid: await host.keyPid(pid), chord });
        result = { ok: true, note: `${chord} was posted; no menu item is bound to it — observe whether the app handled it` };
      }
      if (!result.ok) return { ...result, mayHaveActed: completed > 0 || result.mayHaveActed, note: `${completed} of ${count} commands were dispatched. ${result.note ?? "Observe before retrying"}` };
      completed++;
      host.keyPostedAt(Date.now());
    }
  } catch (error) {
    if (error instanceof Error) error.message = `${completed} of ${count} commands were dispatched before interruption. ${error.message}`;
    throw error;
  }
  return count === 1 ? result : { ...result, note: `${completed} of ${count} commands were dispatched. ${result.note ?? "Observe whether they took effect"}` };
}

async function backgroundChord(host: MenuHost, pid: number, chord: string, count: number): Promise<ActResult> {
  const window = host.windowId();
  if (window === null) return { ok: false, note: "a background shortcut needs a bound window — observe and bind one first" };
  const result = await host.call<{ cleanupVerified?: boolean; lastInputAt?: number }>("backgroundkey", { pid, window, chord, count });
  host.keyPostedAt(result.lastInputAt ?? Date.now());
  return { ok: true, note: `${chord} was posted${count > 1 ? ` ${count} times` : ""} to the bound window in the background; `
    + (result.cleanupVerified === true ? "app-local deactivation was verified" : "app-local cleanup was requested")
    + " and the user's foreground was preserved — observe whether the command took effect" };
}

/** `menu` — list the commands runnable right now, or run one by its path. */
export async function menuVerb(host: MenuHost, pid: number, rawPath: unknown): Promise<ActResult> {
  const items = await menuItems(host, pid);
  const path = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!path) {
    const runnable = items.filter((m) => m.enabled && (!isQuit(m) || host.startedHere(pid)))
      .map((m) => `${m.path}${m.cmd ? ` (${chordOf(m)})` : ""}`);
    const held = items.filter((m) => !m.enabled).length;
    // The first line stands alone in the journal; the list itself is the verb's return value.
    const frontmost = await host.isFrontmost(pid);
    const posture = frontmost ? "with the app frontmost" : "with the app in the background";
    // With the app already frontmost, the disabled ones are gated by the app itself, not by
    // activation, so the tail must not advise `activate`.
    const tail = !held
      ? ""
      : frontmost
        ? `\n(${held} more are disabled right now, with ${host.appName()} already frontmost — that gate is the app's own: `
          + "a panel or sheet is up, or the command does not apply to what is open or selected)"
        : `\n(${held} more need the app's window to be key — they run after activate)`;
    return { ok: true, note: `${runnable.length} menu commands runnable ${posture} (listed below — this verb returns them):\n${runnable.join("\n")}${tail}` };
  }
  const norm = (s: string) => s.toLowerCase().replace(/\s*[›>/]\s*/g, " › ").replace(/\s+/g, " ").trim();
  const want = norm(path);
  const item = items.find((m) => norm(m.path) === want) ?? items.find((m) => norm(m.path).endsWith(` › ${want}`) || norm(m.title) === want);
  if (!item) return { ok: false, note: `no menu command "${path}" — menu without a path lists them` };
  return runMenuItem(host, pid, item, `menu {path:"${item.path}"}`);
}

/** What the app says has keyboard focus (`focused`), plus the window holding it. `key` is present
 *  only when that element is one the current tree handed out. */
interface AxFocus { key?: string; role: string; title: string; desc: string; window?: string; windowId?: number; pid?: number }

/**
 * `paste` — the clipboard, then the app's own Paste command.
 *
 * The one route into a view that refuses AXSetValue (most rich text views do) and the only one
 * carrying formatting.
 *
 * **Read this before changing anything here.** This verb cannot paste into a `ref`: Paste is a
 * COMMAND, AppKit routes it to the app's KEY WINDOW and its first responder, and setting AXFocused
 * on an element in another window changes neither — a paste can land in another open document,
 * which the app then autosaves. So it pastes at the app's own focus, and says where that is first.
 * The order below is the whole design.
 *
 *  1. The app must be FRONTMOST: a key-window command has no key window otherwise, and a
 *     background app does not reliably report focus.
 *  2. Ask the APP where its focus is. When the caller passed `ref` as its expectation, a mismatch
 *     REFUSES and names what actually holds focus.
 *  3. Only then touch the clipboard, and put the user's own content back afterwards. The stash
 *     lives inside the helper, every item and type of it: their clipboard never crosses the wire.
 */
export async function pasteVerb(host: MenuHost, pid: number, a: Record<string, any>): Promise<ActResult> {
  const text = String(a.text ?? "");
  const html = typeof a.html === "string" ? a.html : "";
  if (!text && !html) return { ok: false, note: "paste needs text (and optionally html)" };

  const isPaste = (m: AxMenuItem) => m.cmd.toLowerCase() === "v" && m.mods === 0;
  let item = (await menuItems(host, pid)).find(isPaste) ?? null;
  if (!item) {
    return { ok: false, note: `${host.appName()} has no Paste command bound to ⌘V — `
      + "set_text writes a field's whole value instead, and `menu` lists what this app does offer" };
  }
  if (!item.enabled) {
    if (!(await host.isFrontmost(pid))) {
      return { ok: false, note: `${item.path} is disabled while ${host.appName()} is in the background: `
        + "a paste goes to the app's key window, and an app that is behind has no key window — explain the foreground/clipboard effects, obtain user permission, then activate and "
        + "paste. Nothing was put on the clipboard" };
    }
    item = await waitForCommand(host, pid, isPaste);
    if (!item?.enabled) {
      return { ok: false, note: `${host.appName()} is frontmost, but ${item?.path ?? "its Paste command"} `
        + `is still disabled after ${VALIDATE_TIMEOUT_MS / 1000}s — its key window takes no paste (a panel, or nothing `
        + "focused that accepts text). Click into the field first. Nothing was put on the clipboard" };
    }
  } else if (!(await host.isFrontmost(pid))) {
    // Enabled AND behind: the menu was validated for a key window this app no longer has, so
    // where the paste would land is unknown; "it looked enabled" is not evidence.
    return { ok: false, note: `${host.appName()} is not frontmost, so it has no key window and a paste `
      + "has no defined destination — explain the foreground/clipboard effects and obtain user permission before activating. Nothing was put on the clipboard" };
  }

  // Where the app itself says the focus is: the only thing that says where the paste would go.
  let focus: AxFocus | null = null;
  try {
    focus = (await host.call<{ element: AxFocus }>("focused", { pid })).element;
  } catch {
    focus = null; // `no_element`, or a helper too old to know the op — handled just below
  }
  const where = focus
    ? `${focus.role}${focus.title || focus.desc ? ` "${focus.title || focus.desc}"` : ""}${focus.window ? ` in window "${focus.window}"` : ""}`
    : null;
  if (!where) {
    return { ok: false, note: `${host.appName()} reports nothing focused, so a paste has nowhere to `
      + "land — click into the field first. Nothing was put on the clipboard" };
  }
  if (typeof a.ref === "string" && a.ref && focus!.key !== undefined) {
    const holder = host.refForKey(focus!.key);
    if (holder && holder !== a.ref) {
      return { ok: false, note: `focus is on ${holder} (${where}), not ${a.ref} — a paste follows the `
        + `app's focus, not the ref, so it would land there. Click ${a.ref} first, then paste. Nothing was put on the clipboard` };
    }
  }

  const stashed = (await host.call<{ stashed: number }>("clipboardstash", { text, ...(html ? { html } : {}) })).stashed;
  let restored: number | null = null;
  try {
    await host.call("press", { key: item.key });
    // AXPress on a menu item RETURNS before the command has run, so restoring the clipboard at once
    // can beat the app to reading it (the paste reports success and nothing arrives).
    await new Promise((r) => setTimeout(r, PASTE_SETTLE_MS));
  } finally {
    // Always, even if the press throws: the clipboard is the user's.
    restored = await host.call<{ restored: number }>("clipboardrestore", {}).then(r => typeof r.restored === "number" ? r.restored : null, () => null);
  }
  return {
    ok: true,
    note: `ran ${item.path} at the app's focus — ${where}${html ? ", with rich text" : ""}. `
      + (restored === -1 ? "The clipboard changed during paste; its newer contents were preserved"
        : restored === null ? "Clipboard restoration could not be verified"
        : stashed
        ? "The user's clipboard was put back afterwards (an app that reads the pasteboard late could still see ours)"
        : "Their clipboard was empty before and is empty again"),
  };
}

async function runMenuItem(host: MenuHost, pid: number, given: AxMenuItem, how: string, count = 1): Promise<ActResult> {
  await host.checkCommand?.(pid, given);
  // Quitting an app the USER opened is never ours to do: their window, their unsaved work. An app
  // this SESSION started (binding a quit app launches it) may be quit, or every launched app would
  // stay running for the user to close by hand.
  if (isQuit(given) && !host.startedHere(pid)) {
    return { ok: false, note: `${given.path} would quit ${host.appName()}, which the user had open — leave it running. `
      + "Close what you opened INSIDE it instead (a document, a panel), or leave the app where it is." };
  }
  // Menu enabled flags can remain cached after a synthetic key window is removed. A caller
  // sending a chord needs key delivery even when that stale flag reads true. Named menu acts
  // keep their existing AX path; Select All and Close keep their cheaper AX stand-ins.
  if (/\bcmd\b/i.test(how) && !(await host.isFrontmost(pid))
      && !(!given.enabled && given.mods === 0 && ["a", "w"].includes(given.cmd.toLowerCase()))) {
    return backgroundChord(host, pid, how, count);
  }
  // A disabled command on a FRONTMOST app is usually AppKit not having re-validated the menu yet
  // (see waitForCommand), for every key-window command. In the background nothing is waited for:
  // the answer will not change, and the stand-ins below are the way through.
  let item = given;
  let waited = false;
  // A command goes to the KEY window, which need not be the one this session drives. Raise the
  // driven one first, then re-read the item: its enabled state is validated against the key
  // window, so it can change with it.
  let raised = false;
  if (await host.isFrontmost(pid) && await host.raiseWindow(pid).catch(() => false)) {
    raised = true;
    item = (await menuItems(host, pid)).find((m) => m.key === given.key) ?? given;
  }
  if (!item.enabled && await host.isFrontmost(pid)) {
    item = (await waitForCommand(host, pid, (m) => m.key === given.key)) ?? given;
    waited = true;
  }
  if (item.enabled) {
    await host.call("press", { key: item.key });
    // Waiting means the app is frontmost. A command enabled at once is asked afresh rather than
    // assumed to be in the background: it may run right after an activate.
    const posture = waited
      ? " — it became runnable once the app finished coming forward"
      : (await host.isFrontmost(pid)) ? " with the app frontmost" : " with the app in the background";
    const onto = raised ? ` — the driven window was raised first, so it ran there and not in the one ${host.appName()} had in front` : "";
    return { ok: true, note: `ran ${item.path} (${how})${posture}${onto}` };
  }
  // AppKit validates document commands against the KEY window, which an inactive app has none of.
  const c = item.cmd.toLowerCase();
  if (item.mods === 0 && c === "a") {
    // Through the tree's focused control when it has one: Chromium does not answer
    // AXFocusedUIElement on the app element while in the background, yet marks the focused
    // element in the tree.
    const { mapped } = await host.walk();
    const focused = mapped.elements.find((e) => /\bfocused\b/.test(e.state ?? ""));
    const key = focused ? mapped.keys.get(focused.ref)?.key : undefined;
    const { length } = await host.call<{ length: number }>("selectall", { pid, ...(key ? { key } : {}) });
    return { ok: true, note: `${item.path} is disabled while ${host.appName()} is in the background; selected the focused ${focused?.role ?? "element"}'s whole value instead (${length} chars)` };
  }
  if (item.mods === 0 && c === "w") {
    await host.closeWindow(pid);
    return { ok: true, note: `${item.path} is disabled while ${host.appName()} is in the background; pressed the window's close button instead — observe: the app may have opened a save sheet` };
  }
  // Still disabled with the app FRONTMOST: a sheet or panel is up, or the command does not apply
  // to what is focused. A panel can bind the chord itself (a Save panel's ⌘⇧G is Go to Folder,
  // while the menu's ⌘⇧G item is disabled), so a CHORD is posted anyway — to the process holding
  // the focus (`keyPid`), because an Open/Save panel is a remote view and hears only keys posted
  // to ITS process.
  if (waited) {
    const chord = /\bcmd\b/i.test(how) ? how : null;
    if (chord) await host.call("key", { pid: await host.keyPid(pid), chord });
    return {
      ok: !!chord,
      note: `${item.path} is disabled even with ${host.appName()} frontmost — a panel or sheet is up, or the command does not apply to what is focused. `
        + (chord
          ? `${chord} was posted to whatever holds the keyboard focus instead (a Save panel's own process included), since a panel can bind it itself — observe whether it took`
          : "Dismiss the panel or focus what the command acts on, then run it again"),
    };
  }
  if (/\bcmd\b/i.test(how)) return backgroundChord(host, pid, how, count);
  return {
    ok: false,
    note: `${item.path} is disabled while ${host.appName()} is in the background (macOS validates it against the key window, which an inactive app has none of) — activate, then ${how}`,
  };
}
