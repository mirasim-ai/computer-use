/**
 * WHERE Chrome is, and what to say when it is nowhere: the per-platform search, the PATH scan,
 * and the one refusal a user can act on — the part of the `acquire.ts` ladder about the MACHINE
 * rather than a running browser.
 */


import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { browserConfigFromEnv, type BrowserConfig } from "./config.ts";
import { msgChromeMissing } from "./messages.ts";
/**
 * Is the profile the USER'S OWN browser (a host pointed `COMPUTER_USE_PROFILE_DIR` at their real
 * Chrome data) rather than our disposable device? With this set:
 *
 *  - we NEVER kill by profile dir (that SIGTERM would land on the browser they are using);
 *  - a launch we perform leaves its window visible; only the agent's own window is parked;
 *  - an unusable endpoint is an error, not something to clear away and replace.
 *
 * Set by the host, never inferred ({@link BrowserConfig.attached}).
 */
export function isAttachedProfile(cfg: BrowserConfig = browserConfigFromEnv()): boolean {
  return cfg.attached;
}

/**
 * Is this launch one Chromium would refuse outright — root on Linux?
 *
 * Chromium aborts as root without `--no-sandbox` (crbug.com/638180), and no sandbox mechanism
 * rescues it: the root check runs before the setuid helper or user namespaces get a say.
 *
 * Rule: keep the sandbox everywhere it works; spend `--no-sandbox` only where the alternative is
 * not starting. Scoped to Linux+root, never to "unattended", so a user's own Chrome keeps its
 * sandbox. `uid` is injectable for tests (`process.getuid` is absent on Windows).
 */
export function needsNoSandbox(
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): boolean {
  return platform === "linux" && uid === 0;
}

/**
 * Is /dev/shm too small for Chromium to keep its shared memory there?
 *
 * A container's /dev/shm defaults to 64 MB (Docker and Kubernetes), and a heavy page outgrows it
 * and crashes the tab ("Aw, Snap!"). The gated `--disable-dev-shm-usage` moves that memory to
 * /tmp, invisibly to pages; a desktop with a normal tmpfs keeps Chrome's default. `bytes` is
 * injectable for tests (null = unknown, which keeps the default).
 */
export function needsShmFallback(
  platform: NodeJS.Platform = process.platform,
  bytes: number | null = platform === "linux" ? shmBytes() : null,
): boolean {
  return platform === "linux" && bytes !== null && bytes < 512 * 1024 * 1024;
}

function shmBytes(): number | null {
  try {
    const s = statfsSync("/dev/shm");
    return s.blocks * s.bsize;
  } catch {
    return null;
  }
}

/** Chrome binary: the config's explicit path, then platform install paths, then PATH names. */
export function findChrome(cfg: BrowserConfig = browserConfigFromEnv()): string | null {
  const explicit = cfg.chromePath;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? windowsCandidates()
        : ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const p of candidates) if (existsSync(p)) return p;
  const pathNames =
    process.platform === "win32"
      ? ["chrome.exe", "chromium.exe"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of pathNames) {
      const p = join(dir, name);
      if (dir && existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Windows install roots: 64-bit, 32-bit, and the PER-USER copy under `%LOCALAPPDATA%` — what
 * Chrome's installer picks without admin rights, common on managed work laptops.
 *
 * Roots come from the environment; the hardcoded pair stays last for a stripped environment (a
 * service with no Program Files variables). A host-side browser picker must use the same roots
 * and relative paths, or it offers a browser that is then reported missing at launch.
 */
function windowsCandidates(): string[] {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
  const relative = ["Google/Chrome/Application/chrome.exe", "Chromium/Application/chrome.exe"];
  return [
    ...roots.flatMap((root) => (root ? relative.map((rel) => join(root, rel)) : [])),
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];
}

function installHint(): string {
  if (process.platform === "darwin") return "brew install --cask google-chrome";
  if (process.platform === "win32") return "download it from https://www.google.com/chrome/";
  return "e.g. apt install chromium, or the vendor .deb from google.com/chrome";
}

/** The user-facing dead end when no browser can be started (wording in messages.ts). Also
 *  reported verbatim by `mirasim-cu setup browser`. */
export function chromeMissingError(): Error {
  return new Error(msgChromeMissing(installHint()));
}
