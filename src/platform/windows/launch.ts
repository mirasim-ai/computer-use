/**
 * Starting an app, the driver-side half: which Start-menu entry a name means, and which window a
 * launch produced. Pure functions over the helper's answers (`apps`, `launch`, `windows`); the
 * driver owns the waiting, the binding and the consent.
 */

import type { ActResult, TargetInfo } from "../types.ts";

/** How long a launch may take to show its window (a cold Store app is the slow case). */
export const LAUNCH_WAIT_MS = 10_000;

export const LAUNCH_NEEDS_DESKTOP = "starting an app opens its window in front of the user and takes their keyboard focus, so it needs "
  + "interaction:'desktop': explain that and obtain permission first. Nothing was started";

/** One Start-menu entry (the helper's `apps`). */
export interface StartApp { name: string; id: string }

/** What the helper's `launch` answers. `pid` is 0 when the shell started it without a handle. */
export interface Started { name: string; via: string; pid: number }

interface Row { hwnd: number; pid: number; process: string; title: string }

export function filterApps(list: StartApp[], query: string): ActResult {
  const q = query.trim().toLowerCase();
  const hits = q ? list.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : list;
  return { ok: true, value: hits, note: `${hits.length} of ${list.length} Start-menu apps${q ? ` match "${query}"` : ""}` };
}

/**
 * A Start-menu app named exactly (its name or id) and with no window open is still a target:
 * binding it starts it — macOS's "not running; binding it starts it" row, reached the same way
 * (`computer.surface('Notepad')`, or its localized name). Only an exact, unambiguous name: a loose match would start
 * something the caller never named.
 */
export function startAppTarget(list: StartApp[], query: string): TargetInfo | null {
  const q = query.trim().toLowerCase();
  const hits = q ? list.filter((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q) : [];
  if (hits.length !== 1) return null;
  return { id: `app:${hits[0]!.id}`, kind: "app", title: `${hits[0]!.name} — no window open; binding it starts the app (its window opens in front of the user)`, active: false };
}

/**
 * Does this window belong to what was started? Not by the started process alone: a Store app's
 * window belongs to another process, and `calc.exe` exits after handing over. So also by program
 * name, or a title carrying the app's name.
 */
export function launchedBy(app: string, started: Started): (r: Row) => boolean {
  const stem = app.trim().toLowerCase().split(/[\\/]/).pop()!.replace(/\.exe$/, "");
  const name = started.name.toLowerCase();
  return (r) => (started.pid !== 0 && r.pid === started.pid) || r.process.toLowerCase() === stem || r.title.toLowerCase().includes(name);
}

/** Among the windows that APPEARED since the launch: the launched app's, or the only new one. */
export function pickAppeared<R extends Row>(appeared: R[], named: (r: R) => boolean): R | undefined {
  return appeared.find(named) ?? (appeared.length === 1 ? appeared[0] : undefined);
}
