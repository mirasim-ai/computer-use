/**
 * The browser surface's per-session configuration, resolved ONCE from options and env.
 *
 * An embedder running several sessions in ONE process needs a tab and profile dir per session,
 * which a process-wide variable cannot carry, so the environment is snapshotted into a frozen
 * object at session bootstrap and threaded down. Only {@link browserConfigFromEnv} reads env;
 * everything below takes the resolved config (optional, defaulting to the env-derived one).
 */

import { join } from "node:path";
import { computerUseHome } from "../home.ts";

/**
 * A tab claim: this driver owns ONE stamped tab in a SHARED browser, so a respawn re-adopts
 * ITS tab instead of leaking a new one. Two forms:
 *
 *  - `name:<key>` — a tab in the DEFAULT context, cookies shared with the other named tabs.
 *  - `ctx:<key>` — a tab in its OWN isolated context (own cookies and storage), for a surface
 *    whose logins must not be shared either way, e.g. a simulated eval user.
 */
export interface TabClaim {
  key: string;
  /** `ctx:` — the tab lives in its own isolated browser context. */
  isolated: boolean;
}

export interface BrowserConfig {
  /** Chrome user-data dir. The USER'S own when {@link attached}; otherwise ours to manage. */
  readonly profileDir: string;
  /**
   * The profile is the USER'S OWN browser (takeover): never kill by profile dir, never park the
   * window, and an unusable endpoint is an error, not something to clear away. Set by the host,
   * never inferred — a wrong guess destroys a window someone was working in.
   */
  readonly attached: boolean;
  /** Explicit Chrome binary; unset ⇒ the platform install paths, then PATH. */
  readonly chromePath?: string;
  /** The stamped tab this surface owns in a shared browser; null ⇒ no claim. */
  readonly tab: TabClaim | null;
  /** `COMPUTER_USE_TAB=reuse`: continue the most recent working tab instead of opening one. Only
   *  ever right on a browser nobody else touches — on a shared one that tab is someone else's. */
  readonly tabReuse: boolean;
  /** Run-artifact slug (endpoint/journal/shots), so several surfaces sharing one profile dir
   *  keep their own preview files. Unset ⇒ derived from the profile dir's basename. */
  readonly runSlug?: string;
  /** `offscreen` ⇒ the host renders its own preview and wants the window parked. */
  readonly window: "offscreen" | "normal";
  /** CDP endpoint. An explicit one is strict (no fallback, no managed launch). */
  readonly cdpUrl?: string;
  /** Make an env-supplied {@link cdpUrl} strict: a host that picked the user's own browser means
   *  THAT browser, not a quietly launched managed Chrome. */
  readonly cdpStrict: boolean;
  /**
   * `COMPUTER_USE_BROWSER=extension`: the user's own browser through the Mirasim extension, with
   * the bridge found or started by this session (`bridge/acquire-bridge.ts`) under {@link home}.
   * A named {@link cdpUrl} still wins — that is a host passing its own bridge down.
   */
  readonly extension: boolean;
  /** This session's state home (`COMPUTER_USE_HOME`), where its bridge is recorded. */
  readonly home: string;
}

/** Parse `COMPUTER_USE_TAB` into a claim. Anything that is not a well-formed `name:`/`ctx:` key is
 *  no claim at all — including `reuse`, which is a different mode ({@link BrowserConfig.tabReuse}). */
function parseTabClaim(raw: string | undefined): TabClaim | null {
  const m = /^(name|ctx):(.+)$/.exec(raw ?? "");
  if (!m) return null;
  const key = m[2]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(key) ? { key, isolated: m[1] === "ctx" } : null;
}

/** Explicit per-session overrides. Anything left out falls back to the environment. */
export interface BrowserConfigOptions {
  profileDir?: string;
  attached?: boolean;
  chromePath?: string;
  /** The raw `COMPUTER_USE_TAB` form (`name:<key>` / `ctx:<key>` / `reuse`). */
  tab?: string;
  runSlug?: string;
  window?: "offscreen" | "normal";
  cdpUrl?: string;
  cdpStrict?: boolean;
  extension?: boolean;
}

/** Resolve the config: explicit options win, then the environment, then defaults. */
export function browserConfigFromEnv(
  opts: BrowserConfigOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): BrowserConfig {
  const rawTab = opts.tab ?? env.COMPUTER_USE_TAB;
  const cdpUrl = opts.cdpUrl ?? (env.COMPUTER_USE_CDP_URL?.trim() || undefined);
  return Object.freeze({
    profileDir: opts.profileDir ?? defaultProfileDir(env),
    attached: opts.attached ?? env.COMPUTER_USE_ATTACHED === "1",
    chromePath: opts.chromePath ?? (env.COMPUTER_USE_CHROME?.trim() || undefined),
    tab: parseTabClaim(rawTab),
    tabReuse: rawTab === "reuse",
    runSlug: opts.runSlug ?? (env.COMPUTER_USE_RUN_SLUG?.trim() || undefined),
    window: opts.window ?? (env.COMPUTER_USE_WINDOW === "offscreen" ? "offscreen" : "normal"),
    cdpUrl,
    // An explicitly passed URL is strict on its own; an env one needs the flag.
    cdpStrict: opts.cdpStrict ?? (opts.cdpUrl !== undefined || env.COMPUTER_USE_CDP_STRICT === "1"),
    extension: opts.extension ?? env.COMPUTER_USE_BROWSER?.trim() === "extension",
    home: computerUseHome(env),
  });
}

/** The managed profile dir when nothing named one. */
function defaultProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMPUTER_USE_PROFILE_DIR || join(computerUseHome(env), "chrome");
}
