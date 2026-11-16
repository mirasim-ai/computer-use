/**
 * What screenshots leave in the temp directory — `node scripts/test.mjs shot-files`.
 *
 * A screenshot taken without a `path` lands in a per-process directory under the OS temp dir,
 * and only the last 200 stay. Two things used to pile up there: a session that drove a browser
 * and a desktop app wrote .jpg and .png side by side and the rolling delete looked for the old
 * shot under the new shot's extension, so nothing was ever removed; and no process ever removed
 * the directory of one that had exited.
 *
 * Hermetic: the temp dir is a scratch directory, and no surface is driven.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "cu-shot-files-"));
// Before the module computes a path: os.tmpdir() reads these on every call.
process.env.TMPDIR = scratch;
process.env.TEMP = scratch;
process.env.TMP = scratch;
const { saveShot } = await import("../src/platform/tools/shot-file.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const HOUR = 60 * 60 * 1000;
const root = join(tmpdir(), "mirasim-computer-use-shots");
const shot = Buffer.from("not really an image").toString("base64");

/** A directory as another process would have left it, last added to `ageMs` ago. */
function leftBy(name: string, ageMs: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "0001.jpg"), "x");
  const at = new Date(Date.now() - ageMs);
  utimesSync(dir, at, at);
  return dir;
}

try {
  // A process that has exited: its id is free (or, at worst, reused by something short-lived).
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  const second = spawnSync(process.execPath, ["-e", ""]).pid;

  const goneOld = leftBy(String(exited), 30 * HOUR);
  const goneFresh = leftBy(String(second), 1 * HOUR);
  const liveOld = leftBy(String(process.ppid), 30 * HOUR);
  const foreign = leftBy("not-a-pid", 30 * 24 * HOUR);
  const mine = join(root, String(process.pid));
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "0300.jpg"), "left by an earlier process with this id");

  const first = saveShot(shot, "image/jpeg");
  check("the first shot lands in this process's directory", first.path === join(mine, "0001.jpg"), first.path);
  check("...which no longer holds what an earlier process with the same id left", !existsSync(join(mine, "0300.jpg")));
  check("a directory whose process is gone, untouched for a day, is removed", !existsSync(goneOld));
  check("...one from the last hour is kept: its paths may still be in a conversation", existsSync(goneFresh));
  check("...and so is an old one whose process is still running", existsSync(liveOld));
  check("a name that is not a process id is not ours to remove", existsSync(foreign));

  // A long-running process under a reused id must not hold a directory forever.
  const reused = leftBy(String(process.ppid), 8 * 24 * HOUR);
  // The sweep runs once per process, before its first shot — so ask a second process.
  const swept = spawnSync(process.execPath, ["--import", "tsx", "-e",
    `const { saveShot } = await import(${JSON.stringify(new URL("../src/platform/tools/shot-file.ts", import.meta.url).href)});` +
    `saveShot(${JSON.stringify(shot)}, "image/png");`,
  ], { env: process.env, encoding: "utf8" });
  check("a directory untouched for a week goes whoever holds its id now", swept.status === 0 && !existsSync(reused), swept.stderr.trim().split("\n").pop());
  check("...and the other process's sweep leaves this running process's shots alone", existsSync(first.path));

  // Rolling, across formats: 150 browser shots, then 100 of a desktop app.
  for (let i = 1; i < 150; i++) saveShot(shot, "image/jpeg");
  for (let i = 0; i < 100; i++) saveShot(shot, "image/png");
  const left = readdirSync(mine).sort();
  check("only the last 200 shots stay when .jpg and .png are mixed", left.length === 200, `${left.length} files`);
  check("...the oldest are the ones that went", left[0] === "0051.jpg" && left[left.length - 1] === "0250.png", `${left[0]} … ${left[left.length - 1]}`);

  const keep = join(scratch, "kept-by-the-caller.png");
  saveShot(shot, "image/png", keep);
  for (let i = 0; i < 5; i++) saveShot(shot, "image/png");
  check("a shot saved to the caller's own path is never rolled away", existsSync(keep) && readdirSync(mine).length === 200);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
