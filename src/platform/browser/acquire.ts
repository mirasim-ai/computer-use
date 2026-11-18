/**
 * Managed-Chrome acquisition — attach when a Chrome already owns the profile, launch otherwise.
 *
 *  - `--remote-debugging-port=0`: Chrome only WRITES `DevToolsActivePort` when it picks the port
 *    itself. That file lets the next caller ATTACH (one HTTP round trip) instead of launching
 *    (~1.6s and ~1GB across 8 processes).
 *  - Adopt with a SHORT deadline: a dead session's leftover whose renderer the system froze still
 *    answers the HTTP ping, then hangs the CDP handshake for ~30s (two stacked CDP timeouts) —
 *    long enough for the agent to conclude the browser is gone. Replacing it takes ~1s.
 *  - A missed deadline is not yet a frozen browser: the handshake waits on EVERY tab, so one tab
 *    that answers nothing fails it for a browser other sessions are working in. The browser is
 *    asked first, and only one that does not answer is replaced ({@link adoptPastStalledTabs}).
 *  - Exit-watcher on the port poll: a Chrome that refuses the profile EXITS within a few hundred
 *    ms; noticing that turns a 15s dead wait into an immediate, accurate failure.
 *  - Kill by identity: SIGTERM only to pids whose own command line names our `--user-data-dir`,
 *    so the user's own Chrome is unreachable by construction (enumeration: `occupancy.ts`).
 *
 * The acquired browser deliberately OUTLIVES this process: the profile keeps logins, the
 * published port lets the next session adopt it, and the endpoint file lets a host find it
 * read-only. Callers disconnect; they do not close.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

import { join } from "node:path";
import type { Browser } from "playwright-core";
import { connectBrowserCdp } from "./cdp-connection.ts";
import { browserConfigFromEnv, type BrowserConfig } from "./config.ts";
import { pingDevTools, readDevToolsPort, waitForDevToolsPort } from "./devtools-port.ts";

// Re-exported so callers keep importing the port helpers from here.
export { pingDevTools, readDevToolsPort } from "./devtools-port.ts";
import { chromeMissingError, findChrome, needsNoSandbox, needsShmFallback } from "./chrome-binary.ts";
import { publishEndpoint } from "./session-files.ts";

// Re-exported: the entries' setup command and the driver both reach these through
// this module.
export { chromeMissingError, findChrome, isAttachedProfile } from "./chrome-binary.ts";
export { actionsFileFor, endpointFileFor, publishTabIdentity, shotsDirFor } from "./session-files.ts";
import { ensureBackgroundTab, newBackgroundPage } from "./tabs.ts";
import { browserPids, killByProfileDir } from "./occupancy.ts";
import { OFFSCREEN_POSITION, keepInBackground, parkWindowOffscreen, unparkWindow, userWantsVisible } from "./window-placement.ts";
import { msgAttachedDeadEnd, msgAttachedWhyHandshake, msgAttachedWhyNoPage, msgAttachedWhyNoPort, msgAttachedWhyStalledTab, msgChromeBinaryUnrunnable, msgChromeExitedImmediately, msgChromeNoPort, msgChromeRefusedAttach, msgChromeStartFailed, stalledTabsClosedNote } from "./messages.ts";
import { closeTabs, unansweringTabs } from "./stalled-tabs.ts";

/** HTTP-ping OK but CDP attach slower than this ⇒ a frozen leftover; kill and relaunch. */
const ADOPT_TIMEOUT_MS = 3000;
/** Attach budget for a browser that ANSWERS but missed {@link ADOPT_TIMEOUT_MS}: a loaded machine,
 *  or many tabs to shake hands with. */
const SLOW_ADOPT_TIMEOUT_MS = 15_000;
/** How long one tab gets to answer a trivial question, each time it is asked. */
const TAB_ANSWER_MS = 1_500;
/** How long a tab that answers nothing is waited for before it is closed: a page can be busy for
 *  seconds (a heavy render, a long task) and come back, and that one keeps its tab. */
