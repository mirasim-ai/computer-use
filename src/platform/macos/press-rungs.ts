/**
 * Everything between an AXPress and the mouse (`mouse.ts`, the last rung, which raises the app):
 * what counts as EVIDENCE that a press worked, the per-app memory of presses that did not, and the
 * two rungs that act without taking the screen.
 *
 * The judge lives here because every road out of a press uses it and they must use ONE: the app's
 * own word on whether a press worked is not evidence, in either direction.
 */

import type { ActResult, Element } from "../types.ts";
import type { AxCall, ElementActs } from "./act-element.ts";
import { AxRequestError } from "./ax-client.ts";
import { roleOf, type AxElement } from "./elements.ts";
import type { AxWindowRow } from "./ax-shapes.ts";

/** What the driver lends this module: the helper channel and the geometry of the last walk. */
export interface MouseHost {
  /** Set when a click's point came from a listed frame — read by the driver's frozen hook. */
  flagCollapsedFrameRisk?(): void;
  call: AxCall;
  pid(): number;
  appName(): string;
  /** A ref's rect in global screen points (the window frame plus the walk's window-local rect), or
   *  null when the ref is not on the current walk. */
  rectOf(ref: string): { x: number; y: number; w: number; h: number } | null;
  /** A model point (the last screenshot's pixels) → global screen points. */
  toScreen(x: number, y: number): { x: number; y: number };
  /** Is this ref's frame outside the window? True for a row the walk listed but the window does
   *  not show — every AX rung still reaches it, the pointer cannot. */
  offWindow(ref: string): boolean;
  /** Walk the tree NOW (re-keying the ref table as every walk does) and hand back its elements. */
  walk(): Promise<Element[]>;
  /** Everything the LAST walk listed, the part outside the window included — what {@link changeNote}
   *  names a click's effect from. Optional: a host without it gets no such note. */
  listing?(): readonly Listed[];
  /** The highest ref number minted so far: a ref above it was first seen after this point. */
  minted?(): number;
  /** The app's bundle id — what the press memory is keyed on. */
  bundle(): string;
  /** Did the last walk find web content? Gates advice that only applies where a web view can hide
   *  or collapse a control. */
  hadWeb(): boolean;
  /** May this call post a real mouse event? False under interaction:"background", where the
   *  helper refuses one before dispatch — so a click must not plan on the mouse as its last rung. */
  pointerAllowed(): boolean;
  memory: PressMemory;
}

/** One control of a walk, as far as naming a change needs it. */
export interface Listed { ref: string; role: string; name: string; offscreen?: boolean }

/** How long an accepted AXPress is given to show up in the tree before the next rung is tried.
 *
 *  A DEADLINE with early exit, not a sleep: a press whose effect is already there on the first
 *  read pays nothing (the common case). 800 ms because System Settings panes take up to ~625 ms to
 *  reach the tree, and a press misread as "did nothing" gets redone by the mouse, raising the app. */
export const PRESS_SETTLE_MS = 800;
/** The pause between two looks; the read itself costs 60–260 ms, so this is not the polling
 *  interval. */
const PRESS_SETTLE_STEP_MS = 60;
/**
 * The app's own change notifications (`ax/ax-watch.swift`), and the three waits around them.
 *
 * Measured on System Settings, Font Book and Calculator: the first notification lands 5–45 ms
 * after the press, and one click's notifications end 20–650 ms after it. READING a window makes
 * System Settings post notifications too, which is why the mark waits for quiet first and why
 * only what is heard BEFORE the next read counts ({@link changedSince}).
 */
/** How long the app must say nothing before the mark is taken: what the baseline read stirred up
 *  has to be over, or it would be heard as the press's effect. */
const MARK_QUIET_MS = 40;
/** An app that will not be quiet this long is talking on its own; its word is not used. */
const MARK_QUIET_CAP_MS = 300;
/** How long an app is given to START saying it changed. */
const FIRST_WORD_MS = 100;
/** How long the app must then say nothing to count as done changing. */
const QUIET_MS = 100;
/** The most a click waits for an app that keeps talking (a pane that streams in, a clock). */
const QUIET_CAP_MS = 2_500;

