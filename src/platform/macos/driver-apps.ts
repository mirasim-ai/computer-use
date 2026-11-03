/**
 * Which app, which window, and may we touch it: the RESOLUTION slice of {@link MacosDriver}.
 *
 * Everything between "a session asked for an app" and "we hold a live pid and window id". The
 * helper call lives here because its error mapping is part of that job: a missing grant, a
 * locked screen and an app that went away become reasons the model can act on, not exceptions.
 * Constructor-owned fields are abstract here and supplied in driver.ts.
 */

import { ComputerUseDriver } from "../driver.ts";
import { SurfaceGoneError, SurfaceUnreadableError } from "../types.ts";
import { AxRequestError, type AxTransport } from "./ax-client.ts";
import { DESKTOP_INPUT_OPS, DesktopInteractionRequired, clipboardChord } from "./interaction-policy.ts";
import { ACT_OPS, NO_ACCESSIBILITY_ACT, NO_SCREEN_RECORDING, grantRoute, noAccessibility } from "./permissions.ts";
import type { UserConsent } from "../types.ts";
import type { MacosApprovals } from "./approvals.ts";
import {
  NAME_AN_APP,
  appExitedNote,
  backgroundOnlyNote,
  consentQuestion,
  declinedNote,
  launchedNote,
  notAllowedNote,
  noWindowYetNote,
  ownAppNote,
  panelOnLaunchNote,
} from "./narrate.ts";
import {
  type AxApp,
  type AxWindowRow,
  type AxLaunch,
} from "./ax-shapes.ts";

/** How long to wait before deciding an app that stopped answering has EXITED rather than hung:
 *  a quitting pid lingers a beat. @see MacosDriverApps.call */
const EXIT_SETTLE_MS = 400;

