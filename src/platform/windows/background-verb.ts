/**
 * Background actions on Windows: the bounded UIA policy as the driver applies it — which verbs
 * qualify, the per-window stop after interference, and how the helper's answers become results.
 * Kept apart from `driver.ts`; the driver hands it what it needs as a {@link BackgroundHost}.
 */

import type { ActResult } from "../types.ts";
import { UiaRequestError } from "./uia-client.ts";

export interface BackgroundHost {
  authorized(): Promise<{ pid: number; hwnd: number }>;
  target(ref: unknown): { key: string };
  call<T>(op: string, params?: Record<string, unknown>): Promise<T>;
  /** Windows (`pid:hwnd`) whose background actions were stopped for this runtime. */
  interrupted: Set<string>;
}

/** A background action never takes the foreground or sends input, so it skips the driver's pause
 *  gate and takeover check; the helper's own observer reports interference instead. */
export async function performBackground(host: BackgroundHost, kind: string, a: Record<string, any>): Promise<ActResult> {
  if (!["set_text", "click", "scroll", "uia_action"].includes(kind) || typeof a.ref !== "string" || a.ref === "window") {
    return { ok: false, note: "background Windows actions require a control ref: setText, supported click, uiaAction, or a ScrollPattern container. "
      + "Coordinates, type, keys, hover and activation need desktop interaction with permission; nothing was sent" };
  }
  if (kind === "click" && ((a.button ?? "left") !== "left" || (a.count ?? 1) !== 1)) {
    return { ok: false, note: "background click only supports a single left action by ref; nothing was sent" };
  }
  if (kind === "scroll" && a.count !== undefined && (!Number.isInteger(a.count) || a.count < 1 || a.count > 20)) {
    return { ok: false, note: "background scroll count must be an integer from 1 to 20; nothing was sent" };
  }
  const row = await host.authorized();
  const windowKey = `${row.pid}:${row.hwnd}`;
  if (host.interrupted.has(windowKey)) {
    return { ok: false, note: "background actions on this window were stopped after interference or an uncertain outcome. "
      + "Observe the result; do not replay the action. Desktop interaction requires permission for its foreground/input effects" };
  }
  const target = host.target(a.ref);
  try {
    const result = await host.call<{ verified?: boolean; note: string }>("background", {
      hwnd: row.hwnd, key: target.key, kind,
      ...(kind === "set_text" ? { text: String(a.text ?? "") } : {}),
      ...(kind === "uia_action" ? { action: String(a.action ?? "") } : {}),
      ...(kind === "scroll" ? { direction: a.direction ?? "down", count: a.count ?? 1, ...(a.to ? { to: a.to } : {}) } : {}),
    });
    if (result.verified === false && kind !== "set_text") {
      host.interrupted.add(windowKey);
      return { ok: false, mayHaveActed: true, ...result };
    }
    return { ok: true, ...result };
  } catch (e) {
    if (!(e instanceof UiaRequestError)) {
      host.interrupted.add(windowKey);
      return { ok: false, mayHaveActed: true, note: `background UIA outcome is unknown: ${(e as Error).message}. Observe without replaying; background actions on this window are stopped` };
    }
    if (["background_interrupted", "background_uncertain", "panic"].includes(e.code)) {
      host.interrupted.add(windowKey);
      return { ok: false, mayHaveActed: true, note: e.message };
    }
    return { ok: false, note: e.code === "unknown_op"
      ? "this Windows native helper does not support background UIA actions; update @mirasim/computer-use, or the app that bundles it. Nothing was sent"
      : e.message };
  }
}
