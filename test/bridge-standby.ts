/**
 * Two browsers with the extension: the parked one stays parked, and a hiccup keeps the active one —
 * `node scripts/test.mjs bridge-standby`.
 *
 * With two browsers (two Chrome profiles, or Chrome beside Edge) the bridge drives one and PARKS the
 * other: keeps its line open and ignores it (server.ts `attachExtension`). The extension calls a line
 * that says nothing for three keepalive pings dead and redials it (relay.js `SILENCE_TIMEOUT_MS`), so a
 * parked line that heard nothing redialled every minute, and each redial asked the active browser
 * to answer within seconds or lose the bridge. After a computer woke from sleep every line had been
 * quiet past that limit, both browsers redialled at once, and the first to arrive kept the bridge:
 * measured with two real Chrome 158, the bridge moved to the other browser after the second of four
 * simulated sleeps and stayed there.
 *
 * Hermetic: the REAL bridge and its native-messaging socket, scripted extensions on the other end.
 */

import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeServer } from "../src/platform/browser/bridge/server.ts";
import { BROWSER_TO_HOST_MAX, encodeFrame, FrameDecoder } from "../src/platform/browser/bridge/native-frames.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) { if (what()) return true; await sleep(20); }
  return what();
}

const RUNTIME = { id: "khflooofmndpmafhofjdcpjfgnlpikhg", version: "0.1.5", build: null, protocol: 1, capabilities: ["discarded-tabs", "safe-reload"] };

/** One browser's extension on the native socket: it says which browser session it is and answers
 *  what the bridge asks. `active` turns true when the bridge treats it as THE line (`bridge.info` is
 *  sent to that one only); `mute` stops it answering pings. */
class FakeExtension {
  active = false;
  pings = 0;
  closed = false;
  mute = false;
  private socket: net.Socket | null = null;

  constructor(readonly name: string, private readonly session: string | null) {}

  async connect(socketPath: string): Promise<this> {
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    this.socket = socket;
    const decoder = new FrameDecoder(BROWSER_TO_HOST_MAX);
    socket.on("data", (chunk: Buffer) => { for (const frame of decoder.push(chunk)) this.onCommand(JSON.parse(frame)); });
    socket.on("close", () => { this.closed = true; });
    socket.on("error", () => {});
    this.write({ method: "extension.connected", params: this.session ? [this.session] : [] });
    this.write({ method: "extension.initialized", params: [RUNTIME] });
    return this;
  }

  drop(): void { this.socket?.destroy(); }

  private write(message: unknown): void {
    if (!this.socket?.destroyed) this.socket?.write(encodeFrame(JSON.stringify(message), BROWSER_TO_HOST_MAX));
  }

  private onCommand(message: { id: number; method: string }): void {
    const { id, method } = message;
    if (method === "bridge.ping") {
      this.pings += 1;
      if (!this.mute) this.write({ id, result: {} });
      return;
    }
    if (method === "bridge.info") this.active = true;
    this.write({ id, result: method === "chrome.tabs.query" || method === "chrome.debugger.getTargets" ? [] : {} });
  }
}

async function main() {
  const socketPath = join(tmpdir(), `cu-standby-${process.pid}.sock`);
  const server = new BridgeServer({ port: 0, socketPath });
  await server.start();
  const status = async () => (await (await fetch(`${server.cdpUrl()}/status`)).json()) as { extensionConnected: boolean; standbyBrowsers: number };
  try {
    // ── One active, one parked ─────────────────────────────────────────────────────────────
    const a = await new FakeExtension("A", "session-A").connect(socketPath);
    check("the first browser's line becomes the active one", await until(() => a.active, 3000));
    const b = await new FakeExtension("B", "session-B").connect(socketPath);
    await sleep(300);
    check("another browser's line, while the active one answers, is parked", !b.active && (await status()).standbyBrowsers === 1,
      JSON.stringify(await status()));

    // The extension redials a line that stays silent for three keepalive pings (60 s).
    const heard = await until(() => b.pings > 0, 22_000);
    check("the parked line hears the keepalive pings too, so its extension does not call it dead and redial", heard && !b.closed && !b.active,
      `pings=${b.pings} closed=${b.closed}`);
    check("...and the active line keeps the bridge", a.active && !a.closed);

    // ── A hiccup: every line dropped, the parked browser redials first ────────────────────
    a.drop();
    b.drop();
    const b2 = await new FakeExtension("B", "session-B").connect(socketPath);
    await sleep(300);
    const a2 = await new FakeExtension("A", "session-A").connect(socketPath);
    check("after every line dropped, the browser that had the bridge takes it back though another redialled first",
      await until(() => a2.active, 3000) && !b2.active, `A active=${a2.active}, B active=${b2.active}`);
    await sleep(200);
    check("...and the other one is parked again", (await status()).standbyBrowsers === 1);

    // ── The active browser does not come back: the parked one is let in after the grace ───
    a2.drop();
    check("the active browser gone for good, the parked line is released after the grace", await until(() => b2.closed, 8000));
    const b3 = await new FakeExtension("B", "session-B").connect(socketPath);
    check("...and its redial is taken at once", await until(() => b3.active, 3000));

    // ── Unchanged: an active line that stops answering is taken over ──────────────────────
    b3.mute = true;
    const c = await new FakeExtension("C", "session-C").connect(socketPath);
    check("another browser takes over an active line that no longer answers", await until(() => c.active, 8000) && await until(() => b3.closed, 2000),
      `C active=${c.active}, B closed=${b3.closed}`);

    // ── Unchanged: an extension too old to name its session is not told apart, so not waited for ─
    c.drop();
    await sleep(100);
    const old = await new FakeExtension("old", null).connect(socketPath);
    check("an extension that names no session is taken at once, even inside the grace", await until(() => old.active, 3000));
    old.drop();
  } finally {
    server.stop();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall bridge-standby checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
