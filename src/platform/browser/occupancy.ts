/**
 * One question: **which browser process holds this profile directory, and how do we make it
 * let go.**
 *
 * OS knowledge only — process tables, command-line quoting, signals — consumed by `acquire.ts`'s
 * adopt-or-launch ladder, whose platform variance lives entirely in these two functions. Nothing
 * here knows Chrome's profile LAYOUT: the directory to look for is passed in.
 */

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pids of browser processes whose `--user-data-dir` is exactly ours. The profile directory is
 * the only identity that survives a restart of THIS process (the child handle is gone whenever
 * we adopted). Renderer/GPU helpers (`--type=`) are skipped — signalling them is a storm.
 *
 * Every recovery in `acquire.ts` hangs off this primitive: a platform where it wrongly answers
 * `[]` deletes `DevToolsActivePort` under a live Chrome and can never recover the squatter.
 */
export async function browserPids(profileDir: string): Promise<number[]> {
  return pidsHoldingProfile(await processListing(), profileDir);
}

/**
 * Windows' only route to a process's command line: `tasklist` lacks it and `wmic` is gone, so
 * PowerShell's CIM, filtered to browser images.
 */
const WIN_PROCESS_LIST = [
  "Get-CimInstance Win32_Process",
  `-Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='chromium.exe'"`,
  '| ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
].join(" ");

/**
 * The PowerShell to run CIM through: in-box `powershell.exe`, then PATH. A PowerShell-7-only
 * machine has no `powershell.exe`, and an ENOENT reads as "nothing holds the profile".
 */
function windowsPowerShell(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const inBox = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (existsSync(inBox)) return inBox;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of ["powershell.exe", "pwsh.exe"]) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return "powershell.exe";
}

/** One `<pid> <command line>` line per candidate browser process; "" when it cannot be read. */
async function processListing(): Promise<string> {
  const win = process.platform === "win32";
  const file = win ? windowsPowerShell() : "ps";
  const args = win
    ? ["-NoProfile", "-NonInteractive", "-Command", WIN_PROCESS_LIST]
    : ["ax", "-o", "pid=,command="];
  return await new Promise<string>((resolve) => {
    execFile(
      file,
      args,
      // PowerShell's startup dominates the CIM query (~3.5 s), hence the wider deadline;
      // windowsHide so no console flashes over the user's screen.
      { timeout: win ? 20_000 : 4000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, out) => resolve(err ? "" : out),
    );
  });
}

/**
 * The matcher, pure: which listed pids name exactly this `--user-data-dir`. On Windows, quotes
 * (around the whole flag or just its value) are dropped and case is folded, since Chrome may
 * echo a different case than it was spawned with.
 *
 * The match must end at whitespace or end-of-line: `…/chrome` must not match `…/chrome-2`, since
 * a false positive is a SIGTERM to a browser that is not ours.
 *
 * Another spelling of the same directory (e.g. via a symlink) still holds it, so a path that
 * resolves to the same real directory is accepted. It is read up to the next ` --` flag (paths
 * may contain spaces); a misread one resolves nowhere and matches nothing.
 */
function pidsHoldingProfile(listing: string, profileDir: string, sameDir = sameDirectoryAs(profileDir)): number[] {
  const fold = process.platform === "win32";
  const needle = `--user-data-dir=${fold ? profileDir.toLowerCase() : profileDir}`;
  const pids: number[] = [];
  for (const raw of listing.split("\n")) {
    const line = raw.replace(/"/g, "");
    const hay = fold ? line.toLowerCase() : line;
    if (/--type=/.test(hay)) continue;
    const at = hay.indexOf(needle);
    const after = at < 0 ? undefined : hay[at + needle.length];
    const exact = at >= 0 && (after === undefined || /\s/.test(after));
    if (!exact) {
      const named = /--user-data-dir=(.+?)(?=\s+--|\s*$)/.exec(line)?.[1];
      if (!named || !sameDir(named)) continue;
    }
    const pid = Number.parseInt(raw.trim().split(/\s+/)[0] ?? "", 10);
    if (Number.isInteger(pid) && pid > 1) pids.push(pid);
  }
  return pids;
}

/** Whether a path names the same real directory as `dir` (false when either does not exist). */
function sameDirectoryAs(dir: string): (path: string) => boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  let real: string;
  try { real = fold(realpathSync(dir)); } catch { return () => false; }
  return (path) => {
    try { return fold(realpathSync(path)) === real; } catch { return false; }
  };
}

/**
 * Last-resort teardown by identity: SIGTERM, a beat to die, SIGKILL any survivor.
 *
 * On Windows Node maps both signals onto `TerminateProcess`, so the browser dies without
 * flushing — acceptable only here, where it holds the profile and nobody can talk to it.
 */
export async function killByProfileDir(profileDir: string): Promise<void> {
  const pids = await browserPids(profileDir);
  if (!pids.length) return;
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await sleep(300);
  for (const pid of pids) {
    try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* gone — the good case */ }
  }
}