const STALLED_TAB_WAIT_MS = 8_000;
/** Attach budget for a browser we JUST launched — it answered /json/version already. */
const LAUNCH_CONNECT_TIMEOUT_MS = 5000;
/** Cold Chrome needs ~1.3s to publish its port; refusals exit far earlier (see exit-watcher). */
const PORT_WAIT_MS = 15_000;
/** Fixed, because screenshot coordinates and `Screen n/m` page counting are read against the
 *  viewport. (Parking is off-screen, never minimised: a minimised window stops compositing,
 *  which kills screencast frames and hangs wheel input.) */
const WINDOW_SIZE = "1440,900";

// Each function takes the resolved per-session config (`config.ts`), defaulting to the
// env-derived one for callers that drive one surface per process (CLI, tests).

/**
 * Open a blank tab through the CDP HTTP endpoint, reviving a browser with zero page targets.
 *
 * ONLY for an EXTERNALLY-attached endpoint (`--cdp`, `COMPUTER_USE_CDP_URL`, :9222), where an
 * emptied browser is a nuisance to route around. On the MANAGED browser zero page targets means
 * the user closed the window, and reopening it would overrule them (see {@link hasPageTarget}).
 */
export async function openBlankTab(cdpUrl: string): Promise<boolean> {
  try {
    const targets = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/list`, { signal: AbortSignal.timeout(2_000) });
    if (!targets.ok) return false;
    const rows = await targets.json() as Array<{ type?: string }>;
    if (!Array.isArray(rows) || rows.some((t) => t.type === "page")) return false;
    const r = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(2_000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Does this endpoint have a real PAGE to drive? This, not the ping, is the liveness question:
 * closing the last window leaves the process alive and `/json/version` answering, with only
 * `background_page` and `service_worker` targets left. Never answered by opening a blank tab:
 * that reopens the window the user just closed.
 */
async function hasPageTarget(cdpUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/list`);
    if (!res.ok) return false;
    const targets = (await res.json()) as Array<{ type?: string; url?: string }>;
    return targets.some((t) => t.type === "page" && !String(t.url ?? "").startsWith("devtools://"));
  } catch {
    return false;
  }
}

/** Teardown by identity (OS knowledge, in `occupancy.ts`), re-exported for callers that only
 *  want "make the profile free". */
export { browserPids, killByProfileDir };

// The window's posture lives in window-placement.ts; re-exported so `acquire` stays the one
// place to ask for "the browser".
export { keepInBackground, revealFlagFor, userWantsVisible } from "./window-placement.ts";

/**
 * Have the managed browser READY — adopt-or-launch — and leave it where the mode says:
 * off-screen in background mode, on-screen only if the user has already asked to see it.
 *
 * Never forces the window front: starting a browser and LOOKING at one are different requests,
 * and only the preview panel's click means the second (see {@link revealFlagFor}). The browser
 * outlives this process (`mirasim-cu browser open` exits after).
 */