/**
 * Per-app memory of AXPress being ignored, for one driver's life.
 *
 * Whether an app honours AXPress is a property of the APP, not the control (ChatGPT ignores it on
 * every click). After {@link THRESHOLD} consecutive ignored presses the mouse goes first, and the
 * note says how many. Two rather than one: a single miss could be the settle racing a slow redraw.
 * A press the app HONOURS clears the count, so an app that sometimes listens is never written off.
 * Held per driver, so an app update that fixes AXPress is picked up at the next session.
 */
export class PressMemory {
  static readonly THRESHOLD = 2;
  private readonly ignored = new Map<string, number>();
  count(app: string): number { return this.ignored.get(app) ?? 0; }
  ignores(app: string): boolean { return this.count(app) >= PressMemory.THRESHOLD; }
  noteIgnored(app: string): void { this.ignored.set(app, this.count(app) + 1); }
  noteHonoured(app: string): void { this.ignored.delete(app); this.honoured.add(app); }
  /** Has an AXPress on this app ever taken effect in this session? Separates "accepted and had
   *  nothing to do" from "this app drops presses". @see clickVerb's accepted-press-and-no-mouse road. */
  hasHonoured(app: string): boolean { return this.honoured.has(app); }
  private readonly honoured = new Set<string>();

  /** Set once the helper has said it cannot watch for changes at all (a prebuilt helper older than
   *  the op), so later clicks do not ask again. */
  cannotListen = false;
  /**
   * Apps that changed their window after a press and said NOTHING about it, {@link THRESHOLD}
   * times running (web content posts no notifications): listening there only delays every click
   * by the wait for a first word, so it stops. One spoken change clears the count.
   */
  private readonly silent = new Map<string, number>();
  mute(app: string): boolean { return (this.silent.get(app) ?? 0) >= PressMemory.THRESHOLD; }
  noteSilentChange(app: string): void { this.silent.set(app, (this.silent.get(app) ?? 0) + 1); }
  noteSpoke(app: string): void { this.silent.delete(app); }

  /** Apps where {@link activateByKey} has ACTIVATED a control this session, so the remembered fast
   *  path tries the keyboard before the mouse there. */
  private readonly keyWorks = new Set<string>();
  keyActivates(app: string): boolean { return this.keyWorks.has(app); }
  noteKeyWorked(app: string): void { this.keyWorks.add(app); }

  /** The irreversible control whose accepted-and-ignored press was NOT redone, awaiting the model's
   *  next click. Held for exactly one click: any click takes it, so a click elsewhere drops it. */
  private redo: string | null = null;
  armRedo(app: string, what: string): void { this.redo = `${app}\n${what}`; }
  takeRedo(app: string, what: string): boolean { const armed = this.redo === `${app}\n${what}`; this.redo = null; return armed; }
}

/** Element identity and state, focus left out: a press moves focus onto the control even when the
 *  app ignores the press itself. */
const signature = (els: readonly Element[]) => els.map((e) => `${e.role}|${e.name}|${e.state.replace(/,?\bfocused\b/, "")}`).join("\n");
/** The signature of a surface that is no longer there. Cannot collide with a real one: a walk
 *  always yields at least the window row, and `signature` never emits a NUL. */
const SURFACE_GONE = "\u0000gone";
/** What an accepted press is measured against: the tree, and the app's windows (a press whose whole
 *  effect is a new sheet or popover changes nothing in the walked window).
 *
 *  A press that CLOSED the surface answers {@link SURFACE_GONE} rather than throwing: a vanished
 *  window is the clearest evidence a press landed, and a thrown run leaves no `click` line in the
 *  journal (e.g. "Delete" in a save sheet: did it save or discard?). Only the app having NO window
 *  counts (asked, not assumed): a locked screen or an unreadable window is not a press that worked. */
