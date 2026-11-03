/**
 * Starting apps: the Start menu's listing, binding a name that has no window yet, and finding
 * the window a launch opened. Fourth slice of {@link WindowsDriver}'s chain, after
 * {@link WindowsDriverYield}.
 */

import type { ActResult, TargetInfo } from "../types.ts";
import type { WindowRow } from "./driver-targets.ts";
import { WindowsDriverYield } from "./driver-yield.ts";
import { filterApps, LAUNCH_NEEDS_DESKTOP, LAUNCH_WAIT_MS, launchedBy, pickAppeared, startAppTarget, type StartApp, type Started } from "./launch.ts";
import { UiaRequestError } from "./uia-client.ts";

export abstract class WindowsDriverApps extends WindowsDriverYield {
  private apps: { at: number; list: StartApp[] } | null = null;

  /** The Start menu's entries, read at most once a minute: a listing costs ~100 ms and changes
   *  only when something is installed. */
  private async startMenu(): Promise<StartApp[]> {
    if (this.apps && Date.now() - this.apps.at < 60_000) return this.apps.list;
    const list = (await this.call<{ apps: StartApp[] }>("apps")).apps;
    this.apps = { at: Date.now(), list };
    return list;
  }

  protected async listApps(query: string): Promise<ActResult> {
    let list: StartApp[];
    try { list = await this.startMenu(); }
    catch (e) {
      if (e instanceof UiaRequestError && e.code === "unknown_op") return { ok: false, note: "this Windows native helper predates listApps; update @mirasim/computer-use, or the app that bundles it" };
      throw e;
    }
    return filterApps(list, query);
  }

  /** An exact Start-menu name with no window open: binding it starts the app (launch.ts). */
  override async unlistedTarget(query: string): Promise<TargetInfo | null> {
    return query.trim() ? startAppTarget(await this.startMenu().catch(() => [] as StartApp[]), query) : null;
  }

  /**
   * Start `app` and bind the window it shows. Which window that is cannot come from the process
   * started: a Store app's window belongs to another process, and `calc.exe` exits after handing
   * over. So it is the window that APPEARED — the launched pid's, one titled with the app's name,
   * or the only new one — and failing that, a single-instance app that answered by coming forward.
   */
  protected async launchAndBind(app: string, handle?: string): Promise<ActResult> {
    if (!app.trim()) return { ok: false, note: "launch_app needs an app: a Start-menu name or id from listApps(), or a program name (notepad, mspaint)" };
    if (this.interactionMode !== "desktop") return { ok: false, note: LAUNCH_NEEDS_DESKTOP };
    const refused = await this.yieldToHuman("launch_app", app);
    if (refused) return refused;
    const before = new Set((await this.windows()).map((r) => r.hwnd));
    let started: Started;
    try { started = await this.call("launch", { app }); }
    catch (e) {
      if (!(e instanceof UiaRequestError)) throw e;
      return { ok: false, note: e.code === "unknown_op" ? "this Windows native helper predates launch_app; update @mirasim/computer-use, or the app that bundles it. Nothing was started" : e.message };
    }
    const named = launchedBy(app, started);
    let pick: WindowRow | undefined;
    let fresh = true;
    for (const deadline = Date.now() + LAUNCH_WAIT_MS; !pick && Date.now() < deadline;) {
      const appeared = (await this.windows()).filter((r) => !before.has(r.hwnd));
      pick = pickAppeared(appeared, named);
      if (!pick) await new Promise((r) => setTimeout(r, 250));
    }
    if (!pick) {
      const fg = await this.call<{ hwnd: number }>("foreground");
      pick = (await this.windows()).find((r) => r.hwnd === fg.hwnd && named(r));
      fresh = false;
    }
    if (!pick) {
      return { ok: false, mayHaveActed: true, note: `started ${started.name}, but no window of it appeared within ${LAUNCH_WAIT_MS / 1000} s — it may still be loading, `
        + "be waiting behind a prompt, or run without a window. Do not start it again: computer.surfaces() lists the windows" };
    }
    const bound = await this.focusTarget(String(pick.hwnd));
    if (!bound.ok) return { ...bound, mayHaveActed: true };
    this.leftFront = { pid: pick.pid, at: Date.now() };
    this.launched = { id: handle ?? `app:${app}`, hwnd: pick.hwnd };
    return { ok: true, note: `${fresh ? "started" : "brought forward the running"} ${started.name} — its window "${pick.title}" (${pick.process}) is now the target, in front of the user; observe() to see it` };
  }
}
