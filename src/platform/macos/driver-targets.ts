/**
 * The target LISTING and the switch between targets: which apps and windows a session may name,
 * and what happens when it names one that is not running. Third slice of {@link MacosDriver}'s
 * chain, after {@link MacosDriverRead}. `launch` lives here because the listing offers rows for
 * apps that are not running, and binding one starts it.
 */

import type { ActResult, TargetInfo } from "../types.ts";
import { MacosDriverRead } from "./driver-read.ts";
import { launchedNote, noWindowYetNote, panelOnLaunchNote, unclearedAppNote } from "./narrate.ts";
import { pinnable, type AxLaunch, type AxWindowRow } from "./ax-shapes.ts";
import { noAccessibility } from "./permissions.ts";

export abstract class MacosDriverTargets extends MacosDriverRead {
  async listTargets(): Promise<TargetInfo[]> {
    // Before the listing, because the listing is what the note qualifies (see refreshGrants).
    await this.refreshGrants();
    const apps = await this.scopedApps();
    const out: TargetInfo[] = [];
    for (const app of apps) {
      // An uncleared app is listed by NAME only: window titles are content (a mail subject), read
      // only once the user says yes. Binding the row is how they get asked.
      if (!this.cleared(app.bundle)) {
        out.push({ id: `${app.pid}`, kind: "app", title: `${app.name} (${app.bundle}) — ${unclearedAppNote()}`, active: false });
        continue;
      }
      const { rows: wins, locked } = await this.windows(app.pid).catch(() => ({ rows: [] as AxWindowRow[], locked: false }));
      // Only windows the window server lists carry an id (`-1` = minimised, on another Space, or
      // mid-resize); the rest are reachable through the app-level target, never as `<pid>:-1`.
      const named = wins.filter((w) => pinnable(w.id) !== null);
      for (const w of named) {
        out.push({
          id: `${app.pid}:${w.id}`,
          kind: "window",
          title: `${app.name} (${app.bundle}) — ${w.title || "(untitled)"}`,
          active: this.app?.pid === app.pid && this.windowId === w.id,
          // What the APP says is its own front window — the same order `pickWindow` walks by.
          ...(w.focused || w.main ? { primary: true } : {}),
        });
      }
      if (named.length === 0) {
        // Windows counted here that the tree read calls absent or empty: a locked screen is by
        // far the most common reason, so say so.
        const why = locked ? " — the screen is LOCKED; they come back when the user unlocks it" : "";
        const note = wins.length === 0 ? `no windows${why}` : `${wins.length} window(s), none on screen${why}`;
        out.push({ id: `${app.pid}`, kind: "app", title: `${app.name} (${app.bundle}) — ${note}`, active: this.app?.pid === app.pid });
      }
    }
    // The other half: CLEARED apps that are not running (binding one starts it, see `focusTarget`).
    // Only cleared ones, the one bounded set; any other installed app is reached by bundle id
    // (`unlistedTarget`). Host apps are dropped here as in `scopedApps`, so the halves agree (see
    // narrate.ts `ownAppNote`).
    const nameable = new Set([...(this.fallback ?? []), ...this.approved]);
    let missing = [...nameable].filter((b) => !this.hostApps.has(b) && !apps.some((a) => a.bundle === b));
    // A cleared app can be RUNNING and still missing above: an accessory app (no Dock icon) is
    // outside the regular-only listing. A named lookup reaches it.
    for (const app of missing.length ? await this.lookup({ bundles: missing }) : []) {
      out.push({ id: `${app.pid}`, kind: "app", title: `${app.name} (${app.bundle}) — running without a Dock icon`, active: this.app?.pid === app.pid });
      missing = missing.filter((b) => b !== app.bundle);
    }
    for (const app of await this.installed(missing)) {
      out.push({ id: app.bundle, kind: "app", title: `${app.name} (${app.bundle}) — not running; binding it starts it`, active: false });
    }
    return out;
  }

  async focusTarget(id: string): Promise<ActResult> {
    const [pidStr, winStr] = id.split(":");
    // A row for an app that is NOT running carries its bundle id instead of a pid; switching to it
    // starts it, else the listing would hand out handles whose every verb fails.
    if (!/^\d+$/.test(pidStr ?? "")) return this.launch(id);
    const pid = Number(pidStr);
    // By pid, freshly, so an app started after the helper resolves. Uncleared apps resolve too, so
    // the gate below can ask about (or refuse) the app by name.
    const app = Number.isFinite(pid) ? (await this.lookup({ pids: [pid] }))[0] : undefined;
    if (!app) return { ok: false, note: `no running app with pid ${pidStr}; call computer.surfaces() for current ids` };
    await this.authorize(app.bundle, app.name);
    const { rows: wins } = await this.windows(pid);
    const win = winStr === undefined ? wins.find((w) => w.main) ?? wins[0] : wins.find((w) => String(w.id) === winStr);
    if (winStr !== undefined && !win) return { ok: false, note: `${app.name} has no window ${winStr} any more; call computer.surfaces() for current ids` };
    this.forgetApp();
    this.app = app;
    this.windowId = win ? pinnable(win.id) : null;
    this.frame = win ?? null;
    return { ok: true, note: `now driving ${app.name}${win ? ` — ${win.title || "(untitled)"}` : ""} (in the background; the user's focus is untouched)` };
  }


