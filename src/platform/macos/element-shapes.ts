/**
 * The shapes the macOS accessibility helper answers with — `tree`, `at`, `menu`. Types only; the
 * mapping lives in `elements.ts`.
 *
 * Optional fields marked "newer" are absent from an older prebuilt helper, and absence always
 * reads as the silent default (not cut, not selected, nothing to go on), never a wrong claim.
 */

/** One element as the helper reports it (`tree` / `at`). */
export interface AxElement {
  key: string;
  role: string;
  subrole: string;
  title: string;
  desc: string;
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
  focused: boolean;
  actions: string[];
  depth: number;
  /** This node's frame lies outside the window, or it is clipped to nothing. Listed anyway, in
   *  the tree's separate {@link AxTree.offscreenElements} array. */
  off?: boolean;
  /** `AXIdentifier`, sent ONLY for a node with no title and no description: developer text, the
   *  one thing telling two nameless controls apart. Newer. */
  ident?: string;
  help?: string;
  /** Where this node sat in the app's own document order (the walk's visit counter), which
   *  {@link textOf} merges the two arrays back by. Newer; without it off-screen rows follow. */
  seq?: number;
  /** The helper sent a PREFIX of this value (its walk caps them); the whole one is one `value` op
   *  away. Newer. */
  valueCut?: boolean;
  /** `AXSelected`, sent only when true: the chosen one of a set of buttons, rows or cells. Newer. */
  selected?: boolean;
  /** Set by {@link foldTextRuns}: how many consecutive text fragments this one element stands
   *  for. Never present on a control. */
  runOf?: number;
}

/** One window as the helper reports it. `onScreen` is false for a window the window server does
 *  not list — minimised, on another Space, its display asleep, or (the common one) the screen
 *  locked: AX still answers for it, with a zero frame and no readable contents. */
export interface AxWindow { id: number; title: string; onScreen: boolean; x: number; y: number; w: number; h: number }

export interface AxTree {
  window: AxWindow;
  elements: AxElement[];
  /** Nodes read; `capped` when the read budget ran out, and `cappedBy` which one: `"nodes"` (a
   *  window too big) or `"time"` (an app too slow). `cappedBy` is newer. */
  visited: number;
  capped: boolean;
  cappedBy?: "nodes" | "time" | "";
  /** Elements the walk found outside the window, and past the control budget. `offscreen` counts
   *  every one; `offscreenElements` (newer) carries them up to the walk's own off-screen budget, so
   *  a count larger than the array means some were cut. */
  offscreen: number;
  offscreenElements?: AxElement[];
  overflow: number;
  /** Static text past the TEXT budget, counted apart because `text()` is its way out, not a
   *  narrower target. Newer. */
  textOverflow?: number;
  /** Information-free structural nodes the walk dropped before the budget (`Node.bare`). */
  folded?: number;
  nudged: boolean;
  /** Whether the SCREEN is locked — the whole-session reason a window is off-screen, and the
   *  normal state of an unattended run. */
  locked: boolean;
}

/** One menu command as the helper reports it (`menu`); `mods` is the AX modifier mask (0 = ⌘ alone). */
export interface AxMenuItem { key: string; path: string; title: string; enabled: boolean; cmd: string; mods: number }
