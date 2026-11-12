/**
 * Starting apps: the Start menu's listing, binding a name that has no window yet, and finding
 * the window a launch opened. Fourth slice of {@link WindowsDriver}'s chain, after
 * {@link WindowsDriverYield}.
 */

import type { ActResult, TargetInfo } from "../types.ts";
import { AppRefused } from "./app-gate.ts";
import type { WindowRow } from "./driver-targets.ts";
import { WindowsDriverYield } from "./driver-yield.ts";
import { filterApps, LAUNCH_NEEDS_DESKTOP, LAUNCH_WAIT_MS, launchConsent, launchedBy, pickAppeared, startAppTarget, type AppInfo, type StartApp, type Started } from "./launch.ts";
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
   * Ask the user about the app a launch would start, BEFORE starting it: a started app is on
   * their screen, in front, whatever they answer afterwards (macos/driver-apps.ts `ensure` asks
   * at the same point). It is asked about by the program it runs, which is the name its window is
   * then cleared under — so an app allowed ahead of time starts without a question, and one the
   * user refuses is never started. Resolves with what {@link launchAndBind} needs of it; throws
   * the refusal.
   */
  private async clearLaunch(app: string): Promise<{ note: string } | { askedAs: string; shown: string; exe: string | null; asked: boolean }> {
    let info: AppInfo | null = null;
    try { info = await this.call<AppInfo>("appinfo", { app }); }
    catch (e) {
      if (!(e instanceof UiaRequestError)) throw e;
      // A helper that predates `appinfo` still starts apps: the question is then about the name.
      if (e.code !== "unknown_op") return { note: e.message };
    }
    const { app: askedAs, shown } = launchConsent(app, info, await this.startMenu().catch(() => [] as StartApp[]));
    const asked = !this.gate.cleared(askedAs);
    try {
      this.waitedOnUserMs += await this.gate.authorize(askedAs, shown, this.consentPurpose, true);
      return { askedAs, shown, exe: info?.exe ?? null, asked };
    } catch (e) {
      if (!(e instanceof AppRefused)) throw e;
      this.permissionRefusal = `mirasim-cu: ${e.message}. Nothing was started`;
      throw new Error(this.permissionRefusal);
    }
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
    const consent = await this.clearLaunch(app);
    if ("note" in consent) return { ok: false, note: consent.note };
    const refused = await this.yieldToHuman("launch_app", consent.shown, consent.asked);
    if (refused) return refused;
    const before = new Set((await this.windows()).map((r) => r.hwnd));
    let started: Started;
    try { started = await this.call("launch", { app }); }
    catch (e) {
      if (!(e instanceof UiaRequestError)) throw e;
      return { ok: false, note: e.code === "unknown_op" ? "this Windows native helper predates launch_app; update @mirasim/computer-use, or the app that bundles it. Nothing was started" : e.message };
    }
    const named = launchedBy(app, started, consent.exe);
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
    // The user was asked about this launch; the window it opened is what they answered about,
    // also when it belongs to another program than the one the question could name.
    if (named(pick)) this.gate.extend(consent.askedAs, pick.process || "?");
    const bound = await this.focusTarget(String(pick.hwnd));
    if (!bound.ok) return { ...bound, mayHaveActed: true };
    this.leftFront = { pid: pick.pid, at: Date.now() };
    this.launched = { id: handle ?? `app:${app}`, hwnd: pick.hwnd };
    return { ok: true, note: `${fresh ? "started" : "brought forward the running"} ${started.name} — its window "${pick.title}" (${pick.process}) is now the target, in front of the user; observe() to see it` };
  }
}
