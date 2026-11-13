/**
 * The canned macOS helper the driver tests run against — no helper process, no app.
 *
 * One job: answer the helper's protocol the way the Swift helper does, refusals included
 * (`not_trusted`, `not_granted_screen`, `stale_key`, `no_window`, `no_app`, `no_scroll_area`),
 * over the tree and app lists in `macos-stub-app.ts`. The knobs on {@link Stub} are how a suite
 * says which shape it wants.
 */

import { AxRequestError, type AxTransport } from "../src/platform/macos/ax-client.ts";
import type { AxElement } from "../src/platform/macos/elements.ts";
import {
  APPS_AT_START, CHATTY, COLLAPSED, CROWDED, el, FORM_ROW, LAUNCHABLE, LONG_VALUE, LOOKUP_ONLY,
  MENU, OFFSCREEN_WINDOW, PNG_1PX, SAME_NAMES, SECONDARY, FIND_BAR, HELP_AND_ID, SEND, SOURCE_LIST, type StubApp,
  INSTALLED_NOT_RUNNING, SIDEBAR, SIDEBAR_PANE, TINY_MENU, TREE, UNGATED_OPS, WINDOW,
} from "./macos-stub-app.ts";

export interface Stub {
  transport: AxTransport; calls: Array<{ op: string; params: Record<string, unknown> }>;
  trusted: boolean; resultRow: boolean; overflow: number; launchReady: boolean;
  scrollArea: boolean; scrollAt: number; scrollMax: number; scrolledAway: boolean; lazyRows: number; findBar: boolean; launchWindowless: boolean; launchPanelOnly: boolean; windowsGone: boolean;
  /** Leave exactly one drivable app in the enumeration, by bundle id. Set, never read back. */
  only(bundle: string): void;
  /** Static text the walk counted instead of listing — the budget that is NOT the control cap. */
  textOverflow: number;
  cappedBy: "" | "nodes" | "time";
  /** Append {@link COLLAPSED} — a control whose frame sits on top of another control's. */
  collapsed: boolean;
  /** Give the display a LABEL of its own, as Calculator does (AXDescription "edit field", number in
   *  AXValue): its name stays put while its value moves, so a press could read as ignored. */
  labelledReadout: boolean;
  /** The Electron window that answers the accessibility switch and still has almost nothing in
   *  it: three nameless buttons and `nudged: true`. */
  thinAfterNudge: boolean;
  /** Finder's sidebar shape: an action-less LABEL in an AXOpen cell in a selectable row.
   *  Selecting the row makes the pane's content appear — how the click judge sees the rung work. */
  sidebar: boolean;
  /** The window drops off the window server's list; `locked` says the screen is why. */
  offScreen: boolean; locked: boolean;
  /** Off-screen AND the tree still answers for a couple of controls — a read, not a refusal. */
  offScreenElements: boolean;
  /** Off the window server's list but still reporting its real frame (a just-launched window). */
  framedOffScreen: boolean;
  /** Append {@link SOURCE_LIST} — a row and a cell whose only actions are not AXPress. */
  sourceList: boolean;
  /** Append {@link SECONDARY} — a stepper and a popup, the controls whose actions matter. */
  secondary: boolean;
  /** Append {@link CROWDED} — the tree shape whose action marks are hoisted into the header. */
  crowded: boolean;
  /** Add 120 unmarked text runs — the transcript shape. */
  chatty: boolean;
  /** This many of those runs read differently on the NEXT walk — a streaming answer, whose text
   *  rows are keyed by value and so churn the delta (driver-narrate.ts). */
  chattyChurn: number;
  /** Replace the window with 18 all-marked menu items — a small window where the marks matter. */
  tinyMenu: boolean;
  /** The app is frontmost, so the key-window commands (Select All, Paste) are enabled — what
   *  `activate` buys in reality. */
  frontmost: boolean;
  /** …but not YET: this many `menu` reads still answer disabled first, as AppKit does for a
   *  second or two after an app comes forward. */
  menuLag: number;
  /** What the app answers for `focused`: a key from the current tree ("k12"; the generation
   *  suffix is added for you), "none" for no focus, or "elsewhere" for a focus the walk never
   *  listed (another window's field, where a write would land in the user's file). */
  focusOn: string;
  /** A second window of the app: 'numbered' has a window-server id, 'unnumbered' is the state a
   *  just-raised sheet is in first (id -1). */
  extraWindow: false | "numbered" | "unnumbered";
  /** The tree's text area answers with a PREVIEW plus the cut flag. */
  cutValue: boolean;
  /** …and the `value` op cannot complete it. */
  valueUnavailable: boolean;
  /** The capture answers even while the window is off the list — measured under a real lock. */
  shotOffScreen: boolean;
  /** Screen Recording, the OTHER grant: independent of `trusted`, and only `shot` needs it. */
  screenGranted: boolean;
  /** A helper too old to know `capabilities`: COMPUTER_USE_MACOS_AX_BIN can point at any vintage,
   *  and a listing must survive one. */
  oldHelper: boolean;
  /** The app answers AXError to this action although the element ADVERTISES it (Chrome's address
   *  bar: -25204 to AXShowMenu, sometimes opening the menu anyway). Not the honest "never had it". */
  refuseAction: string | null;
  /** Append {@link HELP_AND_ID} — the two shapes a developer id and a tooltip come in. */
  helpAndId: boolean;
  /** Which window the walk reports it read (0 = whatever {@link TREE} says). The driver keys its
   *  ref map on it (driver-read.ts `refsByWindow`), so a test can visit many windows by setting it. */
  treeWindowId: number;
  /** AXPress is accepted and nothing moves — the Electron case (mouse.ts). */
  pressInert: boolean;
  /** The element takes the focus and answers Space — the keyboard rung (press-rungs.ts). */
  spaceActs: boolean;
  /** What the app SAYS after a press (change notifications by name → count), whatever the press
   *  did to the listing: with {@link pressInert}, a press whose whole effect is outside the window.
   *  null = the app says nothing, as web content does. */
  saysOnPress: Record<string, number> | null;
  /** The app posts changes on its own, so a mark never finds it quiet (`watch` → quiet: false). */
  talking: boolean;
  /** A helper that predates the `watch` / `settled` ops. */
  noWatch: boolean;
  /** A press adds a control to the window (the `Send` button). */
  pressReveals: boolean;
  /** A press that answers an AXError and acts anyway (Word's start gallery). */
  pressErrorsButActs: boolean;
  /** The `at` hit test answers an AXError instead of an element or `no_element`. */
  hitTestErrors: boolean;
  /** Seconds since the human last touched the machine (`humanidle`). The default is an absent
   *  user, so other tests take the guard's ALLOW path, not its fail-open one; a small value is a
   *  user mid-keystroke, which holds the mouse fallback back. */
  humanIdle: number;
  /** The helper predates `humanidle` — a host app still on an older helper. The guard must
   *  FAIL OPEN here: the mouse fallback behaves as if the guard did not exist. */
  noHumanIdle: boolean;
  /** The app refuses AXFocused — the case that decides where the next keystroke lands, so
   *  `set_text` has to say the keyboard is elsewhere instead of promising Enter will commit. */
  focusRefused: boolean;
  /** The app refuses AXSetValue — System Settings' search field and most rich text views. The
   *  driver must answer with the `type` route rather than let the throw end the whole run. */
  setValueRefused: boolean;
  /** The app ACCEPTS AXSetValue and keeps its old value (QuickTime's timeline slider). Only the
   *  write's read-back separates this from a write that landed. */
  writeDiscarded: boolean;
  /** A posted mouse event that changes NOTHING — the collapsed-frame failure: the point was not
   *  the control's, so the click landed on whatever was there. */
  mouseInert: boolean;
  /** Another app's window covers the point a mouse event would land on. */
  covered: boolean;
  /** A helper that predates the `mouse`/`drag` ops — a host app's until its next update. */
  noMouse: boolean;
  /** A press whose whole effect is a new window (a sheet): the tree is unchanged, the window list not. */
  pressOpensSheet: boolean;
  /** A `button "Send"` in the tree — the irreversible name mouse.ts will not redo unasked. */
  sendButton: boolean;
  /** The element that carries AX's own `focused` flag in the tree — what the observation marks
   *  and what a keyboard precondition is checked against. Distinct from {@link Stub.focusOn},
   *  which is the app's answer for where focus is (the two are independent in the real helper). */
  elementFocused: string;
  /** Two extra buttons take the name "All Clear": unique when a handle was found, ambiguous
   *  afterwards — the case re-resolution must not guess at. */
  sameNames: boolean;
  /** A SwiftUI-style form row (label text, then a nameless checkbox) and a search field that
   *  offers only AXConfirm — System Settings as measured. */
  formRow: boolean;
  /** A panel is up: Save As… (⌘⇧S) stays disabled even with the app frontmost. */
  panelUp: boolean;
  /** The focused element belongs to ANOTHER process (pid 9999) — a remote Open/Save panel. */
  remotePanel: boolean;
  /** The focused element belongs to this pid instead (0 = the app itself) — another app's field. */
  focusOwner: number;
  /** Presses the app honoured, mouse clicks included. */
  readonly presses: number;
}