const SURFACE_GONE_MSG = "the window this press acted on is gone (the app has no window now), which is as changed as a surface gets";
export async function evidence(host: MouseHost): Promise<string> {
  // Both reads start together, but the window list's rejection is SETTLED into a value rather than
  // left to `Promise.all`: a walk that throws first would leave it rejected with nobody listening,
  // and an unhandled rejection takes the whole process down.
  const windows = host.call<{ windows: AxWindowRow[] }>("windows", { pid: host.pid() })
    .then((r) => ({ rows: r.windows }), (err: unknown) => ({ err }));
  let els: readonly Element[];
  try {
    els = await host.walk();
  } catch (e) {
    const w = await windows;
    const gone = e instanceof AxRequestError && e.code === "no_window"
      && "rows" in w && w.rows.length === 0;
    if (!gone) throw e;
    return SURFACE_GONE;
  }
  const w = await windows;
  if ("err" in w) throw w.err;
  return `${signature(els)}\n#${w.rows.map((x) => `${x.id}|${x.title}|${x.focused}`).join(",")}`;
}
/** Did this press end with the surface gone? Read off {@link evidence}'s own answer, so a caller
 *  can SAY that instead of describing a window it can no longer read. */
export function surfaceGone(sig: string): boolean {
  return sig === SURFACE_GONE;
}
export { SURFACE_GONE_MSG };
/** What the app said between a mark and going quiet (`settled` in ax-watch.swift). */
interface Heard { changes: number; kinds: Record<string, number>; quiet: boolean }

/** A change the app REPORTED that the window's listing does not show, as {@link changedSince}
 *  answers it: this prefix, then what was heard. Cannot collide with a signature (no NUL there). */
const HEARD_ONLY = "\u0000heard:";

/**
 * Start listening to the app, BEFORE the action and AFTER the baseline read: the mark that
 * {@link changedSince} hears from.
 *
 * `null` whenever its word could not be used: a helper too old for the op, an app that refuses an
 * observer, an app that is talking on its own, or one this session has found mute. Never throws —
 * a click must fail on its PRESS, whose refusal names the missing grant.
 */
export async function markChanges(host: MouseHost): Promise<number | null> {
  if (host.memory.cannotListen || host.memory.mute(host.bundle())) return null;
  try {
    const m = await host.call<{ mark: number; quiet: boolean }>("watch", { pid: host.pid(), quietMs: MARK_QUIET_MS, maxMs: MARK_QUIET_CAP_MS });
    return m.quiet ? m.mark : null;
  } catch (e) {
    if (e instanceof AxRequestError && e.code === "unsupported") host.memory.cannotListen = true;
    return null;
  }
}

/** One listen: up to {@link FIRST_WORD_MS} for the app to start saying it changed, then until it
 *  goes quiet. `null` when the helper could not answer. */
async function listen(host: MouseHost, mark: number): Promise<Heard | null> {
  try {
    return await host.call<Heard>("settled", { pid: host.pid(), mark, firstMs: FIRST_WORD_MS, quietMs: QUIET_MS, maxMs: QUIET_CAP_MS });
  } catch {
    return null;
  }
}

/** "15 value changed, 2 sheet opened" — the kinds of a {@link Heard}, most frequent first. */
function heardKinds(kinds: Record<string, number>): string {
  const WORDS: Record<string, string> = {
    AXCreated: "created", AXValueChanged: "value changed", AXTitleChanged: "title changed",
    AXLayoutChanged: "layout changed", AXSheetCreated: "sheet opened", AXWindowCreated: "window opened",
    AXSelectedRowsChanged: "row selection changed", AXSelectedChildrenChanged: "selection changed",
    AXRowCountChanged: "row count changed", AXMenuOpened: "menu opened", AXMenuClosed: "menu closed",
  };
  return Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([k, n]) => `${n} ${WORDS[k] ?? k.replace(/^AX/, "")}`).join(", ");
}

/** What the app reported, when {@link changedSince} answered a change the listing does not show;
 *  else null. */
export function heardOnly(sig: string): string | null {
  return sig.startsWith(HEARD_ONLY) ? sig.slice(HEARD_ONLY.length) : null;
}

