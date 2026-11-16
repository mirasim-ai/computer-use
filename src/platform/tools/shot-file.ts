/**
 * shot-file.ts — where a screenshot lands on disk, so a script can keep it.
 *
 * Every shot is written to a file and its path returned: the caller's `path` when given, else a
 * rolling per-process directory under the OS temp dir. The path is on the machine computer-use
 * runs on, which for a remote host is not the caller's filesystem — hence the answer names the
 * host.
 *
 * A process does not delete its directory when it exits: a host retires an idle process within
 * minutes, and the paths it answered with are still in the conversation, to be read or handed
 * on. What it leaves is cleared a day later by whichever process takes a shot next.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";

/** How many default-directory shots are kept; older ones are deleted as new ones land. */
const SHOTS_KEEP = 200;
/** A directory whose process is gone is removed once nothing has been added to it for this long. */
const LEFT_BEHIND_MS = 24 * 60 * 60 * 1000;
/** ...and one untouched for this long goes whoever holds its process id now: ids are reused, and
 *  an unrelated program under the same number must not keep a directory forever. */
const ABANDONED_MS = 7 * 24 * 60 * 60 * 1000;

const EXT: Record<string, string[]> = { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"] };

let seq = 0;
/** The default-directory files this process still has on disk, oldest first. */
const kept: string[] = [];
const shotsRoot = () => join(tmpdir(), "mirasim-computer-use-shots");
const defaultDir = () => join(shotsRoot(), String(process.pid));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Before this process's first default-directory shot: empty its own directory (an earlier process
 * that had the same id left files this one would never count), and remove the directories of
 * processes that are gone. Best effort — a directory that cannot be read or removed is left.
 */
function clearLeftBehind(): void {
  const root = shotsRoot();
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const dir = join(root, name);
    try {
      const pid = Number(name);
      const idle = now - statSync(dir).mtimeMs;
      const gone = pid === process.pid || idle > ABANDONED_MS || (idle > LEFT_BEHIND_MS && !alive(pid));
      if (gone) rmSync(dir, { recursive: true, force: true });
    } catch { /* someone else's, or already removed */ }
  }
}

/**
 * Refuse a caller path BEFORE anything is captured: relative, the wrong extension for this
 * platform's format, or an existing file. Refusing to overwrite is the point — a mistyped path
 * must fail, not replace a file the user had.
 */
export function checkShotPath(path: string, mimeType: string): void {
  if (!isAbsolute(path)) throw new Error(`screenshot path must be absolute, got "${path}"`);
  const allowed = EXT[mimeType] ?? [];
  if (!allowed.includes(extname(path).toLowerCase())) {
    throw new Error(`this surface's screenshots are ${mimeType} — the path must end in ${allowed.join(" or ")}`);
  }
  if (existsSync(path)) throw new Error(`${path} already exists — screenshots never overwrite; pick a new name`);
}

/** Pixel size read from the file's own header (JPEG SOF, PNG IHDR); null when unreadable. */
function imageSize(buf: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === "image/png" && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const m = buf[i + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** Write one captured image and say where it went. */
export function saveShot(data: string, mimeType: string, path?: string): { path: string; host: string; width?: number; height?: number } {
  const buf = Buffer.from(data, "base64");
  let file = path;
  if (!file) {
    if (seq === 0) clearLeftBehind();
    seq += 1;
    file = join(defaultDir(), `${String(seq).padStart(4, "0")}${EXT[mimeType]?.[0] ?? ".img"}`);
    // Rolling: the oldest goes as this one lands. By the name it was written under — a session
    // that drives a browser and a desktop app writes .jpg and .png into the same directory.
    kept.push(file);
    if (kept.length > SHOTS_KEEP) {
      try { unlinkSync(kept.shift()!); } catch { /* already gone */ }
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  // `wx`: the existence check above races nothing if the write itself refuses to replace.
  writeFileSync(file, buf, { flag: path ? "wx" : "w" });
  return { path: file, host: hostname(), ...(imageSize(buf, mimeType) ?? {}) };
}
