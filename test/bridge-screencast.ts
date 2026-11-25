/**
 * A tab's one screencast, shared by the bridge's clients, and the frames a capture needs —
 * `node scripts/test.mjs bridge-screencast`.
 *
 * Chrome keeps one screencast per tab, and every client of the tab shares the extension's one
 * debugger session on it. A background tab captured with no screencast running hangs or comes back
 * at the previous capture's scale, so the bridge runs one of its own around such a capture
 * (bridge/screencasts.ts). Pinned here:
 *   · a capture with no screencast running is wrapped: start, first frame, capture, stop — and the
 *     bridge's own frames are acknowledged by it and delivered to no client;
 *   · a client's screencast (a preview) is left alone by another client's capture, its frames go to
 *     it alone, only its acknowledgements reach Chrome, and its stop ends it;
 *   · a frame of the bridge's own that arrives once a client reads (its start crossed frames already
 *     on the way) is still the bridge's: acknowledged by it, never shown as the client's picture.
 *
 * Hermetic: the REAL bridge (server, model, native-messaging socket), a scripted extension that
 * answers like Chrome and sends a frame after each screencast start, and raw CDP clients. No
 * browser, no extension.
 */

import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { BridgeServer } from "../src/platform/browser/bridge/server.ts";
import { BROWSER_TO_HOST_MAX, encodeFrame, FrameDecoder } from "../src/platform/browser/bridge/native-frames.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A frame as Chrome encodes it, header only: the pixel size is what the bridge reads of it. */
function png(width: number, height: number): string {
  const head = Buffer.alloc(33);
  head.writeUInt32BE(0x89504e47, 0); head.writeUInt32BE(0x0d0a1a0a, 4); head.writeUInt32BE(13, 8);
  head.write("IHDR", 12); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return head.toString("base64");
}
function jpeg(width: number, height: number): string {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]).toString("base64");
}
async function until(what: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) { if (what()) return true; await sleep(10); }
  return what();
}

/** The extension's end of the native socket, answering for one tab as Chrome would. */
class FakeExtension {
  /** The CDP commands the tab was sent, in order, with their params. */
  readonly seen: Array<{ method: string; params: any }> = [];
  private socket: net.Socket | null = null;
  private nextTab = 0;
  private frame = 0;

  constructor(private readonly socketPath: string) {}

  async connect(): Promise<void> {
    const socket = net.connect(this.socketPath);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    this.socket = socket;
    const decoder = new FrameDecoder(BROWSER_TO_HOST_MAX);
    socket.on("data", (chunk: Buffer) => { for (const frame of decoder.push(chunk)) this.onCommand(JSON.parse(frame)); });
    socket.on("error", () => {});
    this.write({ method: "extension.connected", params: ["browser-session-1"] });
    this.write({ method: "extension.initialized", params: [{ id: "khflooofmndpmafhofjdcpjfgnlpikhg", version: "0.1.4", protocol: 1, capabilities: [] }] });
  }
  disconnect(): void { this.socket?.destroy(); }
  /** A screencast frame of the tab, whichever settings it was made under; returns its number. */
  sendFrame(tabId: number, data: string): number {
    this.write({ method: "chrome.debugger.onEvent", params: [{ tabId }, "Page.screencastFrame", { data, metadata: {}, sessionId: ++this.frame }] });
    return this.frame;
  }
  methods(): string[] { return this.seen.map((s) => s.method).filter((m) => m.startsWith("Page.screencast") || m.endsWith("Screencast") || m === "Page.captureScreenshot"); }

  private write(message: unknown): void {
    this.socket?.write(encodeFrame(JSON.stringify(message), BROWSER_TO_HOST_MAX));
  }

  private onCommand(message: { id: number; method: string; params: any[] }): void {
    const { id, method, params } = message;
    const answer = (result: unknown) => this.write({ id, result });
    switch (method) {
      case "chrome.tabs.query": return answer([]);
      case "chrome.debugger.getTargets": return answer([]);
      case "chrome.tabs.create": return answer({ id: ++this.nextTab, url: params[0].url, title: "", status: "complete" });
      case "chrome.debugger.sendCommand": {
        const [{ tabId }, cdpMethod, cdpParams] = params;
        this.seen.push({ method: cdpMethod, params: cdpParams });
        if (cdpMethod === "Target.getTargetInfo")
          return answer({ targetInfo: { targetId: `target-${tabId}`, type: "page", url: "about:blank", title: "", attached: true, browserContextId: "ctx" } });
        if (cdpMethod === "Page.captureScreenshot") return answer({ data: "c2hvdA==" });
        answer({});
        // Chrome sends a screencast's first frame right after it starts, as large as it was asked for.
        if (cdpMethod === "Page.startScreencast") {
          this.sendFrame(tabId, (cdpParams?.maxWidth ?? 1280) <= 64 ? jpeg(64, 40) : png(1280, 800));
        }
        return;
      }
      default: return answer({});
    }
  }
}

