/**
 * Answers and events reach a client in the order the extension sent them — `node scripts/test.mjs bridge-event-order`.
 *
 * Chrome answers `Page.getFrameTree` and then reports the page's lifecycle; a CDP client counts
 * on that order (Playwright listens for `load` only once the frame tree is answered). The bridge
 * handed an answer to its caller through a promise and an event at once, so when both arrived in
 * one read the event went out first, and a client waiting for a page to load waited for a `load`
 * it had been sent too early to see.
 *
 * Hermetic: the REAL bridge (server, model, native-messaging socket), a scripted extension on the
 * other end of that socket writing several messages as ONE chunk, and a raw CDP client that
 * records what it receives in order. No browser, no extension.
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
async function until(what: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) { if (what()) return true; await sleep(10); }
  return what();
}

/** The extension's end of the native socket. While `held` is set, what it would send is kept
 *  back, and {@link flush} writes all of it at once: one chunk, so one read on the bridge. */
class FakeExtension {
  readonly seen: string[] = [];
  /** CDP method → the events Chrome reports right AFTER answering it (`before`: right before). */
  readonly reports = new Map<string, { names: string[]; before?: boolean }>();
  private held: Buffer[] | null = null;
  private socket: net.Socket | null = null;
  private nextTab = 0;

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

  hold(): void { this.held = []; }
  flush(): void {
    const all = Buffer.concat(this.held ?? []);
    this.held = null;
    this.socket?.write(all);
  }
  disconnect(): void { this.socket?.destroy(); }

  private write(message: unknown): void {
    const frame = encodeFrame(JSON.stringify(message), BROWSER_TO_HOST_MAX);
    if (this.held) this.held.push(frame);
    else this.socket?.write(frame);
  }

  private onCommand(message: { id: number; method: string; params: any[] }): void {
    const { id, method, params } = message;
    const answer = (result: unknown) => this.write({ id, result });
    switch (method) {
      case "chrome.tabs.query": return answer([]);
      case "chrome.debugger.getTargets": return answer([]);
      case "chrome.tabs.create": return answer({ id: ++this.nextTab, url: params[0].url, title: "", status: "complete" });
      case "chrome.debugger.sendCommand": {
        const [{ tabId }, cdpMethod] = params;
        this.seen.push(cdpMethod);
        if (cdpMethod === "Target.getTargetInfo")
          return answer({ targetInfo: { targetId: `target-${tabId}`, type: "page", url: "about:blank", title: "", attached: true, browserContextId: "ctx" } });
        const report = this.reports.get(cdpMethod);
        const events = () => { for (const name of report?.names ?? []) this.write({ method: "chrome.debugger.onEvent", params: [{ tabId }, "Page.lifecycleEvent", { name, frameId: "F" }] }); };
        if (report?.before) events();
        answer(cdpMethod === "Page.getFrameTree" ? { frameTree: { frame: { id: "F", url: "about:blank" } } } : {});
        if (!report?.before) events();
        return;
      }
      default: return answer({});
    }
  }
}

/** A raw CDP client that keeps what it was sent, answers and events alike, in arrival order. */
class CdpClient {
  readonly received: string[] = [];
  readonly sessions: string[] = [];
  private nextId = 0;
  private pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id === undefined) {
        if (message.method === "Target.attachedToTarget") this.sessions.push(message.params.sessionId);
        if (message.method === "Page.lifecycleEvent") this.received.push(`event ${message.params.name}`);
        return;
      }
      const callback = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      this.received.push(`answer ${callback.method}`);
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
    return new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
  }
  close(): void { this.ws.close(); }
}

async function main() {
  const socketPath = join(tmpdir(), `cu-event-order-${process.pid}.sock`);
  const server = new BridgeServer({ socketPath, log: () => {} });
  await server.start();
  const extension = new FakeExtension(socketPath);
  await extension.connect();
  await server.ensureExtension();
  const client = await CdpClient.connect(server.cdpUrl());
  try {
    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await client.send("Target.createTarget", { url: "about:blank" });
    const session = client.sessions.at(-1)!;
    check("the client is handed the tab", !!session);

    /** Send `methods` together, have the extension answer all of them in ONE chunk, and return
     *  what the client then received, in order. */
    const inOneRead = async (methods: string[]): Promise<string[]> => {
      client.received.length = 0;
      extension.seen.length = 0;
      extension.hold();
      const sent = methods.map((m) => client.send(m, {}, session));
      await until(() => methods.every((m) => extension.seen.includes(m)));
      extension.flush();
      await Promise.all(sent);
      await sleep(50);
      return [...client.received];
    };

    // What Chrome does when a client meets a page that has already loaded: the frame tree is
    // answered, then turning lifecycle events on replays the ones that have fired.
    extension.reports.set("Page.setLifecycleEventsEnabled", { names: ["commit", "DOMContentLoaded", "load"], before: true });
    const attach = await inOneRead(["Page.getFrameTree", "Page.setLifecycleEventsEnabled"]);
    const want = ["answer Page.getFrameTree", "event commit", "event DOMContentLoaded", "event load", "answer Page.setLifecycleEventsEnabled"];
    check("events that follow an answer in the same read reach the client after it", JSON.stringify(attach) === JSON.stringify(want), JSON.stringify(attach));

    extension.reports.clear();
    extension.reports.set("Page.reload", { names: ["init"], before: true });
    const eventFirst = await inOneRead(["Page.reload"]);
    check("an event that came before an answer still reaches the client before it",
      JSON.stringify(eventFirst) === JSON.stringify(["event init", "answer Page.reload"]), JSON.stringify(eventFirst));

    extension.reports.clear();
    extension.reports.set("Page.enable", { names: ["a"] });
    extension.reports.set("Page.getFrameTree", { names: ["b", "c"] });
    extension.reports.set("Page.bringToFront", { names: ["d"], before: true });
    const mixed = await inOneRead(["Page.enable", "Page.getFrameTree", "Page.bringToFront"]);
    check("a longer run of answers and events keeps its order throughout",
      JSON.stringify(mixed) === JSON.stringify(["answer Page.enable", "event a", "answer Page.getFrameTree", "event b", "event c", "event d", "answer Page.bringToFront"]),
      JSON.stringify(mixed));

    // An event waiting behind an answer when the line goes must not be an error of its own.
    extension.reports.clear();
    extension.reports.set("Page.enable", { names: ["late"] });
    extension.hold();
    void client.send("Page.enable", {}, session).catch(() => {});
    await until(() => extension.seen.includes("Page.enable"));
    extension.flush();
    extension.disconnect();
    await sleep(100);
    check("the line closing right behind an answer and an event leaves the bridge running", await fetch(`${server.cdpUrl()}/status`).then((r) => r.ok, () => false));
  } finally {
    client.close();
    extension.disconnect();
    server.stop();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall bridge-event-order checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