/**
 * Did the window change since `before`? Two witnesses, either one enough:
 *
 *  - the LISTING differs — the tree and the app's windows, read again ({@link evidence});
 *  - the app SAID it changed — change notifications heard after `mark` ({@link markChanges}).
 *
 * The second exists because the first is a sample of what the window shows: a press whose whole
 * effect is outside the window's frame (a list whose new rows are past its edge) leaves the
 * listing identical however long it is read, and was reported as "nothing changed". It also sets
 * the PACE: the listing is not read while the app is still posting changes (it would be read
 * half-built), and once the app goes quiet one read is the finished window.
 *
 * Only what is heard BEFORE the first read counts. A read is not silent to the app: walking a
 * lazily built list makes it post changes of its own, and those would make every press look
 * honoured. So the order is fixed — listen, then read — and an app that said nothing by then is
 * judged exactly as before: read at once, then again until {@link PRESS_SETTLE_MS} is spent.
 *
 * A focus move is neither witness: it follows a press the app ignored too.
 */
export async function changedSince(host: MouseHost, before: string, mark: number | null = null): Promise<string | null> {
  const deadline = Date.now() + PRESS_SETTLE_MS;
  const heard = mark === null ? null : await listen(host, mark);
  const spoke = heard !== null && heard.changes > 0;
  if (spoke) host.memory.noteSpoke(host.bundle());
  for (;;) {
    const now = await evidence(host);
    if (now !== before) {
      // Changed without a word, on an app that was being listened to: once more and it is mute.
      if (heard !== null && !spoke) host.memory.noteSilentChange(host.bundle());
      return now;
    }
    if (spoke) return HEARD_ONLY + heardKinds(heard.kinds);
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, PRESS_SETTLE_STEP_MS));
  }
}

/**
 * What a click changed, in the caller's own refs: the controls that appeared and the ones that
 * went, between the listing taken before the press and the one after it — so a script can go on
 * to the next control without observing and diffing by hand.
 *
 * Named controls only (a nameless row says nothing), off-window ones marked: a control that
 * appeared outside the window is there to be acted on by ref, but not to be seen in a screenshot.
 * Bounded, since a pane switch replaces everything. `null` when nothing listed came or went.
 *
 * Outside the window only a control NEVER listed before counts (`minted`: the highest ref before
 * the press), and nothing counts as gone: a list that builds its rows as they scroll in names
 * and un-names the rows past its edge on every read (System Settings' sidebar), and those would
 * be reported as the click's doing on every click.
 */
export function changeNote(was: readonly Listed[] | undefined, now: readonly Listed[] | undefined, minted = 0): string | null {
  if (!was || !now) return null;
  const SHOWN = 8;
  const named = (l: readonly Listed[]) => l.filter((e) => e.name.trim() && e.role !== "row" && e.role !== "cell");
  const refs = (l: readonly Listed[]) => new Set(l.map((e) => e.ref));
  const [had, has] = [refs(was), refs(now)];
  const fresh = (e: Listed) => Number(e.ref.slice(1)) > minted;
  const appeared = named(now).filter((e) => !had.has(e.ref) && (!e.offscreen || fresh(e)))
    .sort((a, b) => Number(!!a.offscreen) - Number(!!b.offscreen));
  const gone = named(was).filter((e) => !has.has(e.ref) && !e.offscreen);
  if (!appeared.length && !gone.length) return null;
  const list = (l: readonly Listed[], withRef: boolean) => l.slice(0, SHOWN)
    .map((e) => `${e.role} "${e.name.length > 40 ? `${e.name.slice(0, 40)}…` : e.name}"${withRef ? ` ${e.ref}` : ""}${e.offscreen ? " (outside the window)" : ""}`)
    .join(", ") + (l.length > SHOWN ? `, +${l.length - SHOWN} more` : "");
  return [appeared.length ? `appeared: ${list(appeared, true)}` : "", gone.length ? `gone: ${list(gone, false)}` : ""]
    .filter(Boolean).join("; ");
}

/**
 * Only button/toggle roles have a Space equivalent. Finder file icons also accept focus, but
 * Space opens Quick Look instead of selecting the file. A changed window cannot prove the
 * intended click happened. Unknown roles skip this rung (undefined); text fields only take
 * focus (null), since a key there would type or commit.
 */
