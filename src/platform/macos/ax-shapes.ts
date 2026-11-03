/**
 * The shapes read back from the AX helper, and the few pure predicates that hold only for them.
 * No driver state lives here, only "what the helper answers with" and "how to read it".
 */
import { SurfaceUnreadableError } from '../types.ts';
import { AxRequestError } from './ax-client.ts';
import type { AxWindow } from './elements.ts';

export const SHOT_MAX_LONG_SIDE = 1568;
/** Read budget per walk, as a NODE COUNT: the backstop for a pathological tree (Chrome measured
 *  873,086 nodes unbounded, 169 s); the deadline below bounds a healthy walk. 8,000 because a
 *  full-screen Electron window measured 5,924 nodes, and the depth-first walk drops the END of the
 *  document first (the composer and its Send button). At ~0.06 ms a node, 8,000 costs ~0.5 s. */
export const TREE_MAX_VISITED = 8000;
/** …and the budget that bounds TIME: a node costs ~0.06 ms on an app that answers and up to
 *  `AX_TIMEOUT` (1.5 s) on one that does not. 1.5 s is out of reach of any healthy window measured
 *  (the 5,924 above walk in 0.37 s) and keeps ONE unresponsive app from spending a whole turn. */
export const TREE_WALK_DEADLINE_MS = 1500;
/** Listed-CONTROL budget — what the MODEL has to read. Desktop apps list 20–300 controls; past
 *  this the walk counts instead of keeps and the observation says how many it left out. */
export const TREE_MAX_ELEMENTS = 300;
/** Listed static-TEXT budget, counted apart from the controls (`ax-tree.swift` → `Walk`) so text
 *  cannot crowd out the actionable rows: a web-content window measured 2,082 text runs against
 *  232 controls. Text past this is counted, and the count names `text()`, the channel that answers
 *  it. 2,000 because `foldTextRuns` (`elements.ts`) folds consecutive fragments into one line
 *  (~21 nodes a line); it bounds what is LISTED, not time: the walk visits every node either way. */
export const TREE_MAX_TEXT = 2000;
/** How deep the walk goes. The helper's own default is 24, and Chromium content sits below it
 *  (a chat transcript measured at depth 26–28); the extra depth cost nothing measurable. */
export const TREE_MAX_DEPTH = 64;
export const TEXT_PREVIEW = 600;

/** `background` = the process has NO UI (`.prohibited` / LSBackgroundOnly); only a NAMED lookup
 *  can return one. Absent from an older prebuilt helper, which reads as "not background". */
export interface AxApp {
  bundle: string; name: string; pid: number; active: boolean; hidden: boolean; background?: boolean;
  /** The app draws its interface with Chromium (Electron or CEF), read from the BUNDLE because
   *  the accessibility switches lie about it (@see isWebShell). Absent from an older helper. */
  webShell?: boolean;
}

/** What the `launch` op answers. `started` and `windows` are absent from an older prebuilt helper:
 *  a missing `started` reads as "we started it" (`!== false`), a missing `windows` says nothing. */
export interface AxLaunch { app: AxApp; ready: boolean; started?: boolean; windows?: number; panel?: boolean }
export interface AxWindowRow extends AxWindow { main: boolean; focused: boolean }
/** `shot` → the capture plus the frame it photographed; `id` is the CGWindowID it chose. */
export interface AxShot { png: string; id: number; x: number; y: number; w: number; h: number; scale: number }

export interface AxScopedShot extends AxShot {
  region: { x: number; y: number; w: number; h: number };
  pixelWidth: number;
  pixelHeight: number;
  scaleY: number;
  trimmed: boolean;
}

/** A CGWindowID worth pinning; the helper's `-1` (no window-server row) is not one. */
export const pinnable = (id: number | undefined): number | null =>
  (typeof id === 'number' && id >= 0 ? id : null);
export const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
/** A capture refused because the window is not photographable where it is (locked screen,
 *  another Space, minimised) is the same unreadable surface the tree channel reports, and must
 *  read the same way; the helper's message carries the reason. */
export const unreadable = (e: unknown): unknown =>
  e instanceof AxRequestError && e.code === 'no_window' ? new SurfaceUnreadableError(e.message) : e;

/** The system's Open/Save panel host: a separate process that holds the keyboard focus while a
 *  panel is up, acting on the app that raised it (driver.ts `keyPid`). */
export const PANEL_SERVICE_BUNDLE = "com.apple.appkit.xpc.openAndSavePanelService";
