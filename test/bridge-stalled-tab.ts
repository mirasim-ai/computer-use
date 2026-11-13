/**
 * A tab that stops answering the debugger, on the extension bridge — `node scripts/test.mjs bridge-stalled-tab`.
 *
 * Hermetic: the REAL bridge (server, model, native-messaging socket), a scripted extension on the
 * other end of that socket, and a raw CDP client. No browser, no extension. The scripted extension
 * answers everything the real one does except what a check makes it withhold.
 *
 *   · a page session never auto-attaches service workers (one that nobody resumes holds a
 *     navigation, and Chrome answers nothing on a tab whose navigation is pending);
 *   · a tab that answers nothing fails ITS commands, naming the tab and where it was going, and
 *     the line, the other tabs and the other commands carry on;
 *   · the next line does not hand that tab out again by itself; binding it by name does;
 *   · an extension that answers nothing at all still loses its line;
 *   · a command too large for one native message fails by itself, at once.
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
  for (const end = Date.now() + ms; Date.now() < end;) { if (what()) return true; await sleep(20); }
  return what();
}

const COMMAND_TIMEOUT_MS = 1000;
const SESSION = "browser-session-1";
type Tab = { id: number; url: string; pendingUrl?: string; title: string; status: string };

/** The extension's end of the native socket, scripted. */
class FakeExtension {
  readonly tabs = new Map<number, Tab>();
  /** Tabs whose debugger commands get no answer. */
  readonly silent = new Set<number>();
  /** Answers nothing at all, pings included. */
  deaf = false;
  readonly commands: Array<{ tabId: number; method: string; params: any }> = [];
  readonly released: number[] = [];
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
    this.emit("extension.connected", [SESSION]);
    for (const tab of this.tabs.values()) this.emit("chrome.tabs.onCreated", [tab, { agent: false }]);
    this.emit("extension.initialized", [{ id: "khflooofmndpmafhofjdcpjfgnlpikhg", version: "0.1.4", protocol: 1, capabilities: [] }]);
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private write(message: unknown): void {
    this.socket?.write(encodeFrame(JSON.stringify(message), BROWSER_TO_HOST_MAX));
  }

  private emit(method: string, params: unknown[]): void {
    this.write({ method, params });
  }

  private onCommand(message: { id: number; method: string; params: any[] }): void {
    if (this.deaf) return;
    const { id, method, params } = message;
    const answer = (result: unknown) => this.write({ id, result });
    switch (method) {
      case "bridge.ping":
      case "bridge.info":
      case "chrome.debugger.attach":
        return answer({});
      case "bridge.releaseTab":
        this.released.push(params[0]);
        return answer({});
      case "chrome.tabs.query":
        return answer([...this.tabs.values()]);
      case "chrome.debugger.getTargets":
        return answer([...this.tabs.values()].map((t) => ({ tabId: t.id, id: `target-${t.id}`, type: "page", url: t.url })));
      case "chrome.tabs.create": {
        const tab: Tab = { id: ++this.nextTab, url: params[0].url, title: "", status: "complete" };
        this.tabs.set(tab.id, tab);
        return answer(tab);
      }
      case "chrome.debugger.sendCommand": {
        const [{ tabId }, cdpMethod, cdpParams] = params;
        this.commands.push({ tabId, method: cdpMethod, params: cdpParams });
        if (this.silent.has(tabId)) return;
        if (cdpMethod === "Target.getTargetInfo")
          return answer({ targetInfo: { targetId: `target-${tabId}`, type: "page", url: this.tabs.get(tabId)!.url, title: "", attached: true, browserContextId: "ctx" } });
        return answer({});
      }
      default:
        return this.write({ id, error: `Unknown method: ${method}` });
    }
  }
}

/** A raw CDP client of the bridge: commands, and every event it was sent. */
class CdpClient {
  readonly events: Array<{ method: string; params: any; sessionId?: string }> = [];
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id === undefined) { this.events.push(message); return; }
      const callback = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) callback?.reject(new Error(message.error.message));
      else callback?.resolve(message.result);
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
  /** The session this client was last handed for a target. */
  sessionFor(targetId: string): string | undefined {
    let session: string | undefined;
    for (const e of this.events) {
      if (e.method === "Target.attachedToTarget" && e.params.targetInfo.targetId === targetId) session = e.params.sessionId;
      if (e.method === "Target.detachedFromTarget" && e.params.targetId === targetId) session = undefined;
    }
    return session;
  }
  close(): void { this.ws.close(); }
}

/** How a promise ended, without throwing: its error's message, or null when it resolved. */
const failure = (p: Promise<unknown>): Promise<string | null> => p.then(() => null, (e) => (e as Error).message);

