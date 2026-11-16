/**
 * What downloads leave in staging — `node scripts/test.mjs download-staging`.
 *
 * Every browser a session connects to is told to save downloads into one machine-wide staging
 * directory. A download a script watched is moved out as it completes; one nobody watched stays
 * there under its GUID, and one cut short stays as a `.crdownload`. Nothing removed either, so
 * the directory only grew. Connecting to a browser now clears what has not been written to for
 * a day, and nothing younger: another session's download may still be running.
 *
 * Hermetic: the home is the run's scratch home, and the browser connected to does not exist.
 */

import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { browserArtifactsDir, connectBrowserCdp } from "../src/platform/browser/cdp-connection.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const HOUR = 60 * 60 * 1000;
const staging = browserArtifactsDir();
if (!homedir().startsWith(tmpdir())) {
  // Never age files in a real home: this suite belongs under scripts/test.mjs.
  console.log(`refusing to run against ${staging} — run it as \`node scripts/test.mjs download-staging\``);
  process.exit(1);
}

function staged(name: string, ageMs: number, dir = false): string {
  const file = join(staging, name);
  if (dir) mkdirSync(file, { recursive: true });
  else writeFileSync(file, "x");
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
  return file;
}

mkdirSync(staging, { recursive: true });
const finished = staged("051d3331-66f1-4f76-8d0a-01605ef27abc", 30 * HOUR);
const cutShort = staged("0e09885e-57f5-4b8e-9f96-6497afa5ad44.crdownload", 20 * 24 * HOUR);
const running = staged("13ee4a2e-9a21-49a5-8838-6f74a5e39d72.crdownload", 2 * HOUR);
const justDone = staged("2931cff0-bec0-4a14-b46f-be7e572411ba", 0);
const folder = staged("a-directory", 30 * 24 * HOUR, true);

// The connection itself is refused (nothing listens on port 1); the clearing comes before it.
const refused = await connectBrowserCdp("http://127.0.0.1:1", 3000).then(() => false, () => true);
check("connecting to a browser that is not there still fails", refused);
check("a finished download nobody collected for a day is removed", !existsSync(finished));
check("...and so is a download cut short weeks ago", !existsSync(cutShort));
check("a partial download written to two hours ago is kept: it may still be running", existsSync(running));
check("...and a download that has just finished is kept for the session that will collect it", existsSync(justDone));
check("a directory in staging is left alone", existsSync(folder));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
