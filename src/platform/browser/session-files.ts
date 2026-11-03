/**
 * The files a managed session PUBLISHES beside its profile: where its endpoint is, where its
 * actions are journaled, where its shots go, and which tab it claimed.
 *
 * Everything here exists so a SECOND process (the next session, a host, an observer) can find
 * what this one is driving without being told — hence each write is atomic and each read
 * tolerates a stale file.
 */


import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { browserConfigFromEnv, type BrowserConfig } from "./config.ts";
import { browserPids } from "./occupancy.ts";
import { computerUseHome } from "../home.ts";
export function endpointFileFor(profileDir: string, cfg: BrowserConfig = browserConfigFromEnv()): string {
  // A named-tab surface ({@link TabClaim}) publishes endpoint/journal/shots under its own run
  // slug, so per-surface previews work on a shared profile dir. The reveal flag deliberately
  // does NOT follow it ({@link revealFlagFor}).
  const slug = cfg.runSlug?.replace(/[^\w.-]+/g, "-")
    || basename(profileDir).replace(/[^\w.-]+/g, "-") || "default";
  return join(computerUseHome(), "run", slug, "endpoint.json");
}

/**
 * Where the driver journals its actions for observers, next to endpoint.json: one JSON line
 * per action (contract at the driver's `publishAction`). Best-effort, never load-bearing.
 */
export function actionsFileFor(profileDir: string, cfg: BrowserConfig = browserConfigFromEnv()): string {
  return join(dirname(endpointFileFor(profileDir, cfg)), "actions.jsonl");
}

/**
 * Where per-action screenshots land: `shots/<seq>.jpg`, `seq` increasing across sessions.
 * Rolling: only the newest COMPUTER_USE_SHOTS_KEEP (default 500) files are kept.
 */
export function shotsDirFor(profileDir: string, cfg: BrowserConfig = browserConfigFromEnv()): string {
  return join(dirname(endpointFileFor(profileDir, cfg)), "shots");
}

/** `knownPid` — the browser we just spawned, if we did. Otherwise read off the process table,
 *  except on Windows: ~3.5 s of PowerShell is not worth an observer-only field — publish null. */
export async function publishEndpoint(profileDir: string, port: number, knownPid: number | null, cfg: BrowserConfig): Promise<void> {
  try {
    const file = endpointFileFor(profileDir, cfg);
    mkdirSync(dirname(file), { recursive: true });
    const pid = knownPid ?? (process.platform === "win32" ? null : (await browserPids(profileDir))[0] ?? null);
    writeFileSync(
      file,
      JSON.stringify({
        cdpUrl: `http://127.0.0.1:${port}`, port, pid, profileDir,
        updatedAt: new Date().toISOString(),
      }, null, 2),
    );
  } catch {
    // Best-effort: the endpoint file is for observers; failing to write it must not fail the turn.
  }
}


/**
 * Merge this surface's TAB IDENTITY into its endpoint.json after every successful claim. For a
 * tab surface the endpoint is a SHARED browser, so a host closing it (the preview card's ×)
 * must close the target or dispose the isolated context — never `Browser.close`, which takes
 * every other surface down. Best-effort: failing to write must never fail the claim.
 */
export function publishTabIdentity(profileDir: string, tab: { key: string; isolated: boolean; ctxId: string; targetId: string }): void {
  try {
    const file = endpointFileFor(profileDir);
    const current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...current, tab }, null, 2));
  } catch {
    // No endpoint yet (attached/explicit surfaces publish none) — nothing to annotate.
  }
}