const activationChord = (role: string): string | null | undefined =>
  /^(textbox|textarea|searchbox|combobox)$/.test(role) ? null
    : /^(button|checkbox|radio)$/.test(role) ? "Space" : undefined;

/** Does {@link activateByKey} have anything to try on this role? */
export const keyRoute = (role: string): boolean => activationChord(role) !== undefined;

/** How long the element is given to start reporting itself focused: web content applies focus a
 *  beat after accepting it (~27 ms on ChatGPT). The press's own settle, so a slow app costs no more
 *  than it would without this rung. */
const FOCUS_SETTLE_MS = PRESS_SETTLE_MS;

/** Whether the ELEMENT reports itself focused after `focus`, so a key meant for it cannot land in
 *  whatever held the focus. The op sets and reads back in one call (re-asking re-sets, idempotent).
 *  A helper too old to answer reads as false: the mouse follows, as if this rung did not exist. */
async function tookFocus(host: MouseHost, key: string): Promise<boolean> {
  const deadline = Date.now() + FOCUS_SETTLE_MS;
  for (;;) {
    if ((await host.call<{ focused?: boolean }>("focus", { key })).focused === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 40));
  }
}

/**
 * The rung between AXPress and the mouse: focus the control, then send ONE key into the app's queue.
 *
 * Some web-content controls (ChatGPT's panel toggles) answer AXPress with `success` and do nothing,
 * yet `AXFocused = true` plus Space posted to the pid works with another app frontmost. Whether
 * AXPress is ignored is a property of the app and control, never of Chromium. A KEY event has no
 * location and goes to the process's own queue, unlike a postToPid MOUSE event, which the window
 * server routes by location.
 *
 * The key goes out only once the ELEMENT reports itself focused; otherwise it lands wherever the
 * focus was (a Space typed into a draft, or one that SCROLLS the page and looks like a successful
 * click). `null` means it did not act, or acted with nothing to show: the caller falls through to
 * the mouse.
 *
 * The ref is re-resolved here rather than handed in: the baseline walk re-keys the whole table, so
 * a key resolved before it is already `stale_key`.
 */
export async function activateByKey(host: MouseHost, acts: ElementActs, ref: unknown, name: unknown, before: string | null): Promise<ActResult | null> {
  if (before === null) return null;  // no baseline, so no way to tell a key press from a no-op
  const target = acts.resolve(ref, name);
  if (!("key" in target)) return null;
  const chord = activationChord(target.role);
  if (chord === undefined) return null;
  let mark: number | null = null;
  try {
    if (!await tookFocus(host, target.key)) return null;
    // A field: the focus IS the effect a click has there, and it is already taken.
    if (chord === null) {
      host.memory.noteKeyWorked(host.bundle());
      return {
        ok: true,
        note: `AXPress on ${target.name ? `"${target.name}"` : `the ${target.role}`} changed nothing, so it was FOCUSED instead `
          + "— which is what a click on a field does. The caret is in it now (keys and type go here); no key was sent, "
          + "because on a field every key either types or commits",
      };
    }
    mark = await markChanges(host);
    await host.call("key", { pid: host.pid(), chord });
  } catch (e) {
    // Every failure here is the app declining a route that was never promised; the mouse follows.
    if (e instanceof AxRequestError) return null;
    throw e;
  }
  if (await changedSince(host, before, mark) === null) return null;
  host.memory.noteKeyWorked(host.bundle());
  return {
    ok: true,
    note: `AXPress on ${target.name ? `"${target.name}"` : `the ${target.role}`} changed nothing, so it was focused and `
      + `${chord} was sent to ${host.appName()} instead — that DID change the window, and unlike a mouse click it left `
      + "the app where it was, so the user's front window, keyboard and pointer are untouched",
  };
}

/** One ancestor as the helper reports it (`ancestors`). */
type Ancestor = { key: string; role: string; actions: string[]; selectable: boolean; selected?: boolean; name: string };

