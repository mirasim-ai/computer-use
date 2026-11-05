/**
 * An app NAME to the bundle ids installed under it — the resolution `computer.surface('TextEdit')`
 * needs for an app that is not running. A running app is found through the listing (its title
 * carries both its name and its bundle id); a quit one is listed only once cleared, so before this a
 * quit app answered to its bundle id alone, while the reference promises "bundle id or app name".
 *
 * Two names reach a user's lips, and they differ on a non-English Mac: the bundle's file name
 * (`TextEdit.app`, what English docs and models say) and the localized display name (`文本编辑`,
 * what the user sees). The file name is a directory scan of the usual app folders; the display
 * name is Spotlight's `kMDItemDisplayName`, which is localized for the user's language. Either
 * path may come back empty (Spotlight off, an app in an odd folder); then the name resolves to
 * nothing, which is the old behaviour — never an error.
 *
 * Here and not in the Swift helper: a host may pin an older prebuilt helper
 * (`COMPUTER_USE_MACOS_AX_BIN`) that knows no such op.
 */

import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bundle ids installed under this name, best match first; empty when none. */
export type AppNameResolver = (name: string) => Promise<string[]>;

/** Where apps live, in the order a duplicate name is settled (the user's own install first). */
const APP_DIRS = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
  join(homedir(), "Applications"),
  // Finder and the other always-there system apps, whose display name Spotlight localizes.
  "/System/Library/CoreServices",
];

const TIMEOUT_MS = 3_000;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, encoding: "utf8" }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

async function bundleIdOf(appPath: string): Promise<string | null> {
  const id = (await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(appPath, "Contents", "Info.plist")])).trim();
  return id || null;
}

/** `TextEdit` and `TextEdit.app` name the same bundle, in any case. */
function bare(name: string): string {
  return name.trim().replace(/\.app$/i, "").toLowerCase();
}

function byFileName(name: string): string[] {
  const want = bare(name);
  const out: string[] = [];
  for (const dir of APP_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) if (/\.app$/i.test(e) && bare(e) === want) out.push(join(dir, e));
  }
  return out;
}

async function byDisplayName(name: string): Promise<string[]> {
  // Spotlight's query language quotes with "…"; a name carrying one cannot be expressed, and is
  // not an app name anyone types.
  const n = name.trim().replace(/\.app$/i, "");
  if (!n || /["\\*]/.test(n)) return [];
  const q = `kMDItemContentType == "com.apple.application-bundle" && (kMDItemDisplayName == "${n}"cd || kMDItemDisplayName == "${n}.app"cd)`;
  return (await run("/usr/bin/mdfind", [q])).split("\n").map((l) => l.trim()).filter(Boolean);
}

export const findInstalledApps: AppNameResolver = async (name) => {
  if (process.platform !== "darwin" || !name.trim()) return [];
  let paths = byFileName(name);
  if (!paths.length) paths = await byDisplayName(name);
  const ids: string[] = [];
  for (const p of paths) {
    const id = await bundleIdOf(p);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};
