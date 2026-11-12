/**
 * Starting apps: the Start menu's listing, binding a name that has no window yet, and finding
 * the window a launch opened. Fourth slice of {@link WindowsDriver}'s chain, after
 * {@link WindowsDriverYield}.
 */

import type { ActResult, TargetInfo } from "../types.ts";
import { AppRefused, isSharedFrameHost } from "./app-gate.ts";
import { NOT_IDENTIFIED_YET, type WindowRow } from "./driver-targets.ts";
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

  /**
   * An exact Start-menu name that matched nothing listed: binding it starts the app (launch.ts)
   * — unless the app has a window open after all. One not cleared yet is listed by its program
   * only (`CalculatorApp — not cleared…`), so its name ("计算器") matches no listed title; binding
   * the name then binds that window ({@link launchAndBind}), and the row says so.
   */
  override async unlistedTarget(query: string): Promise<TargetInfo | null> {
    const list = query.trim() ? await this.startMenu().catch(() => [] as StartApp[]) : [];
    const target = startAppTarget(list, query);
    if (!target) return null;
    const open = await this.openWindowOf(target.id, await this.appInfo(target.id.slice(4)).catch(() => null)).catch(() => null);
    if (!open) return target;
    const name = list.find((a) => `app:${a.id}` === target.id)?.name ?? query.trim();
    return { ...target, title: `${name} — open (${open.row.process}), not cleared in this session yet; binding it checks the user's allow-list or asks them` };
  }

  /** What the helper says `app` would start, nothing started; null from a helper that predates
   *  the question. Throws the helper's refusal (an ambiguous name). */
  private async appInfo(app: string): Promise<AppInfo | null> {
    try { return await this.call<AppInfo>("appinfo", { app }); }
    catch (e) {
      if (e instanceof UiaRequestError && e.code === "unknown_op") return null;
      throw e;
    }
  }

  /**
   * The window an app NAMED by `handle` already has open: the one this handle's own launch
   * opened, else one of the program the Start-menu entry runs. Never by title — a browser tab
   * can be titled "Calculator" — and never the frame every Store app shares, so a Store app
   * that is minimized or still starting is not found here.
   */
  private async openWindowOf(handle: string, info: AppInfo | null): Promise<{ row: WindowRow; others: number } | null> {
    const rows = await this.windows();
    const mine = this.launched?.id === handle ? rows.find((r) => r.hwnd === this.launched!.hwnd) : undefined;
    if (mine) return { row: mine, others: 0 };
    const exe = info?.exe?.trim().toLowerCase();
    if (!exe || isSharedFrameHost(exe)) return null;
    const same = rows.filter((r) => r.process.toLowerCase() === exe);
    return same.length ? { row: same[0]!, others: same.length - 1 } : null;
  }

  /**
   * Ask the user about the app a launch would start, BEFORE starting it: a started app is on
   * their screen, in front, whatever they answer afterwards (macos/driver-apps.ts `ensure` asks
   * at the same point). It is asked about by the program it runs, which is the name its window is
   * then cleared under — so an app allowed ahead of time starts without a question, and one the
   * user refuses is never started. Resolves with what {@link launchAndBind} needs of it; throws
   * the refusal.
   */
  private async clearLaunch(app: string, info: AppInfo | null): Promise<{ note: string } | { askedAs: string; shown: string; exe: string | null; asked: boolean }> {
    // A helper that predates `appinfo` still starts apps: the question is then about the name.
    const { app: askedAs, shown } = launchConsent(app, info, await this.startMenu().catch(() => [] as StartApp[]));
    // The frame every Store app shares is no app, and no answer about it clears anything.
    if (isSharedFrameHost(askedAs)) return { note: `${askedAs} frames the windows of Store apps and is not an app to start; name the app itself. Nothing was started` };
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
   *
   * With a `handle` the caller bound a NAME (computer.surface('Calculator')), which means the
   * app, not "another instance of it": when the app already has a window open, that window is
   * bound and nothing is started — which needs no desktop interaction either. It is how a handle
   * whose clearance ran out (an answer for one call) comes back to its own window, where
   * starting the app again would put a second one in front of the user on every call.
   * `launchApp({app})` passes no handle and always starts.
   */
  protected async launchAndBind(app: string, handle?: string): Promise<ActResult> {
    if (!app.trim()) return { ok: false, note: "launch_app needs an app: a Start-menu name or id from listApps(), or a program name (notepad, mspaint)" };
    let info: AppInfo | null;
    try { info = await this.appInfo(app); }
    catch (e) {
      if (!(e instanceof UiaRequestError)) throw e;
      return { ok: false, note: e.message };
    }
    const open = handle ? await this.openWindowOf(handle, info) : null;
    if (open) {
      // Asked about as any open window is: by its program and title, with no word of starting it.
      const bound = await this.focusTarget(String(open.row.hwnd));
      if (!bound.ok) return bound;
      this.launched = { id: handle!, hwnd: open.row.hwnd };
      return { ok: true, note: `"${open.row.title}" (${open.row.process}) was already open, so it is the target and nothing was started`
        + (open.others ? ` — ${open.others} more ${open.row.process} window${open.others > 1 ? "s are" : " is"} open, computer.surfaces() lists them` : "")
        + "; reads and supported background UIA actions do not activate it; desktop actions do" };
    }
    if (this.interactionMode !== "desktop") return { ok: false, note: LAUNCH_NEEDS_DESKTOP };
    const consent = await this.clearLaunch(app, info);
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
    const deadline = Date.now() + LAUNCH_WAIT_MS;
    while (!pick && Date.now() < deadline) {
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
    // A Store app's frame shows before the app is attached to it, and only then says which app
    // it is: binding it sooner would ask the user about the frame's program instead of the app's.
    const up = await this.identified(pick, Math.max(deadline, Date.now() + 3000));
    if (!up || (isSharedFrameHost(up.process) && !this.gate.cleared(up.process))) {
      return { ok: false, mayHaveActed: true, note: `started ${started.name}, but ${up ? `its window "${up.title}" cannot be bound yet: ${NOT_IDENTIFIED_YET}` : "its window closed again at once"}. `
        + "Do not start it again: computer.surfaces() lists the windows" };
    }
    // The user was asked about this launch; the window it opened is what they answered about,
    // also when it belongs to another program than the one the question could name.
    if (named(up)) this.gate.extend(consent.askedAs, up.process || "?");
    pick = up;
    const bound = await this.focusTarget(String(pick.hwnd));
    if (!bound.ok) return { ...bound, mayHaveActed: true };
    this.leftFront = { pid: pick.pid, at: Date.now() };
    this.launched = { id: handle ?? `app:${app}`, hwnd: pick.hwnd };
    return { ok: true, note: `${fresh ? "started" : "brought forward the running"} ${started.name} — its window "${pick.title}" (${pick.process}) is now the target, in front of the user; observe() to see it` };
  }
}
