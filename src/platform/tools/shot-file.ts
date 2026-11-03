/**
 * shot-file.ts — where a screenshot lands on disk, so a script can keep it.
 *
 * Every shot is written to a file and its path returned: the caller's `path` when given, else a
 * rolling per-process directory under the OS temp dir. The path is on the machine computer-use
 * runs on, which for a remote host is not the caller's filesystem — hence the answer names the
 * host.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";

/** How many default-directory shots are kept; older ones are deleted as new ones land. */
const SHOTS_KEEP = 200;

const EXT: Record<string, string[]> = { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"] };

let seq = 0;
const defaultDir = () => join(tmpdir(), "mirasim-computer-use-shots", String(process.pid));

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
    seq += 1;
    file = join(defaultDir(), `${String(seq).padStart(4, "0")}${EXT[mimeType]?.[0] ?? ".img"}`);
    // Rolling: the shot SHOTS_KEEP numbers back goes as this one lands.
    if (seq > SHOTS_KEEP) {
      try { unlinkSync(join(defaultDir(), `${String(seq - SHOTS_KEEP).padStart(4, "0")}${EXT[mimeType]?.[0] ?? ".img"}`)); } catch { /* already gone */ }
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  // `wx`: the existence check above races nothing if the write itself refuses to replace.
  writeFileSync(file, buf, { flag: path ? "wx" : "w" });
  return { path: file, host: hostname(), ...(imageSize(buf, mimeType) ?? {}) };
}