  /**
   * An installed app named by bundle id that the listing does not carry — not running, and not
   * cleared, so it has no "not running" row. Binding the row this returns starts it through
   * {@link launch}, which is where the user is asked. Under a fallback list with no way to ask,
   * only the list's own apps qualify (and those are already listed), so nothing is offered.
   */
  override async unlistedTarget(query: string): Promise<TargetInfo | null> {
    const q = query.trim();
    if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){1,}$/.test(q) || this.hostApps.has(q)) return null;
    if (this.fallback && !this.asking) return null;
    // RUNNING but not listed: an accessory app (e.g. com.apple.screencaptureui), which only a named
    // lookup reaches. Its pid row is bound like any other, the consent gate included.
    const running = (await this.lookup({ bundles: [q] }))[0];
    if (running) return { id: `${running.pid}`, kind: "app", title: `${running.name} (${running.bundle}) — running without a Dock icon; binding it asks as usual`, active: false };
    const app = (await this.installed([q]))[0];
    return app ? { id: app.bundle, kind: "app", title: `${app.name} (${app.bundle}) — not running; binding it starts it`, active: false } : null;
  }

  /** Also true for the BUNDLE-ID name of the app this driver is already driving: the listing
   *  hands that name out while the app is not running, and a handle made from it outlives the
   *  launch that gave the app a pid. @see ComputerUseDriverBase.isActiveTarget */
  override async isActiveTarget(id: string): Promise<boolean> {
    if (this.app && id === this.app.bundle) return true;
    // An APP-level id (a bare pid, handed out while the app has no window) names the app, whichever
    // window it has since opened. Compared as a window id it would re-bind on every verb once a
    // window appeared, and re-binding forgets the refs the caller just observed.
    if (this.app && /^\d+$/.test(id) && Number(id) === this.app.pid) return true;
    return super.isActiveTarget(id);
  }

  protected async launch(bundle: string): Promise<ActResult> {
    if (!bundle) return { ok: false, note: "launch_app needs a bundle id, e.g. com.apple.TextEdit" };
    await this.authorize(bundle, () => this.displayName(bundle));
    // Use the launch's OWN handle; a fresh lookup can miss the app it just started. `ready` says
    // whether the app answers Accessibility yet: the helper waits for that (~0.5 s on a cold
    // launch) so the observation this verb takes on its way out does not fail.
    const wasPid = this.app?.pid;
    const { app, ready, started, windows, panel } = await this.call<AxLaunch>("launch", { bundle });
    this.app = app;
    // Both launch paths record it; this is the one `computer.surface('<a quit app>')` reaches.
    // @see MacosDriverApps.startedHere
    if (started !== false) this.noteStarted(app.pid);
    // Only a DIFFERENT app invalidates what was derived from the last one. Every verb on a
    // bundle-id handle comes through here, so an unconditional forget would discard the refs the
    // caller had just observed.
    if (wasPid !== app.pid) this.forgetApp();
    if (!ready) {
      // `launch` needs no grant (`open -b`), so it SUCCEEDS in an ungranted session while its AX
      // readiness probe cannot answer; "wait and observe" would then wait for nothing.
      await this.refreshGrants();
      const note = this.granted && !this.granted.accessibility
        ? `${app.name} is running (pid ${app.pid}) and is now the target, but nothing about it can be READ: ${noAccessibility(!this.granted.screenRecording)}`
        : `${app.name} is running (pid ${app.pid}) and is now the target, but it is not answering Accessibility yet — wait({ms:2000}), then observe(); if it still does not answer, the app may not support Accessibility at all`;
      return { ok: true, note };
    }
    // Same sentence as the transparent path (narrate.ts): the two must agree on found vs started.
    const did = launchedNote(app.name, app.pid, started !== false);
    if (windows === 0) return { ok: true, note: `${did}. It is now the target. ${noWindowYetNote(app.name)}` };
    // Not "its window": a cold document app often comes up with an Open panel, a remote view that
    // is not the app at all. The helper looked, so this can say which.
    if (panel) return { ok: true, note: `${did}. It is now the target. ${panelOnLaunchNote(app.name)}` };
    return { ok: true, note: `${did}. It is now the target; observe() to see its window` };
  }
}