/**
 * The rung between a control that carries NO action and the mouse: act on what CONTAINS it.
 *
 * The node a user would click is often not the node that carries the click: Finder's sidebar item
 * is an action-less `AXStaticText` inside an `AXCell` offering `AXOpen`, inside an `AXRow` whose
 * `AXSelected` is settable. On Chrome and ChatGPT it is more often an ancestor with AXPress, so both
 * acts below earn their place, on different apps.
 *
 * Two acts are allowed here and no others:
 *   · `AXPress` on the container — the same act the click already meant, one level up;
 *   · `AXSelected = true` on a row or cell — what a single click MEANS for a list or a table.
 * `AXOpen` is deliberately NOT among them: on a file row it opens the file, a double click's
 * meaning. A rung that escalates the act is worse than the mouse, which at least does what was asked.
 *
 * Judged like every other rung (the window, not the app's word); one helper call, asked only when
 * the element itself advertised nothing.
 */
export async function activateByAncestor(host: MouseHost, acts: ElementActs, ref: unknown, name: unknown, before: string | null): Promise<ActResult | null> {
  if (before === null) return null;  // no baseline, so no way to tell an act from a no-op
  // Re-resolved here rather than handed in, as in {@link activateByKey}: the baseline walk REPLACES
  // the pid's key table.
  const target = acts.resolve(ref, name);
  if (!("key" in target)) return null;
  let chain: Ancestor[];
  try {
    chain = (await host.call<{ ancestors: Ancestor[] }>("ancestors", { key: target.key })).ancestors ?? [];
  } catch (e) {
    // A helper too old for the op, or an element that is already gone: the mouse follows, as if
    // this rung did not exist.
    if (e instanceof AxRequestError) return null;
    throw e;
  }
  for (const up of chain) {
    const act = up.actions.includes("AXPress") ? "press" : up.selectable ? "select" : "";
    if (!act) continue;
    // An already-selected row: the click's meaning already holds, and the window cannot change.
    // Answered as done, not handed on: the mouse on a selected file's name opens Finder's rename editor.
    if (act === "select" && up.selected) {
      const container = up.name ? `the ${up.role.replace(/^AX/, "").toLowerCase()} "${up.name}"` : "its row";
      return { ok: true, note: `${target.name ? `"${target.name}"` : "this element"} carries no click of its own and ${container} is already selected — which is what a single click here means, so nothing more was done` };
    }
    const was = host.listing?.();
    const minted = host.minted?.();
    const mark = await markChanges(host);
    try {
      await host.call(act, act === "press" ? { key: up.key, action: "AXPress" } : { key: up.key });
    } catch (e) {
      if (e instanceof AxRequestError) continue;  // that container could not either; try the next
      throw e;
    }
    // A selection is read back from the row itself: Finder's list view does not change the window
    // signature `changedSince` compares when a row becomes selected.
    const selectedNow = act === "select" && await host.call<{ ancestors: Ancestor[] }>("ancestors", { key: target.key })
      // By POSITION in the chain: `ancestors` registers each node afresh, so a key may not repeat.
      .then((r) => r.ancestors?.[chain.indexOf(up)]?.selected === true, () => false);
    if (!selectedNow && await changedSince(host, before, mark) === null) continue;
    host.memory.noteHonoured(host.bundle());
    // Named only when a walk followed the act (a selection read back from the row needs none, and
    // then the listing in hand is still the baseline's).
    const diff = selectedNow ? null : changeNote(was, host.listing?.(), minted);
    // `roleOf` reads the actions too (a node with AXPress is a button whatever its role says), so
    // both fields go in; a partial element would throw.
    const kind = roleOf({ role: up.role, actions: up.actions } as AxElement);
    const container = up.name ? `the ${kind} "${up.name}"` : `its containing ${kind}`;
    return {
      ok: true,
      note: `${target.name ? `"${target.name}"` : "this element"} carries no click of its own, so ${act === "press" ? "AXPress ran on" : "the selection was set on"} ${container} `
        + `instead — ${selectedNow ? "it reads back selected" : "that DID change the window"}, and unlike a mouse click it left ${host.appName()} where it was, so the user's `
        + `front window, keyboard and pointer are untouched${diff ? `. It ${diff}` : ""}`,
    };
  }
  return null;
}