export function stubTransport(): Stub {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const state = { trusted: true, generation: 0, extraWindow: false as false | "numbered" | "unnumbered", cutValue: false, valueUnavailable: false, sourceList: false, secondary: false, crowded: false, chatty: false, chattyChurn: 0, tinyMenu: false, frontmost: false, menuLag: 0, focusOn: "none", resultRow: false, overflow: 0, textOverflow: 0, collapsed: false, labelledReadout: false, thinAfterNudge: false, sidebar: false, sidebarSelected: false, launchReady: true, offScreen: false, locked: false, offScreenElements: false, framedOffScreen: false, shotOffScreen: false, screenGranted: true, oldHelper: false, refuseAction: null as string | null, presses: 0, treeWindowId: 0, pressInert: false, spaceActs: false, saysOnPress: null as Record<string, number> | null, said: {} as Record<string, number>, talking: false, noWatch: false, pressReveals: false, helpAndId: false, pressErrorsButActs: false, hitTestErrors: false, humanIdle: 3600, noHumanIdle: false, focusRefused: false, setValueRefused: false, writeDiscarded: false, written: new Map<string, string>(), mouseInert: false, covered: false, noMouse: false, cappedBy: "" as "" | "nodes" | "time", pressOpensSheet: false, sendButton: false, formRow: false, panelUp: false, remotePanel: false, focusOwner: 0, sameNames: false, elementFocused: "", scrollArea: false, scrollAt: 0, scrollMax: 3, scrolledAway: false, lazyRows: 0, findBar: false, launchWindowless: false, launchPanelOnly: false, windowsGone: false, soleApp: "" };
  // The helper's two views of what is running, kept apart exactly as the real one has them:
  // `running` is the truth and only `lookup` sees it; `apps` answers from the snapshot taken when
  // the helper started and never learns about a later launch or quit.
  const running: StubApp[] = [...APPS_AT_START, ...LOOKUP_ONLY];
  /** The window's elements as the CURRENT generation keys them — what a walk returns, and what the
   *  hit test has to answer with, or a by-ref mouse fallback reads as "about to click elsewhere"
   *  (mouse.ts `pointHoldsTarget`). */
  const currentElements = (): AxElement[] => {
    const source = state.sourceList ? SOURCE_LIST : [];
    const extra = [...(state.secondary ? SECONDARY : []), ...(state.crowded ? CROWDED : []), ...(state.chatty ? CHATTY.map((e, i) => (i < state.chattyChurn ? { ...e, value: `${e.value} (${state.chattyChurn})` } : e)) : []), ...(state.tinyMenu ? TINY_MENU : []), ...(state.sendButton ? [SEND] : []), ...(state.formRow ? FORM_ROW : []), ...(state.collapsed ? COLLAPSED : []), ...(state.sameNames ? SAME_NAMES : []), ...(state.helpAndId ? HELP_AND_ID : []), ...(state.sidebar ? SIDEBAR : []), ...(state.sidebarSelected ? SIDEBAR_PANE : [])];
    return [...TREE.elements, ...source, ...extra].map((e) => ({
      ...e, key: `${e.key}g${state.generation}`,
      // The display moves with every press the app honoured — what the driver's
      // AXPress-or-mouse decision reads (mouse.ts).
      ...(e.key === "k0" && state.presses ? { value: `${e.value}·${state.presses}` } : {}),
      // Calculator's own shape: the label is the name, the number is the value.
      ...(e.key === "k0" && state.labelledReadout ? { desc: "编辑字段" } : {}),
      ...(state.elementFocused && e.key === state.elementFocused ? { focused: true } : {}),
    }));
  };
  const transport: AxTransport = {
    async request(op, params = {}) {
      calls.push({ op, params });
      // `capabilities` reports the grants and therefore cannot be gated by one: the real helper
      // guards each AX op individually (ax-tree.swift:154), never the process's whole stdio.
      if (op === "capabilities") {
        if (state.oldHelper) throw new AxRequestError("bad_request", `unexpected op ${op}`);
        return { version: "1", accessibility: state.trusted, screenRecording: state.screenGranted, pid: 4242 };
      }
      // Only the AX ops need the grant. Enumeration (`NSWorkspace`) and window rows
      // (`CGWindowListCopyWindowInfo`) need none, and `shot` needs the OTHER one — so an
      // ungranted session can list targets and look healthy.
      if (!state.trusted && !UNGATED_OPS.has(op)) throw new AxRequestError("not_trusted", "Accessibility is not granted: System Settings → Privacy & Security → Accessibility");
      switch (op) {
        // Needs no grant in the real helper either — it reads a CoreGraphics counter, not the app.
        case "humanidle":
          if (state.noHumanIdle) throw new AxRequestError("unsupported", `unknown op "${op}"`);
          return { seconds: state.humanIdle };
        case "apps":
          // The enumeration's own snapshot (see `running` above). `only` narrows it for the one
          // case where there is no choice to make — a machine with a single drivable app.
          return { apps: state.soleApp ? APPS_AT_START.filter((a) => a.bundle === state.soleApp || a.bundle === "com.example.agenthost") : APPS_AT_START };
        case "lookup": {
          const bundles = new Set((params.bundles as string[] | undefined) ?? []);
          const pids = new Set((params.pids as number[] | undefined) ?? []);
          // `active` is what the menu verbs ask before they wait (the frontmost check), so it has
          // to move with {@link Stub.frontmost} rather than stay frozen at what was running.
          const hit = running.filter((a) => bundles.has(a.bundle) || pids.has(a.pid));
          return { apps: hit.map((a) => (a.bundle === "com.apple.calculator" ? { ...a, active: state.frontmost } : a)) };
        }
        case "installed": {
          const want = (params.bundles as string[] | undefined) ?? [];
          return { apps: want.filter((b) => b in INSTALLED_NOT_RUNNING).map((b) => ({ bundle: b, name: INSTALLED_NOT_RUNNING[b]! })) };
        }
        case "windows":
          // The second row is a window the window server does not list (minimised): id -1, and
          // `onScreen: false` says it rather than leaving the -1 to be interpreted.
          if (params.pid !== 49403 || state.windowsGone) return { windows: [], locked: state.locked };
          return {
            locked: state.locked,
            windows: state.offScreen
              ? [{ ...OFFSCREEN_WINDOW, main: true, focused: false }]
              : [{ ...WINDOW, main: true, focused: true }, { ...OFFSCREEN_WINDOW, title: "minimised", main: false, focused: false },
                 ...(state.extraWindow
                   ? [{ ...WINDOW, id: state.extraWindow === "numbered" ? 9911 : -1, title: "选择行", main: false, focused: false }]
                   : [])],
          };
        case "tree": {
          // Every window of an app that is already the target has been closed — the helper answers
          // its own terse `no_window` and the driver has to say what that state IS (driver-read.ts).
          if (state.windowsGone) throw new AxRequestError("no_window", `app ${params.pid} has no window`);
          // The real helper REPLACES its key table on every walk: keys carry a generation
          // suffix here and any other generation answers stale_key, like the helper does.
          state.generation++;
          const withGen = currentElements();
          // Optionally a result row appears ABOVE the keypad, shifting every position.
          const cut = state.cutValue
            ? [el({ key: `kCg${state.generation}`, role: "AXTextArea", value: LONG_VALUE.slice(0, 400), valueCut: true, x: 1600, y: 200, w: 400, h: 300 })]
            : [];
          // The real helper drops a generated identifier before it sends one (ax-tree.swift), so
          // the stub must too — otherwise the suite would pin a shape the product never produces.
          const bar = state.findBar
            ? FIND_BAR.map((e) => el({ ...e, key: `${e.key}g${state.generation}`, ...(e.ident?.startsWith("_NS:") ? { ident: undefined } : {}) }))
            : [];
          const elements = state.resultRow
            ? [el({ key: `kR${state.generation}`, role: "AXStaticText", value: "12×34", x: 1721, y: -62, w: 86, h: 26, actions: [] }), ...withGen, ...cut, ...bar]
            : [...withGen, ...cut, ...bar];
          // The Electron window that took the switch and published nothing under it.
          if (state.thinAfterNudge) {
            return { ...TREE, nudged: true, visited: 4, elements: [0, 1, 2].map((i) =>
              el({ key: `kN${i}g${state.generation}`, role: "AXButton", x: 10 + i * 30, y: 10, w: 20, h: 20 })) };
          }
          if (state.offScreen) {
            return {
              ...TREE, locked: state.locked, visited: 3,
              // A window can be off the window server's list and still report its real frame —
              // a just-launched app that was never brought forward.
              window: state.framedOffScreen ? { ...WINDOW, id: -1, onScreen: false } : OFFSCREEN_WINDOW,
              elements: state.offScreenElements ? withGen.slice(0, 2) : [],
            };
          }
          // Rows the window does not show, listed apart so `find` can name one: one ABOVE the
          // visible rows and one BELOW, by `seq`. The text channel must read them in that order,
          // not as a block on the end.
          // A list that builds its rows as they scroll in (System Settings' sidebar): the rows past
          // the window are bare frames. One nameless row with a nameless cell in it per count.
          const lazy = Array.from({ length: state.lazyRows }, (_, i) => [
            el({ key: `kL${i}rg${state.generation}`, seq: 30 + i * 2, role: "AXRow", x: 1600, y: 3200 + i * 32, w: 232, h: 32, actions: [], off: true }),
            el({ key: `kL${i}cg${state.generation}`, seq: 31 + i * 2, role: "AXCell", x: 1610, y: 3200 + i * 32, w: 212, h: 32, actions: [], off: true }),
          ]).flat();
          const away = state.scrolledAway
            ? [
              el({ key: `kA1g${state.generation}`, seq: 4, role: "AXRow", title: "报告 2025.pdf", x: 1600, y: -900, w: 300, h: 24, actions: ["AXOpen", "AXShowMenu"], off: true }),
              el({ key: `kA2g${state.generation}`, seq: 22, role: "AXCell", title: "预算表.numbers", x: 1600, y: 3040, w: 300, h: 24, actions: ["AXOpen"], off: true }),
            ]
            : [];
          return { ...TREE, elements, overflow: state.overflow, textOverflow: state.textOverflow,
            ...(state.treeWindowId ? { window: { ...TREE.window, id: state.treeWindowId } } : {}),
            ...(away.length + lazy.length ? { offscreenElements: [...away, ...lazy], offscreen: away.length + lazy.length } : {}),
            ...(state.cappedBy ? { capped: true, cappedBy: state.cappedBy, visited: 8000 } : {}), locked: state.locked };
        }
        // The chain above an element, as the helper reports it — modelled on the Finder sidebar
        // measurement: label (no actions) → cell (AXOpen) → row (selection settable).
        case "ancestors": {
          // Keyed like every other act: a key from an older walk is STALE. The helper replaces the
          // pid's table on every tree read and this rung runs AFTER the baseline walk, so a key
          // resolved before the press must be re-resolved.
          if (!String(params.key).endsWith(`g${state.generation}`)) throw new AxRequestError("stale_key", `key ${params.key} is not in the current tree`);
          if (!String(params.key).startsWith("k30")) return { ancestors: [] };
          return { ancestors: [
            { key: `kSCg${state.generation}`, role: "AXCell", actions: ["AXOpen"], selectable: false, name: "" },
            { key: `kSRg${state.generation}`, role: "AXRow", actions: ["AXShowDefaultUI"], selectable: true, name: "" },
          ] };
        }
        case "select": {
          if (!String(params.key).startsWith("kSR")) throw new AxRequestError("ax_error", `select ${params.key}: this element's selection cannot be set`, -25205);
          state.sidebarSelected = true;  // the pane's content appears — the window changed
          return {};
        }
        case "press": case "setvalue": case "focus": case "selectrange": {
          if (!String(params.key).endsWith(`g${state.generation}`) && params.key !== "k99" && !String(params.key).startsWith("m")) throw new AxRequestError("stale_key", `key ${params.key} is not in the current tree`);
          if (op === "focus" && state.focusRefused) {
            throw new AxRequestError("ax_error", `AXFocused on ${params.key}`, -25205);
          }
          // ChatGPT's dialog buttons (Electron web content): AXPress is ignored, but the element takes
          // the focus and answers Space — the keyboard rung's case.
          if (op === "focus" && state.spaceActs) return { focused: true };
          if (op === "setvalue" && state.setValueRefused) {
            throw new AxRequestError("ax_error", `set value on ${params.key}`, -25205);
          }
          // A write the app KEEPS is what `value` answers with afterwards — the read-back the
          // driver does now. `writeDiscarded` is the app that says yes and keeps its old value.
          if (op === "setvalue" && !state.writeDiscarded) state.written.set(String(params.key), String(params.text ?? ""));
          if (op === "press") {
            const base = String(params.key).replace(/g\d+$/, "");
            const known = [...TREE.elements, ...SOURCE_LIST, ...SECONDARY, ...SIDEBAR].find((e) => e.key === base);
            const wanted = (params.action as string | undefined) ?? "AXPress";
            if (state.refuseAction && wanted === state.refuseAction) {
              throw new AxRequestError("ax_error", `${wanted} on ${params.key}`, -25204);
            }
            // Word's start-gallery buttons, measured: AXPress answers -25205 AND opens
            // the document. The error arrives after the effect, so the display moves first.
            if (state.pressErrorsButActs) {
              state.presses++;
              throw new AxRequestError("ax_error", `${wanted} on ${params.key}`, -25205);
            }
            // An app refuses an action the element does not carry — AXError -25206, the real
            // helper's `axFailure` — and one that advertises NOTHING (Finder's sidebar label) refuses
            // every action; otherwise a press on such a node would look like it worked.
            if (known && !known.actions.includes(wanted)) {
              throw new AxRequestError("ax_error", `${wanted} on ${params.key}`, -25206);
            }
            if (!state.pressInert) state.presses++; // any action the app honoured moves the display
            if (state.pressReveals) state.sendButton = true;
            for (const [k, n] of Object.entries(state.saysOnPress ?? {})) state.said[k] = (state.said[k] ?? 0) + n;
            if (state.pressOpensSheet) state.extraWindow = "numbered"; // the sheet is the whole effect
          }
          return {};
        }
        // A tap-posted mouse event: refused when another window covers the point (the real helper's
        // `no_window`), otherwise it lands — and, being a real click, the app comes forward. `hover`
        // rides the same tap and the same refusal; it posts a move and no buttons, so it does not
        // count as a press.
        case "mouse": case "drag": case "hover": {
          if (state.noMouse) throw new AxRequestError("unsupported", `unknown op "${op}"`);
          if (state.covered) throw new AxRequestError("no_window", `the point ${params.x},${params.y} is covered by another app's window (pid 1)`);
          state.frontmost = true;
          if (op !== "hover" && !state.mouseInert) state.presses++;
          return {};
        }
        // The app's own change notifications (ax-watch.swift): a mark, then what was said after it.
        case "watch":
          if (state.noWatch) throw new AxRequestError("unsupported", `unknown op "${op}"`);
          state.said = {};
          return { mark: 0, registered: 22, quiet: !state.talking };
        case "settled": {
          if (state.noWatch) throw new AxRequestError("unsupported", `unknown op "${op}"`);
          const kinds = state.said;
          state.said = {};
          return { changes: Object.values(kinds).reduce((a, n) => a + n, 0), removed: 0, focus: 0, kinds, quiet: true, waitedMs: 0, mark: 0 };
        }
        case "activate":
          state.covered = false; // raised above whatever covered the point
          return {};
        case "backgroundkey":
          return { posted: true };
        case "backgroundtype":
          return { postedCount: String(params.text ?? "").length };
        case "key":
          if (state.spaceActs && params.chord === "Space") state.presses++;
          return {};
        case "type": case "scroll": case "closewindow": case "clipboard":
          return {};
        // The pointer-free rung. Mirrors ax-scroll.swift: one action = one page, `applied` counts
        // what was ATTEMPTED and stops as soon as a page moves nothing, so a `to` request answers
        // with how far the area really went.
        case "scrollpage": {
          // A key is the HELPER's own (this generation's), as for every other op that takes one.
          if (params.key !== undefined && !String(params.key).endsWith(`g${state.generation}`)) throw new AxRequestError("stale_key", `key ${params.key} is not in the current tree`);
          if (!state.scrollArea) throw new AxRequestError("no_scroll_area", "no accessibility scrolling area here — this app does not expose one");
          const dir = String(params.direction) === "up" ? -1 : 1;
          const want = Math.max(1, Number(params.pages) || 1);
          const from = state.scrollAt;
          let applied = 0, last = state.scrollAt;
          for (let i = 0; i < want; i++) {
            state.scrollAt = Math.max(0, Math.min(state.scrollMax, state.scrollAt + dir));
            if (state.scrollAt === last) break;   // applied counts pages that MOVED, not attempts
            applied += 1;
            last = state.scrollAt;
          }
          return { applied, moved: state.scrollAt !== from, delta: Math.abs(state.scrollAt - from), unit: "bar", area: "AXScrollArea" };
        }
        case "menu": {
          // Frontmost, AppKit validates the key-window commands as enabled — but only once it
          // has caught up, which `menuLag` counts down.
          if (state.menuLag > 0) { state.menuLag--; return { items: MENU }; }
          return { items: state.frontmost ? MENU.map((m) => ({ ...m, enabled: !(state.panelUp && m.key === "m4") })) : MENU };
        }
        case "selectall":
          return { length: 5 };
        // The app's OWN answer for where focus is — the only thing that decides where a menu
        // command lands, and deliberately independent of the per-element `focused` flags.
        case "focused": {
          if (state.focusOn === "none") throw new AxRequestError("no_element", `app ${params.pid} reports no focused element`);
          if (state.focusOn === "elsewhere") {
            return { element: { role: "AXTextArea", title: "", desc: "", window: "note.txt", windowId: 62107 } };
          }
          return {
            element: {
              key: `${state.focusOn}g${state.generation}`, role: "AXTextArea", title: "", desc: "",
              window: WINDOW.title, windowId: WINDOW.id, ...(state.focusOwner ? { pid: state.focusOwner } : state.remotePanel ? { pid: 9999 } : {}),
            },
          };
        }
        case "clipboardstash": return { stashed: 1 };
        case "clipboardrestore": return { restored: 1 };
        // The real helper sends a 400-char PREVIEW and flags what it cut; `value` hands back
        // the whole thing, one element at a time (`what:'text'` is what pays for it).
        case "value": {
          if (!String(params.key).endsWith(`g${state.generation}`)) throw new AxRequestError("stale_key", `key ${params.key} is not in the current tree`);
          const written = state.written.get(String(params.key));
          if (written !== undefined) return { value: written };
          if (state.valueUnavailable) return { value: "" };
          // Only the flagged text area holds the long value; every other element answers with
          // its own, which for a button is nothing at all — the real helper's shape.
          if (String(params.key).startsWith("kC")) return { value: LONG_VALUE };
          const base = String(params.key).replace(/g\d+$/, "");
          const known = [...TREE.elements, ...SOURCE_LIST, ...SECONDARY].find((e) => e.key === base);
          return { value: known?.value ?? "" };
        }
        // A real hit test: the element whose frame CONTAINS the point, in the walk's front-to-back
        // order — the by-ref mouse fallback compares it with its target (mouse.ts
        // `pointHoldsTarget`). `k99` ("8") answers a point no element covers; a suite names it.
        case "at": {
          // Excel's sheet answers an AXError to every point in the grid — a self-drawn area with
          // no node, which is what a point click is for.
          if (state.hitTestErrors) throw new AxRequestError("ax_error", `hit test at ${params.x},${params.y}`, -25208);
          const x = Number(params.x), y = Number(params.y);
          const under = currentElements().find((e) => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h);
          if (under) return { element: under };
          return { element: el({ key: "k99", role: "AXButton", desc: "8", x: 1666, y: 66 }) };
        }
        case "shot":
          // Pixels are their own grant, checked before anything about the window (ax-shot.swift:38).
          if (!state.screenGranted) throw new AxRequestError("not_granted_screen", "Screen Recording is not granted: enable it in System Settings → Privacy & Security → Screen Recording for the responsible app.");
          // The helper cannot photograph a window the window server does not list, and says which
          // state stopped it — the lock first, since it stops the capture layer as a whole.
          if (state.offScreen && !state.shotOffScreen) {
            throw new AxRequestError("no_window", state.locked
              ? "macOS refused to photograph this window while the screen is LOCKED; windows become readable again when the user unlocks it"
              : `the window of app ${params.pid} is on another Space or minimised, and macOS cannot photograph it there`);
          }
          // One pixel per point, which is what the capture is capped at (ax-shot.swift): a picture
          // at 2× would make an element's rect and a screenshot's pixel two different spaces.
          return { png: PNG_1PX, id: WINDOW.id, x: WINDOW.x, y: WINDOW.y, w: WINDOW.w, h: WINDOW.h, scale: 1 };
        case "launch": {
          const bundle = String(params.bundle);
          const app = running.find((a) => a.bundle === bundle) ?? LAUNCHABLE[bundle];
          if (!app) throw new AxRequestError("no_app", `no installed application with bundle id "${bundle}"`);
          // Asked BEFORE the push, as the helper asks before the open: afterwards the two cases
          // are indistinguishable.
          const started = !running.includes(app);
          if (started) running.push(app);
          return { app, ready: state.launchReady, started, windows: state.launchWindowless ? 0 : 1, panel: state.launchPanelOnly };
        }
        default:
          throw new AxRequestError("bad_request", `unexpected op ${op}`);
      }
    },
    async close() {},
  };
  return {
    transport, calls,
    get trusted() { return state.trusted; }, set trusted(v: boolean) { state.trusted = v; },
    get resultRow() { return state.resultRow; }, set resultRow(v: boolean) { state.resultRow = v; },
    get overflow() { return state.overflow; }, set overflow(v: number) { state.overflow = v; },
    get textOverflow() { return state.textOverflow; }, set textOverflow(v: number) { state.textOverflow = v; },
    /** Which read budget the walk ran out of: "" = it finished. */
    get cappedBy() { return state.cappedBy; }, set cappedBy(v: "" | "nodes" | "time") { state.cappedBy = v; },
    get collapsed() { return state.collapsed; }, set collapsed(v: boolean) { state.collapsed = v; },
    get launchReady() { return state.launchReady; }, set launchReady(v: boolean) { state.launchReady = v; },
  /** Does this app expose an AXScrollArea? Electron does not — false makes `scroll` fall to the wheel. */
  get scrollArea() { return state.scrollArea; }, set scrollArea(v: boolean) { state.scrollArea = v; },
  /** Which page the area sits on, and how many it has. */
  get scrollAt() { return state.scrollAt; }, set scrollAt(v: number) { state.scrollAt = v; },
  get scrollMax() { return state.scrollMax; }, set scrollMax(v: number) { state.scrollMax = v; },
  /** Two rows the window does not show — what `find` must still be able to name. */
  get scrolledAway() { return state.scrolledAway; }, set scrolledAway(v: boolean) { state.scrolledAway = v; },
  get lazyRows() { return state.lazyRows; }, set lazyRows(v: number) { state.lazyRows = v; },
  /** Leave exactly one drivable app in the ENUMERATION — the case where there is no choice. */
  only(bundle: string) { state.soleApp = bundle; },
  get findBar() { return state.findBar; }, set findBar(v: boolean) { state.findBar = v; },
  get launchWindowless() { return state.launchWindowless; }, set launchWindowless(v: boolean) { state.launchWindowless = v; },
  get windowsGone() { return state.windowsGone; }, set windowsGone(v: boolean) { state.windowsGone = v; },
  /** The app comes up showing ONLY an Open/Save panel — a cold document app's usual landing. */
  get launchPanelOnly() { return state.launchPanelOnly; }, set launchPanelOnly(v: boolean) { state.launchPanelOnly = v; },
    get offScreen() { return state.offScreen; }, set offScreen(v: boolean) { state.offScreen = v; },
    get locked() { return state.locked; }, set locked(v: boolean) { state.locked = v; },
    get offScreenElements() { return state.offScreenElements; }, set offScreenElements(v: boolean) { state.offScreenElements = v; },
    get framedOffScreen() { return state.framedOffScreen; }, set framedOffScreen(v: boolean) { state.framedOffScreen = v; },
    get sourceList() { return state.sourceList; }, set sourceList(v: boolean) { state.sourceList = v; },
    get secondary() { return state.secondary; }, set secondary(v: boolean) { state.secondary = v; },
    get crowded() { return state.crowded; }, set crowded(v: boolean) { state.crowded = v; },
    get chatty() { return state.chatty; }, set chatty(v: boolean) { state.chatty = v; },
    get chattyChurn() { return state.chattyChurn; }, set chattyChurn(v: number) { state.chattyChurn = v; },
    get tinyMenu() { return state.tinyMenu; }, set tinyMenu(v: boolean) { state.tinyMenu = v; },
    get frontmost() { return state.frontmost; }, set frontmost(v: boolean) { state.frontmost = v; },
    get menuLag() { return state.menuLag; }, set menuLag(v: number) { state.menuLag = v; },
    get focusOn() { return state.focusOn; }, set focusOn(v: string) { state.focusOn = v; },
  get extraWindow() { return state.extraWindow; }, set extraWindow(v: false | "numbered" | "unnumbered") { state.extraWindow = v; },
  get cutValue() { return state.cutValue; }, set cutValue(v: boolean) { state.cutValue = v; },
  get valueUnavailable() { return state.valueUnavailable; }, set valueUnavailable(v: boolean) { state.valueUnavailable = v; },
    get shotOffScreen() { return state.shotOffScreen; }, set shotOffScreen(v: boolean) { state.shotOffScreen = v; },
    get screenGranted() { return state.screenGranted; }, set screenGranted(v: boolean) { state.screenGranted = v; },
    get oldHelper() { return state.oldHelper; }, set oldHelper(v: boolean) { state.oldHelper = v; },
    get refuseAction() { return state.refuseAction; }, set refuseAction(v: string | null) { state.refuseAction = v; },
    get helpAndId() { return state.helpAndId; }, set helpAndId(v: boolean) { state.helpAndId = v; },
    get treeWindowId() { return state.treeWindowId; }, set treeWindowId(v: number) { state.treeWindowId = v; },
    get pressInert() { return state.pressInert; }, set pressInert(v: boolean) { state.pressInert = v; },
    get spaceActs() { return state.spaceActs; }, set spaceActs(v: boolean) { state.spaceActs = v; },
    get saysOnPress() { return state.saysOnPress; }, set saysOnPress(v: Record<string, number> | null) { state.saysOnPress = v; },
    get talking() { return state.talking; }, set talking(v: boolean) { state.talking = v; },
    get noWatch() { return state.noWatch; }, set noWatch(v: boolean) { state.noWatch = v; },
    get pressReveals() { return state.pressReveals; }, set pressReveals(v: boolean) { state.pressReveals = v; },
    get labelledReadout() { return state.labelledReadout; }, set labelledReadout(v: boolean) { state.labelledReadout = v; },
    get thinAfterNudge() { return state.thinAfterNudge; }, set thinAfterNudge(v: boolean) { state.thinAfterNudge = v; },
    get sidebar() { return state.sidebar; }, set sidebar(v: boolean) { state.sidebar = v; },
    get pressErrorsButActs() { return state.pressErrorsButActs; }, set pressErrorsButActs(v: boolean) { state.pressErrorsButActs = v; },
    get hitTestErrors() { return state.hitTestErrors; }, set hitTestErrors(v: boolean) { state.hitTestErrors = v; },
    get humanIdle() { return state.humanIdle; }, set humanIdle(v: number) { state.humanIdle = v; },
    get noHumanIdle() { return state.noHumanIdle; }, set noHumanIdle(v: boolean) { state.noHumanIdle = v; },
    get focusRefused() { return state.focusRefused; }, set focusRefused(v: boolean) { state.focusRefused = v; },
    get setValueRefused() { return state.setValueRefused; }, set setValueRefused(v: boolean) { state.setValueRefused = v; },
    get writeDiscarded() { return state.writeDiscarded; }, set writeDiscarded(v: boolean) { state.writeDiscarded = v; },
    get mouseInert() { return state.mouseInert; }, set mouseInert(v: boolean) { state.mouseInert = v; },
    get covered() { return state.covered; }, set covered(v: boolean) { state.covered = v; },
    get noMouse() { return state.noMouse; }, set noMouse(v: boolean) { state.noMouse = v; },
    get pressOpensSheet() { return state.pressOpensSheet; }, set pressOpensSheet(v: boolean) { state.pressOpensSheet = v; },
    get sendButton() { return state.sendButton; }, set sendButton(v: boolean) { state.sendButton = v; },
    get formRow() { return state.formRow; }, set formRow(v: boolean) { state.formRow = v; },
    get sameNames() { return state.sameNames; }, set sameNames(v: boolean) { state.sameNames = v; },
    get elementFocused() { return state.elementFocused; }, set elementFocused(v: string) { state.elementFocused = v; },
    get panelUp() { return state.panelUp; }, set panelUp(v: boolean) { state.panelUp = v; },
    get remotePanel() { return state.remotePanel; }, set remotePanel(v: boolean) { state.remotePanel = v; },
    get focusOwner() { return state.focusOwner; }, set focusOwner(v: number) { state.focusOwner = v; },
    get presses() { return state.presses; },
  };
}

/** What a real caller passes: the app it means. The suites below drive ONE stubbed window,
 *  so they name it — an unnamed session is refused now, and that refusal has its own test. */
// Existing input-routing fixtures exercise the explicitly permitted desktop path.
export const ONE_APP = { bundle: "com.apple.calculator", interaction: "desktop" as const };

export const findCall = (calls: Array<{ op: string; params: Record<string, unknown> }>, op: string) => calls.find((c) => c.op === op);
