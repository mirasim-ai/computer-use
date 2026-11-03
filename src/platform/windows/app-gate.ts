/**
 * Which Windows APPS this session may read and act in — the `macos` platform's per-app consent, for
 * Windows (macos/driver-apps.ts `authorize` is the model).
 *
 * An app is named by its executable's stem (`WINWORD`, `CalculatorApp`), compared case-insensitively:
 * it is what the helper reports for every window and what a person can type into an allow-list,
 * while window titles are localised and change with the document.
 *
 * Every read and every action on a window passes {@link WindowsAppGate.authorize} first. A cleared
 * app costs a set lookup; any other is put to the user through the host (MCP elicitation, `_meta`
 * `mirasim-computer-use/windowsApp`), offering `persist: ["session", "always"]`: none = this call, `session` = this
 * session, `always` = kept on disk too — unless the host keeps approvals itself and turns that store
 * off with `COMPUTER_USE_WINDOWS_APPROVALS=""` (e.g. a host that keeps an allow-list in its own settings). A host that cannot
 * ask leaves every app cleared: the standalone CLI, where the user IS the operator.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { UserConsent } from "../types.ts";
import { computerUseHome } from "../home.ts";

const key = (app: string) => app.trim().toLowerCase();

/** "Always" answers this platform keeps itself, for a host that keeps none. */
export class WindowsApprovals {
  readonly file: string | null;

  constructor(env: NodeJS.ProcessEnv) {
    const raw = env.COMPUTER_USE_WINDOWS_APPROVALS;
    this.file = raw === undefined ? join(computerUseHome(env), "windows-approvals.json") : raw.trim() || null;
  }

  /** Read fresh every time: another session may have changed it since. */
  has(app: string): boolean {
    return this.read().includes(key(app));
  }

  list(): string[] {
    return this.read();
  }

  add(app: string): void {
    const now = this.read();
    if (!now.includes(key(app))) this.write([...now, key(app)]);
  }

  remove(app: string): void {
    const now = this.read();
    if (now.includes(key(app))) this.write(now.filter((a) => a !== key(app)));
  }

  private read(): string[] {
    if (!this.file) return [];
    try {
      const apps = (JSON.parse(readFileSync(this.file, "utf8")) as { approvedApps?: unknown }).approvedApps;
      return Array.isArray(apps) ? apps.filter((v): v is string => typeof v === "string").map(key) : [];
    } catch {
      return []; // absent or unreadable: nothing is approved, which only means the user is asked
    }
  }

  private write(apps: string[]): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ approvedApps: apps }, null, 2) + "\n");
    } catch { /* an unwritable store costs the user one more question, never the action */ }
  }
}

export class WindowsAppGate {
  /** Cleared for this session (`persist: "session" | "always"`). */
  private readonly approved = new Set<string>();
  /** Cleared for the current computer_repl call only (an answer with no `persist`). */
  private readonly approvedThisCall = new Set<string>();
  private readonly stored: WindowsApprovals;
  /** The programs this agent runs inside (`COMPUTER_USE_HOST_APPS`): never driven, whatever the answer. */
  private readonly hostApps: ReadonlySet<string>;

  constructor(private readonly consent: UserConsent | null, env: NodeJS.ProcessEnv) {
    this.stored = new WindowsApprovals(env);
    this.hostApps = new Set((env.COMPUTER_USE_HOST_APPS ?? "").split(",").map(key).filter(Boolean));
    // A clearance the host takes back is gone at the next read or action: every one re-checks.
    consent?.onRevoke((apps) => {
      for (const app of apps) {
        this.approved.delete(key(app));
        this.approvedThisCall.delete(key(app));
        this.stored.remove(app);
      }
    });
  }

  /** May this session touch `app` without asking? */
  cleared(app: string): boolean {
    const k = key(app);
    if (this.hostApps.has(k)) return false;
    if (this.approved.has(k) || this.approvedThisCall.has(k)) return true;
    if (this.consent?.available() !== true) return true;
    return this.stored.has(k);
  }

  endCall(): void {
    this.approvedThisCall.clear();
  }

  /**
   * Clear `app` or throw the refusal. `title` is shown only in the question, to the person who is
   * deciding whether the agent may see it. Resolves with the milliseconds spent waiting on them —
   * a person deciding is not a slow surface, so the run's time cap must not count it.
   */
  async authorize(app: string, title: string, purpose: string | null): Promise<number> {
    if (this.hostApps.has(key(app))) throw new AppRefused(`${app} is the app this agent runs inside; Computer Use never drives it`);
    if (this.cleared(app)) return 0;
    const started = Date.now();
    const answer = await this.consent!.ask(`Allow Computer Use to see and control ${app} ("${title}")?`, {
      "mirasim-computer-use/windowsApp": { app, title, ...(purpose ? { purpose } : {}) },
      persist: ["session", "always"],
    });
    const waited = Date.now() - started;
    if (!answer.allowed) {
      throw new AppRefused(`permission to use ${app} was not granted${answer.reason ? ` — ${answer.reason}` : ""}. `
        + "Do not retry and do not ask again in this task; continue without it, or tell the user what you could not do");
    }
    if (!answer.persist) this.approvedThisCall.add(key(app));
    else {
      this.approved.add(key(app));
      if (answer.persist === "always") this.stored.add(app);
    }
    return waited;
  }
}

/** A refusal about the APP (not the window): the run stops on it and reports it as a permission refusal. */
export class AppRefused extends Error {}
