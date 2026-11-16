/**
 * A bridge nobody supervises ends itself — `node scripts/test.mjs bridge-idle-exit`.
 *
 * A session that asks for the user's own browser without a host starts the bridge detached, so
 * the next session finds the same one. Nothing ever stopped it: after the browser and every
 * session had gone, a `mirasim-cu bridge` process stayed for good. Started with `--idle-exit`,
 * it now exits once it has had no extension on its line and no session for that long, and
 * removes its record so the next session does not ask a dead endpoint first.
 *
 * Hermetic: the real `bridge` command in a scratch home, a WebSocket standing in for the
 * extension. No browser.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { forgetBridge } from "../src/platform/browser/bridge/acquire-bridge.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Started { child: ChildProcess; cdpUrl: string | null; exited: Promise<number | null>; home: string }

/** The real command, as a session starts it (minus the native-host record), in its own home. */
async function startBridge(extra: string[]): Promise<Started> {
  const home = mkdtempSync(join(tmpdir(), "cu-bridge-idle-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/entries/cli.ts", "bridge", "--json", "--port", "0", ...extra],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, COMPUTER_USE_HOME: home } });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const hello = await new Promise<{ cdpUrl?: string } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 20_000);
    createInterface({ input: child.stdout! }).once("line", (line) => { clearTimeout(timer); try { resolve(JSON.parse(line)); } catch { resolve(null); } });
    void exited.then(() => { clearTimeout(timer); resolve(null); });
  });
  const cdpUrl = hello?.cdpUrl ?? null;
  // What the session that started it writes next to it (acquire-bridge.ts).
  if (cdpUrl) writeFileSync(join(home, "bridge.json"), JSON.stringify({ cdpUrl, pid: child.pid }));
  return { child, cdpUrl, exited, home };
}

async function main() {
  const IDLE_S = 2;
  const [own, supervised] = await Promise.all([startBridge(["--idle-exit", String(IDLE_S)]), startBridge([])]);
  try {
    check("a bridge started with an idle limit comes up", own.cdpUrl !== null);
    if (!own.cdpUrl || !supervised.cdpUrl) throw new Error("a bridge did not start");

    // An extension on the line: `<cdpUrl>` is http://127.0.0.1:<port>/<uuid>.
    const { host, pathname } = new URL(own.cdpUrl);
    const extension = new WebSocket(`ws://${host}/extension${pathname}`);
    await new Promise<void>((resolve, reject) => { extension.once("open", () => resolve()); extension.once("error", reject); });
    const whileConnected = await Promise.race([own.exited, sleep(IDLE_S * 2500).then(() => "running" as const)]);
    check("with an extension on its line it stays, however long", whileConnected === "running", String(whileConnected));

    // The extension goes; a session asks once more on its way (as acquire-bridge does), then nothing.
    extension.close();
    await sleep(IDLE_S * 500);
    const asked = await fetch(`${own.cdpUrl}/status`).then((r) => r.ok, () => false);
    const afterAsking = Date.now();
    const early = await Promise.race([own.exited, sleep(IDLE_S * 700).then(() => "running" as const)]);
    check("a session that has just asked finds it still there", asked && early === "running", String(early));
    const code = await Promise.race([own.exited, sleep(IDLE_S * 4000).then(() => "still running" as const)]);
    check("with nobody left for the whole limit it exits cleanly", code === 0, `exit ${code}, ${Date.now() - afterAsking} ms after the last request`);
    check("...and takes its record with it", !existsSync(join(own.home, "bridge.json")));

    check("a bridge started without the limit (a supervised one) is still running, unused all along",
      supervised.child.exitCode === null && await fetch(`${supervised.cdpUrl}/status`).then((r) => r.ok, () => false));

    // The record is removed only when it names the bridge that is leaving.
    const record = join(supervised.home, "bridge.json");
    forgetBridge(supervised.home, "http://127.0.0.1:1/another-bridge");
    check("a record naming another bridge is not removed", existsSync(record) && JSON.parse(readFileSync(record, "utf8")).cdpUrl === supervised.cdpUrl);
    forgetBridge(supervised.home, supervised.cdpUrl);
    check("...and one naming this bridge is", !existsSync(record));
  } finally {
    for (const b of [own, supervised]) {
      if (b.child.exitCode === null) b.child.kill("SIGKILL");
      rmSync(b.home, { recursive: true, force: true });
    }
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall bridge-idle-exit checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