/** Is this pid still there? Signal 0 asks the kernel and delivers nothing; EPERM means the process
 *  exists and is not ours to signal, which is still ALIVE. @see MacosDriverApps.call */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export abstract class MacosDriverApps extends ComputerUseDriver {
  protected dispatchedActions = 0;
  /** Supplied by the constructor in {@link MacosDriver}. */
  protected abstract readonly ax: AxTransport;
  /** The apps a host that cannot ask may drive (`COMPUTER_USE_MACOS_FALLBACK_APPS`), or null for "any". */
  protected abstract readonly fallback: Set<string> | null;
  /** The apps this agent runs inside (`COMPUTER_USE_HOST_APPS`): never listed, never driven. */
  protected abstract readonly hostApps: ReadonlySet<string>;
  /** The host's way to ask its user, when it has one. */
  protected abstract readonly consent: UserConsent | null;
  /** Apps an answer cleared for this session (`persist: "session" | "always"`). Emptied per app by a revoke. */
  protected readonly approved = new Set<string>();
  /** Apps an answer with no `persist` cleared for the CURRENT computer_repl call only. Emptied
   *  by {@link endCall}. */
  private readonly approvedThisCall = new Set<string>();
  /** The "always" answers this platform keeps itself, for a host that keeps none (approvals.ts). */
  protected abstract readonly stored: MacosApprovals;

  override endCall(): void {
    this.approvedThisCall.clear();
  }

  /** Pids this session LAUNCHED. The quit guard's question: an app the user had open is not ours
   *  to close, and one we started has nobody else to. */
  private readonly launchedPids = new Set<number>();

  /** @see launchedPids */
  protected startedHere(pid: number): boolean {
    return this.launchedPids.has(pid);
  }

  /** @see launchedPids — recorded by whichever launch path ran. */
  protected noteStarted(pid: number): void {
    this.launchedPids.add(pid);
  }
  /** The bundle the session asked for, if it named one. */
  protected abstract readonly wantBundle: string | undefined;
  /** Drop everything derived from the bound app (frame, ref table, delta base), implemented in
   *  {@link MacosDriver}. Called whenever this slice binds a DIFFERENT app. */
  protected abstract forgetApp(): void;
  /** Queue one fact for the next tool result, implemented in {@link MacosDriver}. */
  protected abstract addNote(note: string): void;

  /** The app this driver is bound to, once resolved. */
  protected app: AxApp | null = null;
  protected windowId: number | null = null;
  /** What the helper last SAID about the two grants, or null while it has not answered: "too old
   *  to tell" is not "denied". A grant seen granted is kept (revoking one cuts access outright); a
   *  missing one is re-asked, since the user may be fixing it right now. */
  protected granted: { accessibility: boolean; screenRecording: boolean } | null = null;
  /** Has a call in this session been refused for the accessibility grant? Asked by roads that
   *  would otherwise answer with their own reason and bury the one that matters. */
  protected accessRefused = false;

  protected notAllowed(bundle: string): string {
    return notAllowedNote(bundle, this.fallback);
  }

  /** Can this session put a question to the user right now? */
  protected get asking(): boolean {
    return this.consent?.available() === true;
  }

  /**
   * May this session touch `bundle` WITHOUT asking — read its windows, act in it? Cleared by the
   * host's answer or by the fallback list; with neither a way to ask nor a list, every app is
   * (the standalone CLI, where the user IS the operator). Never the app this agent runs inside.
   */
  protected cleared(bundle: string): boolean {
    if (this.hostApps.has(bundle)) return false;
    if (this.approved.has(bundle) || this.approvedThisCall.has(bundle) || this.fallback?.has(bundle)) return true;
    if (!this.asking) return this.fallback === null;
    return this.stored.has(bundle);
  }

  /**
   * THE gate: every action on an app passes here first (`ensure` re-checks the bound app on each
   * call, `keyPid` the process a key really reaches). A cleared app costs a set lookup; an
   * uncleared one is put to the user through the host. The answer's persist decides how long it
   * holds: none = this call, `session` = this session, `always` = on disk too (approvals.ts,
   * unless the host turned that store off). A revoke drops all three.
   *
   * Throws with the reason on a no, so the run stops on the refusal itself. `name` may be a thunk
   * so a cleared app does not pay for a display-name lookup.
   */
  protected async authorize(bundle: string, name: string | (() => Promise<string>)): Promise<void> {
    if (this.hostApps.has(bundle)) throw new Error(`mirasim-cu: ${ownAppNote(bundle)}`);
    if (this.cleared(bundle)) return;
    if (!this.asking) {
      this.permissionRefusal = `mirasim-cu: ${this.notAllowed(bundle)}`;
      throw new Error(this.permissionRefusal);
    }
    const display = typeof name === "string" ? name : await name();
    const started = Date.now();
    let answer: Awaited<ReturnType<UserConsent["ask"]>>;
    try {
      answer = await this.consent!.ask(consentQuestion(display, bundle), {
        "mirasim-computer-use/macosApp": { bundle, name: display, ...(this.consentPurpose ? { purpose: this.consentPurpose } : {}) },
        persist: ["session", "always"],
      });
    } finally {
      // A person deciding is not a slow surface: the run's time cap must not count it.
      this.waitedOnUserMs += Date.now() - started;
    }
    if (!answer.allowed) {
      this.permissionRefusal = `mirasim-cu: ${declinedNote(display, bundle, answer.reason)}`;
      throw new Error(this.permissionRefusal);
    }
    if (!answer.persist) { this.approvedThisCall.add(bundle); return; }
    this.approved.add(bundle);
    if (answer.persist === "always") this.stored.add(bundle);
  }

  /** The host took these back: whatever held them — this call, this session, the disk store. */
  protected revoke(bundles: string[]): void {
    for (const b of bundles) {
      this.approved.delete(b);
      this.approvedThisCall.delete(b);
      this.stored.remove(b);
    }
  }

  /** An app's display name for the question, running or installed; the bundle id when neither. */
  protected async displayName(bundle: string): Promise<string> {
    const running = (await this.lookup({ bundles: [bundle] }))[0];
    if (running) return running.name;
    return (await this.installed([bundle]))[0]?.name ?? bundle;
  }
  // ── Connection (lazy: no helper until a primitive is called) ────────────────

  protected async call<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.interactionMode === "background"
        && (DESKTOP_INPUT_OPS.has(op) || (["key", "backgroundkey"].includes(op) && clipboardChord(String(params.chord ?? ""))))) {
      throw new DesktopInteractionRequired(op);
    }
    try {
      if (ACT_OPS.has(op)) this.dispatchedActions++;
      return (await this.ax.request(op, params)) as T;
    } catch (e) {
      // The helper's error CODE is the diagnosis (which grant); replace its message rather than
      // append, or both would explain the responsible app. SurfaceUnreadableError, as for a locked
      // screen: the surface is THERE and reads again once the user acts, so the reason must reach
      // the model whole, not as an exception or a "(observe failed: …)" it retries.
      if (e instanceof AxRequestError && e.code === "not_trusted") {
        // Proof the accessibility grant is missing. Kept apart from {@link granted}, the probe's
        // answer about BOTH grants: writing false there would also imply screen recording is
        // missing, which changes the refusal's wording.
        this.accessRefused = true;
        throw new SurfaceUnreadableError(ACT_OPS.has(op) ? NO_ACCESSIBILITY_ACT : noAccessibility(this.granted?.screenRecording === false));
      }
      if (e instanceof AxRequestError && e.code === "not_granted_screen") throw new SurfaceUnreadableError(NO_SCREEN_RECORDING);
      if (e instanceof AxRequestError && e.code === "no_app") {
        // The helper is certain (it looked the pid up), so no settle wait; same sentence as below.
        const gone = this.app;
        this.app = null;
        this.windowId = null;
        throw new SurfaceGoneError(gone ? appExitedNote(gone.name, op) : e.message);
      }
      // An app that EXITED during the call (e.g. a click on its close button) answers "did not
      // answer Accessibility" just like a hung one, so an action that worked reads as failed. The
      // pid tells them apart. ONLY this error shape: "does not support that" is a definite answer
      // from a live app and must never be re-read as an exit. A quitting pid lingers a beat, so
      // wait once before deciding.
      if (e instanceof AxRequestError && e.code === "ax_error" && this.app && /did not answer Accessibility/.test(e.message)) {
        await new Promise((r) => setTimeout(r, EXIT_SETTLE_MS));
        if (!alive(this.app.pid)) {
          const gone = this.app;
          this.app = null;
          this.windowId = null;
          throw new SurfaceGoneError(appExitedNote(gone.name, op));
        }
      }
      throw e;
    }
  }

  /**
   * Refresh {@link granted} from the helper. Only `listTargets` calls it: every other path learns
   * the missing grant from an error CODE, but a listing SUCCEEDS without either grant
   * (`NSWorkspace` and `CGWindowList` need neither), so an ungranted session looks healthy.
   *
   * Never throws: a prebuilt helper (`COMPUTER_USE_MACOS_AX_BIN`) may not know the op, and a
   * listing must not fail over a note.
   */
  protected async refreshGrants(): Promise<void> {
    if (this.granted?.accessibility && this.granted.screenRecording) return;
    try {
      const r = await this.call<{ accessibility?: boolean; screenRecording?: boolean }>("capabilities");
      this.granted = { accessibility: r.accessibility === true, screenRecording: r.screenRecording === true };
    } catch {
      // Leave the last verified answer (or none): a probe failure must never read as a denial.
    }
  }

  /** The listing's caveat (the base's {@link targetsNote} hook): stops the model reading an
   *  unreadable session as a set of empty apps. */
  override targetsNote(): string | null {
    if (!this.granted) return null;
    const notes: string[] = [];
    if (!this.granted.accessibility) {
      // `apps` needs no grant while `windows` is AX-gated and its refusal becomes an empty row
      // list, so EVERY app lists as "no windows". Say why.
      notes.push(`Accessibility is not granted: the apps above are real, but their WINDOWS and controls cannot be read — that is why every one of them lists as "no windows", and why an observation would come back empty. ${grantRoute("Accessibility")}`);
    }
    if (!this.granted.screenRecording) {
      notes.push(`Screen Recording is not granted: no window here can be photographed. ${grantRoute("Screen Recording")}`);
    }
    return notes.length ? notes.join("\n") : null;
  }

  protected async apps(): Promise<AxApp[]> {
    return (await this.call<{ apps: AxApp[] }>("apps")).apps;
  }

  /** Ask about NAMED apps only. Paths that know which app they mean use this, not `apps`: it is
   *  live where the enumeration is not, and never looks outside a fallback list. */
  protected async lookup(by: { bundles?: string[]; pids?: number[] }): Promise<AxApp[]> {
    return (await this.call<{ apps: AxApp[] }>("lookup", { bundles: by.bundles ?? [], pids: by.pids ?? [] })).apps;
  }

  /** The apps `computer.surfaces()` lists. Under a fallback list with no way to ask, exactly
   *  those bundles. Otherwise the whole enumeration: an uncleared app is still NAMEABLE (binding
   *  it asks); only its windows stay unread (driver-targets.ts). */
  protected async scopedApps(): Promise<AxApp[]> {
    const apps = this.fallback && !this.asking
      ? (this.fallback.size ? await this.lookup({ bundles: [...this.fallback] }) : [])
      : await this.apps();
    return apps.filter((a) => !this.hostApps.has(a.bundle));
  }

  /** Which of these bundles are INSTALLED (display name only, no pid), for the listing's
   *  not-running half. A bundle nothing installs yields no row. */
  protected async installed(bundles: string[]): Promise<Array<{ bundle: string; name: string }>> {
    if (!bundles.length) return [];
    return (await this.call<{ apps: Array<{ bundle: string; name: string }> }>("installed", { bundles })).apps;
  }

  /** The app's windows AND whether the screen is locked: the session-wide reason they can all be
   *  off-screen at once, which every channel has to name. */
  protected async windows(pid: number): Promise<{ rows: AxWindowRow[]; locked: boolean }> {
    const r = await this.call<{ windows: AxWindowRow[]; locked: boolean }>("windows", { pid });
    return { rows: r.windows, locked: r.locked };
  }

  /**
   * Resolve the app on first use. It is NAMED or there is no session: this layer never picks one
   * of the user's apps. A fallback list of one is a PERMISSION, not a default. A named app that is
   * not running is launched (see {@link launchNamed}).
   *
   * Every read and verb comes through here, so {@link authorize} checks EACH action, and a
   * clearance revoked mid-session stops the next action.
   */
  protected async ensure(): Promise<{ pid: number; window: number | undefined }> {
    if (this.app) {
      await this.authorize(this.app.bundle, this.app.name);
      return { pid: this.app.pid, window: this.windowId ?? undefined };
    }
    const want = this.wantBundle;
    if (!want) throw new Error(NAME_AN_APP);
    // Ask about THIS bundle alone: the enumeration cannot see an app started after the helper.
    const running = (await this.lookup({ bundles: [want] }))[0];
    // Before the launch: starting an app is already touching it.
    await this.authorize(want, running?.name ?? (() => this.displayName(want)));
    const pick = running ?? await this.launchNamed(want);
    // A named lookup reaches processes the listing never shows (`liveApps`), and one kind of them
    // has nothing to drive at all — @see narrate.ts.
    if (pick.background) throw new Error(`mirasim-cu: ${backgroundOnlyNote(want, pick.pid)}`);
    this.app = pick;
    return { pid: pick.pid, window: undefined };
  }

  /**
   * The named app is not running, so run it in the BACKGROUND (the helper's `launch` sets
   * `activates = false`): the user's front window does not move. Refusing instead would force an
   * explicit launch before every session on a quit app.
   *
   * The note matters: an app just started reads like one the user had open, but holds an empty
   * document, no selection, nothing the task can build on.
   */
  private async launchNamed(bundle: string): Promise<AxApp> {
    let launched: AxLaunch;
    try {
      launched = await this.call<AxLaunch>("launch", { bundle });
    } catch (e) {
      // Not the SurfaceGoneError `call` makes of `no_app`, which stops the whole task
      // (entries/mcp.ts): naming a different app is still a live option.
      throw new Error(`mirasim-cu: ${bundle} is not running and could not be launched — `
        + `${e instanceof Error ? e.message : String(e)}; computer.surfaces() shows what IS running`);
    }
    this.forgetApp();
    // One wording for both launch paths — narrate.ts `launchedNote` carries why.
    // No trailing period: the observation header adds one (`NOTE: ${pending}.`).
    if (launched.started !== false) this.noteStarted(launched.app.pid);
    const who = launchedNote(launched.app.name, launched.app.pid, launched.started !== false);
    const landed = launched.windows === 0
      ? `. ${noWindowYetNote(launched.app.name)}`
      : (launched.panel ? `. ${panelOnLaunchNote(launched.app.name)}` : "");
    this.addNote(launched.ready
      ? `${who}${landed}`
      : `${who}, but it is not answering Accessibility yet. If this observation is empty, wait({ms:2000}) and observe again`);
    return launched.app;
  }
}