/** A raw CDP client that keeps the screencast frames it is sent. */
class CdpClient {
  readonly frames: string[] = [];
  readonly sessions: string[] = [];
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id === undefined) {
        if (message.method === "Target.attachedToTarget") this.sessions.push(message.params.sessionId);
        if (message.method === "Page.screencastFrame") this.frames.push(`${message.sessionId}#${message.params.sessionId}`);
        return;
      }
      const callback = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    });
  }
  static async connect(cdpUrl: string): Promise<CdpClient> {
    const version = (await (await fetch(`${cdpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    return new CdpClient(ws);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close(): void { this.ws.close(); }
}

async function main() {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\cu-screencast-${process.pid}` : join(tmpdir(), `cu-screencast-${process.pid}.sock`);
  const server = new BridgeServer({ socketPath, log: () => {} });
  await server.start();
  const extension = new FakeExtension(socketPath);
  await extension.connect();
  await server.ensureExtension();
  // The driver, and a preview watching the same tab.
  const driver = await CdpClient.connect(server.cdpUrl());
  const preview = await CdpClient.connect(server.cdpUrl());
  try {
    await driver.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await driver.send("Target.createTarget", { url: "about:blank" });
    await until(() => driver.sessions.length > 0);
    const d = driver.sessions.at(-1)!;
    // As a preview attaches: an explicit flattened session on the tab's target.
    const p = (await preview.send("Target.attachToTarget", { targetId: "target-1", flatten: true }))?.sessionId as string;
    check("both clients are handed the tab", !!d && !!p);

    // ── A capture with no screencast running ─────────────────────────────────────────────
    extension.seen.length = 0;
    const shot = await driver.send("Page.captureScreenshot", { format: "jpeg" }, d);
    check("the capture is answered", shot?.data === "c2hvdA==", JSON.stringify(shot));
    check("…inside a screencast of the bridge's own: start, capture, stop",
      JSON.stringify(extension.methods()) === JSON.stringify(["Page.startScreencast", "Page.screencastFrameAck", "Page.captureScreenshot", "Page.stopScreencast"]),
      JSON.stringify(extension.methods()));
    check("…its first frame awaited and acknowledged by the bridge", extension.seen.find((s) => s.method === "Page.screencastFrameAck")?.params?.sessionId === 1);
    check("…the smallest frames Chrome makes", extension.seen[0]?.params?.maxWidth === 64);
    await sleep(50);
    check("…and no client is sent its frames", driver.frames.length === 0 && preview.frames.length === 0, JSON.stringify([driver.frames, preview.frames]));

    // ── A client's screencast ────────────────────────────────────────────────────────────
    extension.seen.length = 0;
    await preview.send("Page.startScreencast", { format: "png", maxWidth: 2560, maxHeight: 2560, everyNthFrame: 2 }, p);
    await until(() => preview.frames.length > 0);
    check("a client's screencast runs with its own settings", extension.seen.at(-1)?.params?.maxWidth === 2560);
    await sleep(50);
    check("…its frames go to it alone", preview.frames.length === 1 && driver.frames.length === 0, JSON.stringify([driver.frames, preview.frames]));
    extension.seen.length = 0;
    await driver.send("Page.screencastFrameAck", { sessionId: 2 }, d);
    await preview.send("Page.screencastFrameAck", { sessionId: 2 }, p);
    check("…only its own acknowledgements reach Chrome", JSON.stringify(extension.methods()) === JSON.stringify(["Page.screencastFrameAck"]), JSON.stringify(extension.methods()));
    extension.seen.length = 0;
    await driver.send("Page.captureScreenshot", { format: "jpeg" }, d);
    check("another client's capture leaves it running: no start, no stop",
      JSON.stringify(extension.methods()) === JSON.stringify(["Page.captureScreenshot"]), JSON.stringify(extension.methods()));
    extension.seen.length = 0;
    await driver.send("Page.stopScreencast", {}, d);
    check("a stop from a client that started none ends nothing", extension.methods().length === 0, JSON.stringify(extension.methods()));
    await preview.send("Page.stopScreencast", {}, p);
    check("its own stop ends it", JSON.stringify(extension.methods()) === JSON.stringify(["Page.stopScreencast"]), JSON.stringify(extension.methods()));

    // ── A frame of the bridge's own that arrives once a client reads ─────────────────────
    // A capture had the bridge's screencast running when a preview started its own: frames Chrome
    // had already made for the bridge's (64 px, quality 1) arrive after the preview is a reader.
    await preview.send("Page.startScreencast", { format: "png", maxWidth: 2560, maxHeight: 2560, everyNthFrame: 2 }, p);
    await until(() => preview.frames.length === 2);
    extension.seen.length = 0;
    const late = extension.sendFrame(1, jpeg(64, 40));
    await until(() => extension.methods().includes("Page.screencastFrameAck"));
    await sleep(50);
    check("a frame of the bridge's own is not the reader's picture", preview.frames.length === 2, JSON.stringify(preview.frames));
    check("…the bridge acknowledges it", extension.seen.find((s) => s.method === "Page.screencastFrameAck")?.params?.sessionId === late, JSON.stringify(extension.seen));
    const next = extension.sendFrame(1, png(1280, 800));
    await until(() => preview.frames.length === 3);
    check("…and the reader's next frame is its own", preview.frames.at(-1)?.endsWith(`#${next}`) === true, JSON.stringify(preview.frames));
    extension.seen.length = 0;
    await preview.send("Page.stopScreencast", {}, p);

    // ── A reader that goes away without a stop ───────────────────────────────────────────
    await preview.send("Page.startScreencast", { format: "png" }, p);
    extension.seen.length = 0;
    preview.close();
    await until(() => extension.methods().includes("Page.stopScreencast"));
    check("a client that leaves takes its screencast with it", JSON.stringify(extension.methods()) === JSON.stringify(["Page.stopScreencast"]), JSON.stringify(extension.methods()));
  } finally {
    driver.close();
    preview.close();
    extension.disconnect();
    server.stop();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall bridge-screencast checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