export async function openManagedBrowser(
  profileDir?: string,
  cfg: BrowserConfig = browserConfigFromEnv(),
): Promise<void> {
  profileDir ??= cfg.profileDir;
  const { browser } = await acquireManagedBrowser(profileDir, cfg);
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages().find((p) => !p.isClosed()) ?? (await newBackgroundPage(ctx));
    if (userWantsVisible(profileDir)) return; // the user is looking at it — hands off
    await keepInBackground(ctx, page, profileDir, cfg);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** connectOverCDP with a real deadline. No revive: see {@link hasPageTarget}. */
async function connect(cdpUrl: string, timeoutMs: number): Promise<Browser | null> {
  try {
    return await connectBrowserCdp(cdpUrl, timeoutMs);
  } catch {
    return null;
  }
}

/**
 * The ladder: adopt the browser that already owns the profile; kill a frozen leftover by
 * identity; launch fresh; recover once from a port-less profile squatter. Every exit is either
 * a connected browser or an error whose message says what to do.
 */
export async function acquireManagedBrowser(
  profileDir?: string,
  cfg: BrowserConfig = browserConfigFromEnv(),
  opts: { firstUrl?: string } = {},
): Promise<ManagedBrowser> {
  profileDir ??= cfg.profileDir;
  const firstUrl = opts.firstUrl;
  const attached = cfg.attached;
  mkdirSync(profileDir, { recursive: true });
  const existing = readDevToolsPort(profileDir);
  if (existing !== null && (await pingDevTools(existing))) {
    const cdpUrl = `http://127.0.0.1:${existing}`;
    // Answers but has no PAGE: the user closed its windows. Reviving would reopen them, so tear
    // the leftover down and start clean; the caller's "was I driving it?" rule turns this into a
    // STOP for a live turn.
    if (!(await hasPageTarget(cdpUrl))) {
      // ATTACHED: their browser, never killed. The agent opens its OWN window anyway, so one
      // blank tab just makes Playwright's handshake possible again.
      if (attached) {
        await openBlankTab(cdpUrl);
        const revived = await connect(cdpUrl, ADOPT_TIMEOUT_MS);
        if (revived) {
          await publishEndpoint(profileDir, existing, null, cfg);
          return { browser: revived, cdpUrl, profileDir };
        }
        throw attachedDeadEnd(profileDir, msgAttachedWhyNoPage());
      }
      await killByProfileDir(profileDir);
      rmSync(join(profileDir, "DevToolsActivePort"), { force: true });
      return await launchManaged(profileDir, cfg, firstUrl);
    }
    const live = await adoptLive(cdpUrl, existing, profileDir, cfg);
    if (live) return live;
    // A frozen leftover, replaced (see header).
    // ATTACHED: that would mean SIGTERM to the user's browser. Never; say what is wrong.
    if (attached) throw attachedDeadEnd(profileDir, msgAttachedWhyHandshake());
    await killByProfileDir(profileDir);
    rmSync(join(profileDir, "DevToolsActivePort"), { force: true });
  }
  try {
    return await launchManaged(profileDir, cfg, firstUrl);
  } catch (err) {
    // A profile held by a browser with no usable port (what a crashed session leaves): Chrome
    // refuses a second instance on a locked profile, so every call would fail forever. Recover
    // by identity, once; if the relaunch fails again the original error is the honest one.
    const stale = await browserPids(profileDir);
    if (!stale.length) throw err;
    // ATTACHED: that is the ORDINARY case (the user opened Chrome themselves), never forced.
    if (attached) throw attachedDeadEnd(profileDir, msgAttachedWhyNoPort());
    await killByProfileDir(profileDir);
    rmSync(join(profileDir, "DevToolsActivePort"), { force: true });
    return await launchManaged(profileDir, cfg, firstUrl);
  }
}

/** What acquiring the managed browser hands back. `firstTargetId`: the tab a LAUNCH opened, on
 *  `firstUrl` when one was given — the session's tab, since nobody else can have one yet. */
export interface ManagedBrowser {
  browser: Browser;
  cdpUrl: string;
  profileDir: string;
  notes?: string[];
  firstTargetId?: string;
}

/**
 * The managed browser when one is ALREADY running with a window to drive, else null: never
 * launched, replaced or revived. For a session's reads before it has opened anything — a listing
 * or an observation is no reason to put a window on the screen; the first page it opens is
 * (driver-connect.ts). A leftover that needs replacing is left for that open to replace.
 */
export async function adoptManagedBrowser(
  profileDir?: string,
  cfg: BrowserConfig = browserConfigFromEnv(),
): Promise<ManagedBrowser | null> {
  profileDir ??= cfg.profileDir;
  const existing = readDevToolsPort(profileDir);
  if (existing === null || !(await pingDevTools(existing))) return null;
  const cdpUrl = `http://127.0.0.1:${existing}`;
  if (!(await hasPageTarget(cdpUrl))) return null;
  return await adoptLive(cdpUrl, existing, profileDir, cfg);
}

/** Connect to a running browser that has a page, past a tab that holds the handshake up; null
 *  when it does not answer (a frozen leftover, the caller's to replace). */
async function adoptLive(cdpUrl: string, port: number, profileDir: string, cfg: BrowserConfig): Promise<ManagedBrowser | null> {
  const adopted = await connect(cdpUrl, ADOPT_TIMEOUT_MS);
  if (adopted) {
    await publishEndpoint(profileDir, port, null, cfg);
    return { browser: adopted, cdpUrl, profileDir };
  }
  // Pinged but no CDP within the short deadline. A browser that still answers is not replaced:
  // it is one of its tabs holding the handshake up, or the handshake only needs longer.
  const live = await adoptPastStalledTabs(cdpUrl, profileDir, cfg.attached);
  if (!live) return null;
  await publishEndpoint(profileDir, port, null, cfg);
  return { browser: live.browser, cdpUrl, profileDir, ...(live.notes.length ? { notes: live.notes } : {}) };
}

/**
 * The handshake with a running browser timed out. Ask the browser itself what is wrong, on a
 * socket that waits on no tab ({@link unansweringTabs}):
 *
 *  - it does not answer: null, and the caller replaces it, as before;
 *  - it answers and so does every tab: the handshake is only slow, so it gets a longer deadline;
 *  - a tab answers nothing: that tab is what failed the handshake, and it would fail every later
 *    one too, for every session. It is given {@link STALLED_TAB_WAIT_MS} to come back (a page that
 *    is only busy keeps its tab), then that ONE tab is closed and the session told which. Killing
 *    the browser for it, as this did, took every other session's pages along.
 *
 * ATTACHED: the tabs are the user's, so none is closed; the refusal names the one that is stuck.
 */
async function adoptPastStalledTabs(cdpUrl: string, profileDir: string, attached: boolean): Promise<{ browser: Browser; notes: string[] } | null> {
  let silent = await unansweringTabs(cdpUrl, TAB_ANSWER_MS);
  for (const deadline = Date.now() + STALLED_TAB_WAIT_MS; silent?.length && Date.now() < deadline;) {
    await sleep(500);
    silent = await unansweringTabs(cdpUrl, TAB_ANSWER_MS);
  }
  if (!silent) return null;
  const notes: string[] = [];
  if (silent.length) {
    if (attached) throw attachedDeadEnd(profileDir, msgAttachedWhyStalledTab(silent));
    await closeTabs(cdpUrl, silent.map((t) => t.targetId));
    notes.push(stalledTabsClosedNote(silent));
  }
  const browser = await connect(cdpUrl, SLOW_ADOPT_TIMEOUT_MS);
  return browser ? { browser, notes } : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An attached profile's only outcome when the browser cannot be driven: an error naming the
 *  fix. Every branch that would otherwise reach for {@link killByProfileDir} ends here. */
function attachedDeadEnd(profileDir: string, why: string): Error {
  return new Error(msgAttachedDeadEnd(profileDir, why));
}

async function launchManaged(profileDir: string, cfg: BrowserConfig, firstUrl?: string): Promise<ManagedBrowser> {
  const exe = findChrome(cfg);
  if (!exe) throw chromeMissingError();
  // Clear a previous browser's stale port file, so the wait reads the one THIS launch publishes.
  rmSync(join(profileDir, "DevToolsActivePort"), { force: true });
  // MINIMAL FLAGS: nothing that changes page-visible state (UA, webdriver, headless) — that is
  // what gets an automated browser noticed. Position is the only presentation knob
  // (COMPUTER_USE_WINDOW=offscreen for hosts that render their own preview).
  // ATTACHED: the browser is the USER'S and its first window is theirs; parked, their Chrome
  // would "open with no window" from the Dock. Only the agent's own window is a background one.
  const offscreen = cfg.window === "offscreen" && !cfg.attached;
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    // 🔴 Root on Linux cannot launch Chromium WITH its sandbox: the zygote host aborts before
    // the first frame ("Running as root without --no-sandbox is not supported"), i.e. every
    // launch in a root container (see needsNoSandbox). Here, not in a wrapper: the managed
    // browser is spawned directly from the exe findChrome resolved.
    ...(needsNoSandbox() ? ["--no-sandbox"] : []),
    // A container's 64 MB /dev/shm crashes tabs on heavy pages (see needsShmFallback).
    ...(needsShmFallback() ? ["--disable-dev-shm-usage"] : []),
    // Stay out of the OS keychain: Chrome's cookie encryption otherwise opens or CREATES the
    // login keychain, and a missing or locked one blocks every launch behind a system dialog
    // (Linux: gnome-keyring/kwallet). Mock-keychain is Playwright's own default; cookies still
    // persist. ATTACHED: never — the user's cookies are encrypted with the REAL key, and Chrome
    // would discard them all as undecryptable.
    ...(cfg.attached ? []
      : process.platform === "darwin" ? ["--use-mock-keychain"]
      : process.platform === "linux" ? ["--password-store=basic"]
      : []),
    `--window-size=${WINDOW_SIZE}`,
    // Position is set ONLY to park a background window; a visible one is Chrome's to place,
    // where the profile last had it.
    ...(offscreen ? [`--window-position=${OFFSCREEN_POSITION}`] : []),
    // ALWAYS start with no window, then open the first tab in the background
    // (ensureBackgroundTab): a normal launch makes Chrome the frontmost app, off-screen or not,
    // stealing the user's keyboard. A visible window still lands where Chrome puts it.
    // 🔴 --silent-launch, NOT --no-startup-window: Chrome reads --no-startup-window plus a
    // remote-debugging port as "an automation process owns my lifetime" and holds a keep-alive
    // until CDP Browser.close. ⌘Q and Dock › Quit then close the windows but leave the process
    // (and its Dock icon) running until it is force-quit. --silent-launch skips the startup
    // window without that keep-alive, so the user's quit ends the browser.
    "--silent-launch",
  ];
  // Detached with no pipes: an inherited stdio pipe would keep Node's event loop alive, and the
  // browser must be able to outlive the process that started it.
  const child = spawn(exe, args, { stdio: "ignore", detached: true });
  child.unref();
  let exited = false;
  const spawnError: { e: (Error & { code?: string }) | null } = { e: null };
  child.once("exit", () => { exited = true; });
  // MANDATORY: `spawn` reports a bad executable through an ASYNC 'error' event, and an unhandled
  // one is an uncaught exception that takes down the whole process. It also stops the port wait
  // at once instead of burning 15s on a child that never started.
  child.once("error", (e: Error & { code?: string }) => { spawnError.e = e; exited = true; });

  const port = await waitForDevToolsPort(profileDir, PORT_WAIT_MS, () => exited);
  if (port === null) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    const failed = spawnError.e;
    if (failed) {
      throw new Error(
        failed.code === "ENOENT" || failed.code === "EACCES"
          ? msgChromeBinaryUnrunnable(exe, failed.code)
          : msgChromeStartFailed(failed.code ?? failed.message),
      );
    }
    throw new Error(exited ? msgChromeExitedImmediately() : msgChromeNoPort());
  }
  const cdpUrl = `http://127.0.0.1:${port}`;
  const browser = await connect(cdpUrl, LAUNCH_CONNECT_TIMEOUT_MS);
  if (!browser) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    throw new Error(msgChromeRefusedAttach());
  }
  // --silent-launch left nothing to drive: make the first tab, in the background — on the page the
  // launch is for, when there is one, so the first window does not show a blank page first.
  const firstTargetId = await ensureBackgroundTab(browser, firstUrl);
  // Launch-time only: an ADOPTED browser keeps its position (the user may have revealed it).
  if (offscreen) await parkWindowOffscreen(browser);
  else await unparkWindow(browser);
  await publishEndpoint(profileDir, port, child.pid ?? null, cfg);
  return { browser, cdpUrl, profileDir, ...(firstTargetId ? { firstTargetId } : {}) };
}
