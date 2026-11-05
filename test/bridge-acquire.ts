/**
 * Finding the bridge to the user's own browser — `node scripts/test.mjs bridge-acquire`.
 *
 * Hermetic: two fake bridges answer `/status` over HTTP, and a native-host record in the scratch
 * HOME names one of them as another program's. No browser, no extension.
 *
 *   · a bridge waiting for the extension stops waiting once another program's bridge holds it,
 *     instead of sitting out the whole first-connect wait (~35 s) for an answer it already has.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionHeldElsewhere, waitForExtension } from "../src/platform/browser/bridge/acquire-bridge.ts";
import { NATIVE_HOST_NAME } from "../src/platform/browser/bridge/native-host.ts";
import { sharedHome } from "../src/platform/home.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A bridge that answers `/status` the way the real one does (bridge/server.ts). */
function fakeBridge(state: { connected: boolean }): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/status" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ extensionConnected: state.connected }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${port}`, server });
  }));
}

async function main() {
  // A Windows pipe name says nothing about where its record lives, so there is no "elsewhere".
  if (process.platform === "win32") {
    console.log("skipped: the owner of the extension is not looked up on Windows");
    process.exit(0);
  }
  const theirs = { connected: true };
  const other = await fakeBridge(theirs);
  const mine = await fakeBridge({ connected: false });
  try {
    // Another program (mirasim) has its own home, bridge record and native-host entry.
    const otherHome = mkdtempSync(join(tmpdir(), "cu-other-home-"));
    writeFileSync(join(otherHome, "bridge.json"), JSON.stringify({ cdpUrl: other.url, pid: process.pid }));
    const hosts = join(sharedHome(), "native-host", NATIVE_HOST_NAME, "hosts");
    mkdirSync(hosts, { recursive: true });
    writeFileSync(join(hosts, "mirasim.json"), JSON.stringify({ owner: "mirasim", command: ["/bin/true"], socket: join(otherHome, "bridge.sock"), priority: 10 }));
    const myHome = mkdtempSync(join(tmpdir(), "cu-my-home-"));

    check("the other program's bridge is found holding the extension", (await extensionHeldElsewhere(myHome)) === "mirasim");

    let started = Date.now();
    const got = await waitForExtension(mine.url, 35_000, myHome);
    const waited = Date.now() - started;
    check("a wait for the extension ends at once while another program's bridge holds it",
      got === false && waited < 3_000, `${got} after ${waited} ms`);

    // Once that program lets go, the wait is the deadline's again (nothing to report early).
    theirs.connected = false;
    started = Date.now();
    const timedOut = await waitForExtension(mine.url, 1_200, myHome);
    const full = Date.now() - started;
    check("…and with the extension free, the wait runs to its deadline", timedOut === false && full >= 1_200, `${timedOut} after ${full} ms`);
  } finally {
    other.server.close();
    mine.server.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall bridge-acquire checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