async function main() {
  const socketPath = join(tmpdir(), `cu-stalled-${process.pid}.sock`);
  const bridgeLog: string[] = [];
  const server = new BridgeServer({
    socketPath,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    log: (...args: unknown[]) => { bridgeLog.push(args.map(String).join(" ")); },
  });
  await server.start();
  const extension = new FakeExtension(socketPath);
  await extension.connect();
  await server.ensureExtension();
  const client = await CdpClient.connect(server.cdpUrl());
  try {
    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const list = await client.send("Target.createTarget", { url: "https://app.example/list" });
    const doc = await client.send("Target.createTarget", { url: "about:blank" });
    const listSession = client.sessionFor(list.targetId)!;
    const docSession = client.sessionFor(doc.targetId)!;
    check("the client is handed both of the agent's tabs", !!listSession && !!docSession);

    // ── Service workers stay out of a page session's auto-attach ───────────────────────────
    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, listSession);
    const forwarded = extension.commands.findLast((c) => c.method === "Target.setAutoAttach")!;
    check("a page session's auto-attach reaches Chrome without service workers",
      forwarded.tabId === 1 && forwarded.params.waitForDebuggerOnStart === true
        && forwarded.params.filter?.some((f: any) => f.type === "service_worker" && f.exclude === true)
        && forwarded.params.filter.at(-1) && Object.keys(forwarded.params.filter.at(-1)).length === 0,
      JSON.stringify(forwarded.params));
    await client.send("Target.setAutoAttach", { autoAttach: true, flatten: true, filter: [{ type: "worker" }] }, listSession);
    check("...and a filter the client chose itself is left as it is",
      JSON.stringify(extension.commands.at(-1)!.params.filter) === JSON.stringify([{ type: "worker" }]));
    await client.send("Target.setAutoAttach", { autoAttach: false, flatten: true }, listSession);
    check("...as is turning auto-attach off", extension.commands.at(-1)!.params.filter === undefined);

    // ── A command too large for one native message ─────────────────────────────────────────
    let started = Date.now();
    const tooLarge = await failure(client.send("Runtime.evaluate", { expression: `"${"x".repeat(1_200_000)}"` }, listSession));
    check("a command over Chrome's 1 MB a message fails at once, saying so",
      !!tooLarge && /was not sent/.test(tooLarge) && /1048576/.test(tooLarge) && Date.now() - started < 500, `${tooLarge?.slice(0, 160)} after ${Date.now() - started} ms`);
    check("...and the line and the tab carry on", server.extensionConnected()
      && (await failure(client.send("Runtime.evaluate", { expression: "1" }, listSession))) === null);

    // ── A tab that answers nothing ─────────────────────────────────────────────────────────
    extension.tabs.get(2)!.pendingUrl = "https://app.example/docs/new";
    extension.silent.add(2);
    started = Date.now();
    const navigate = failure(client.send("Page.navigate", { url: "https://app.example/docs/new" }, docSession));
    await sleep(400);
    const later = failure(client.send("Runtime.evaluate", { expression: "1" }, docSession));
    const meanwhile = await failure(client.send("Runtime.evaluate", { expression: "1" }, listSession));
    check("while one tab answers nothing, another tab's command is answered", meanwhile === null && Date.now() - started < COMMAND_TIMEOUT_MS, String(meanwhile));
    const navigateError = await navigate;
    const navigateMs = Date.now() - started;
    check("the unanswered command fails, naming the tab and where it was going",
      !!navigateError && /Tab 2 \(https:\/\/app\.example\/docs\/new\) did not answer Page\.navigate for 1s/.test(navigateError), String(navigateError));
    const laterError = await later;
    check("...and so does everything else waiting on that tab, without a timeout of its own",
      laterError === navigateError && Date.now() - started < COMMAND_TIMEOUT_MS + 700, `${laterError?.slice(0, 80)} at ${Date.now() - started} ms (first at ${navigateMs})`);
    check("the client is told that tab's page is gone", await until(() => client.sessionFor(doc.targetId) === undefined));
    check("the debugger is taken off the tab", await until(() => extension.released.includes(2)), JSON.stringify(extension.released));
    await sleep(300);
    check("the line stays up", server.extensionConnected());
    check("...and the other tab still answers", (await failure(client.send("Runtime.evaluate", { expression: "1" }, listSession))) === null);
    const { refusals } = await client.send("Mirasim.attachRefusals");
    check("a client that asks why is told, with the tab and its address",
      refusals.some((r: any) => r.unanswered === true && r.url === "https://app.example/docs/new" && /tab 2 \(https:\/\/app\.example\/docs\/new\) did not answer Page\.navigate/.test(r.reason)),
      JSON.stringify(refusals));
    check("the bridge's log names the tab too", bridgeLog.some((l) => /let go of tab 2 \(https:\/\/app\.example\/docs\/new\)/.test(l)));

    // ── The next line does not stall on the same tab ───────────────────────────────────────
    extension.disconnect();
    await until(() => !server.extensionConnected());
    const before = extension.commands.length;
    await extension.connect();
    await server.ensureExtension();
    check("after a reconnect the tab that answered is handed back", await until(() => !!client.sessionFor(list.targetId)));
    await sleep(300);
    check("...and the one that did not is left alone", client.sessionFor(doc.targetId) === undefined
      && !extension.commands.slice(before).some((c) => c.tabId === 2), JSON.stringify(extension.commands.slice(before).filter((c) => c.tabId === 2)));
    const { tabs, browserSession } = await client.send("Mirasim.tabs");
    check("it is still listed", tabs.some((t: any) => t.tabId === 2), JSON.stringify(tabs.map((t: any) => t.tabId)));

    // Bound by name once it answers again: the one way back.
    extension.silent.delete(2);
    const targetId = (await client.send("Mirasim.tabTarget", { tabId: 2, browserSession })).targetId;
    await client.send("Mirasim.restoreTab", { tabId: 2, targetId, browserSession });
    const rebound = client.sessionFor(targetId);
    check("binding it by name attaches it again", !!rebound && (await failure(client.send("Runtime.evaluate", { expression: "1" }, rebound))) === null);

    // ── An extension that answers nothing at all ───────────────────────────────────────────
    extension.deaf = true;
    started = Date.now();
    const dead = await failure(client.send("Runtime.evaluate", { expression: "1" }, client.sessionFor(list.targetId)));
    check("with the extension itself silent the command fails without blaming its tab", !!dead && /Extension did not answer Runtime\.evaluate tab=1/.test(dead), String(dead));
    check("...and this time the line is dropped, so it can be dialled again", await until(() => !server.extensionConnected(), 8000),
      `after ${Date.now() - started} ms`);
  } finally {
    client.close();
    extension.disconnect();
    server.stop();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall bridge-stalled-tab checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
