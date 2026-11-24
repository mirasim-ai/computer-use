/**
 * What a bridge says about itself, and stopping it over HTTP — `node scripts/test.mjs bridge-status`.
 *
 * A bridge outlives the sessions that use it, and one machine can hold several builds of its host
 * (an installed app beside a preview): the one started first is found by the others and used as
 * it is. `GET /status` therefore says which version the bridge is, how many clients are on it and
 * whether a command is in flight, and `POST /shutdown` lets the host that found an older, idle one
 * ask it to make way — instead of taking its socket from under it.
 *
 * Hermetic: the real server with no extension and no browser, then the real `bridge` command
 * with neither a socket nor a native-host record.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { BridgeServer } from "../src/platform/browser/bridge/server.ts";
import { MINIMUM_EXTENSION_VERSION } from "../src/platform/browser/bridge/extension-updates.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = async (cdpUrl: string) => (await (await fetch(`${cdpUrl}/status`)).json()) as { version?: unknown; clients?: unknown; busy?: unknown; extensionConnected?: unknown; extension?: { expectedVersion?: unknown } };

async function main() {
  // ── The server ───────────────────────────────────────────────────────────────────────────
  let asked = 0;
  const server = new BridgeServer({ port: 0, version: "9.8.7-test", onShutdown: () => { asked += 1; } });
  await server.start();
  try {
    const first = await status(server.cdpUrl());
    check("status names the bridge's version", first.version === "9.8.7-test", JSON.stringify(first.version));
    check("...and reports no client and nothing in flight on an idle bridge", first.clients === 0 && first.busy === false && first.extensionConnected === false,
      JSON.stringify({ clients: first.clients, busy: first.busy }));
    // T-4050: the bundled manifest's version is what a release submits to the store, not what users must have.
    check("status asks for the minimum extension version, not the bundled one", first.extension?.expectedVersion === MINIMUM_EXTENSION_VERSION,
      JSON.stringify(first.extension));

    const fromPage = await fetch(`${server.cdpUrl()}/shutdown`, { method: "POST", headers: { Origin: "https://example.com" } });
    check("a shutdown request from a page is refused, and stops nothing", fromPage.status === 403 && asked === 0, `HTTP ${fromPage.status}`);
    const fromHost = await fetch(`${server.cdpUrl()}/shutdown`, { method: "POST" });
    await sleep(100);
    check("a shutdown request from the local host is accepted and passed on", fromHost.status === 202 && asked === 1, `HTTP ${fromHost.status}, asked ${asked}`);
    const wrongVerb = await fetch(`${server.cdpUrl()}/shutdown`);
    check("only POST stops a bridge", wrongVerb.status !== 202 && asked === 1, `GET → HTTP ${wrongVerb.status}`);
  } finally {
    server.stop();
  }

  const embedded = new BridgeServer({ port: 0 });
  await embedded.start();
  try {
    const refused = await fetch(`${embedded.cdpUrl()}/shutdown`, { method: "POST" });
    check("a bridge with nothing to stop it refuses the request", refused.status === 404, `HTTP ${refused.status}`);
    check("...and reports no version rather than a wrong one", (await status(embedded.cdpUrl())).version === null);
  } finally {
    embedded.stop();
  }

  // ── The command ──────────────────────────────────────────────────────────────────────────
  const own = String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  const child = spawn(process.execPath, ["--import", "tsx", "src/entries/cli.ts", "bridge", "--json", "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  try {
    const hello = await new Promise<{ version?: string; cdpUrl?: string } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 20_000);
      createInterface({ input: child.stdout }).once("line", (line) => { clearTimeout(timer); try { resolve(JSON.parse(line)); } catch { resolve(null); } });
    });
    check("the bridge command's status line carries this package's version", hello?.version === own, JSON.stringify(hello?.version));
    if (hello?.cdpUrl) {
      check("...and so does its /status", (await status(hello.cdpUrl)).version === own);
      const started = Date.now();
      const res = await fetch(`${hello.cdpUrl}/shutdown`, { method: "POST" });
      const code = await Promise.race([exited, sleep(8000).then(() => "still running" as const)]);
      check("asked to shut down, the bridge process exits cleanly", res.status === 202 && code === 0, `HTTP ${res.status}, exit ${code} after ${Date.now() - started} ms`);
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall bridge-status checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
