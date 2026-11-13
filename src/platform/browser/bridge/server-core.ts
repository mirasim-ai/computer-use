/**
 * Portions Copyright (c) Microsoft Corporation (Playwright), licensed under the Apache License,
 * Version 2.0; modified by MIRASIM, INC. See LICENSE and NOTICE.
 *
 * The mirasim browser bridge — a local CDP endpoint whose backend is the user's OWN running
 * browser, reached through the mirasim bridge extension.
 *
 * To a client this is a standard DevTools endpoint (`/json/version`, `connectOverCDP`), so
 * computer-use needs only `COMPUTER_USE_CDP_URL=<cdpUrl>` and no bridge-specific code. The
 * extension executes chrome.* calls and streams chrome.debugger events; the agent's tabs live in
 * the "mirasim" tab group of the user's window, the visible ownership boundary.
 *
 * The extension dials in by itself over native messaging (Chrome spawns
 * `mirasim-cu bridge-host`, which pumps into this process's local socket), so a
 * browser restart, an update or a service-worker eviction heals with no click. This process never
 * opens a page or spawns a browser; the connect-page relay is only a test seam
 * ({@link BridgeServerOptions.openUrl}).
 *
 * `POST <cdpUrl>/recycle` closes only the tabs the AGENT opened: a page the user dragged in was
 * granted, not given away, and the browser itself is never ours to close.
 *
 * Endpoint paths embed a UUID as the auth token (same trust model as Chrome's DevToolsActivePort
 * file). The WS upgrade also checks Origin: the extension path accepts only the pinned extension
 * origin, the CDP path only local processes (no Origin), so a web page that learned the UUID
 * still cannot connect.
 *
 * Relay mechanism adapted from Microsoft Playwright's MCP CDP relay (Apache-2.0); the model
 * departures are documented in model-core.ts.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { WebSocketServer } from "ws";
import { socketChannel, type ExtensionChannel } from "./extension-channel.ts";
import { ExtensionUnanswered } from "./client.ts";
import { FrameTooLargeError } from "./native-frames.ts";
import { BridgeModel } from "./model.ts";
import { MIRASIM_EXTENSION_ID, extensionManifest } from "./extension-id.ts";
import { ExtensionUpdates } from "./extension-updates.ts";

/** How long a CDP client's handshake may wait for the extension to come up. */
const EXTENSION_WAIT_MS = 15_000;
/** A chrome.* call the extension never answers becomes an ERROR after this, not a hang: an MV3
 *  service worker can be evicted mid-command, and playwright waits forever on an unanswered id. */
const EXTENSION_COMMAND_TIMEOUT_MS = 30_000;
/** A call still unanswered after this gets a log line — the ONLY record that a stall lives on the
 *  extension side. Most callers' own budgets are tighter than the bound above (`SHOT_TIMEOUT_MS`
 *  4s, `NAV_TIMEOUT_MS` 15s, clicks 4-8s) and give up first, so the warning must sit below the
 *  tightest of them. The bound itself does fire in the product: Chrome answers NOTHING on a tab
 *  whose navigation has not started loading, however long that takes. */
const SLOW_CALL_WARN_MS = 3_000;
/** How long the extension gets to answer a ping once a command went unanswered. It answers from
 *  its own worker in milliseconds, whatever a tab is doing; silence here means the line is dead. */
const LINE_PROBE_MS = 5_000;

export interface BridgeServerOptions {
  /** TCP port; 0 (default) = ephemeral. Always bound to 127.0.0.1. */
  port?: number;
  /**
   * TEST SEAM ONLY — how {@link BridgeServerCore.connectPageUrl} reaches a browser. The product
   * never passes one: the bridge must not open a page or spawn a browser, and the ws relay is
   * one-shot (the uuid is per process, so every restart would need a human click), while native
   * messaging needs nothing handed over. The end-to-end tests use it to attach a real extension
   * in a throwaway Chromium, where no native-host manifest exists. Absent,
   * {@link BridgeServerCore.ensureExtension} only waits for the extension to dial in.
   */
  openUrl?: (url: string) => void | Promise<void>;
  /** Extension ID for the connect URL + Origin check (default: the pinned one). */
  extensionId?: string;
  /** Absolute path of the local socket the native-messaging shim (`mirasim-cu
   *  bridge-host`) dials. Absent = ws relay only (a hand-run `bridge`, every test). The
   *  supervising host hands the SAME path to the generated native-host wrapper, so nothing is
   *  discovered at run time. */
  socketPath?: string;
  /** Verbose trace sink. Absent = silent, EXCEPT the stall lines, which fall back to stderr:
   *  they are the only record of where a hang lives. */
  log?: (...args: unknown[]) => void;
  /** TEST SEAM ONLY — how long a command may go unanswered (default 30s), so a suite that
   *  makes a tab stop answering does not wait half a minute per check. */
  commandTimeoutMs?: number;
}

/** Id/callback bookkeeping over the extension's line, whichever transport carries it
 *  ({@link ExtensionChannel}: the ws relay, or the native-messaging socket). */
export class ExtensionConnection {
  private readonly callbacks = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; tabId?: number }>();
  private lastId = 0;
  private probing = false;
  onEvent: ((method: string, params: unknown[]) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(
    private readonly channel: ExtensionChannel,
    protected readonly log: (...args: unknown[]) => void,
    protected readonly warn: (...args: unknown[]) => void,
    private readonly commandTimeoutMs = EXTENSION_COMMAND_TIMEOUT_MS,
  ) {
    channel.onMessage((text) => this.onMessage(text));
    channel.onClose(() => this.dispose());
  }

  /** Which transport this connection came in on. */
  get transport(): ExtensionChannel["kind"] {
    return this.channel.kind;
  }

  get pendingCount(): number { return this.callbacks.size; }

  get isOpen(): boolean { return this.channel.isOpen; }

  send(method: string, params: unknown[]): Promise<unknown> {
    if (!this.channel.isOpen) return Promise.reject(new Error("Extension connection closed"));
    const id = ++this.lastId;
    const started = Date.now();
    const tabId = debuggeeTab(method, params);
    return new Promise((resolve, reject) => {
      // Keepalive pings are excluded on purpose: one every 20s, and a busy service
      // worker delaying one is normal — warning on those buries the signal.
      const warn = method === "bridge.ping" ? null : setTimeout(() => {
        // Read-only: deleting the entry is what decides the timeout below.
        if (this.callbacks.has(id)) this.warn(`slow: ${callLabel(method, params)} pending ${SLOW_CALL_WARN_MS}ms`);
      }, SLOW_CALL_WARN_MS);
      warn?.unref?.();
      const timer = setTimeout(() => {
        const callback = this.callbacks.get(id);
        if (!callback) return;
        const cdpMethod = tabId !== undefined && typeof params[1] === "string" ? params[1] : undefined;
        const unanswered = new ExtensionUnanswered(
          `Extension did not answer ${callLabel(method, params)} within ${this.commandTimeoutMs}ms`, this.commandTimeoutMs, tabId, cdpMethod);
        // Never replay a command: a timed-out input may already have reached its tab.
        callback.reject(unanswered);
        // Whatever else waits on that tab waits on the same thing: fail it now, not one timeout each.
        if (tabId !== undefined) for (const other of [...this.callbacks.values()]) if (other.tabId === tabId) other.reject(unanswered);
        void this.closeUnlessAnswering(method);
      }, this.commandTimeoutMs);
      timer.unref?.();
      const settled = () => { this.callbacks.delete(id); clearTimeout(timer); if (warn) clearTimeout(warn); };
      this.callbacks.set(id, {
        ...(tabId === undefined ? {} : { tabId }),
        resolve: (v) => {
          settled();
          // Only the calls that warned report their total, so a healthy run stays silent.
          const ms = Date.now() - started;
          if (ms >= SLOW_CALL_WARN_MS && method !== "bridge.ping") this.warn(`${callLabel(method, params)} answered after ${ms}ms`);
          resolve(v);
        },
        reject: (e) => { settled(); reject(e); },
      });
      try { this.channel.send(JSON.stringify({ id, method, params })); }
      catch (e) {
        const callback = this.callbacks.get(id)!;
        if (e instanceof FrameTooLargeError) {
          // Nothing was written, so the line is as good as before: only this command fails.
          this.warn(`not sent: ${callLabel(method, params)} is ${e.bytes} bytes, over the ${e.max} Chrome takes in one message`);
          callback.reject(new Error(`${callLabel(method, params)} was not sent: at ${e.bytes} bytes it is over the ${e.max} bytes `
            + "Chrome accepts in one message to an extension. Pass less in one call (a long text or script in several parts)."));
          return;
        }
        callback.reject(e instanceof Error ? e : new Error(String(e)));
        this.close('Extension transport failed');
      }
    });
  }

  /**
   * One unanswered command is not a dead line: a tab whose navigation never starts loading
   * answers nothing while the extension itself is fine, and dropping the line for it took every
   * other tab and every other session down with it (and the next line stalled on the same tab).
   * So ask the extension itself. Only its silence closes this transport, so native messaging
   * reconnects and releases stale debugger sessions.
   */
  private async closeUnlessAnswering(method: string): Promise<void> {
    if (method === "bridge.ping") { this.close('Extension command timed out'); return; }
    if (this.probing || !this.channel.isOpen) return;
    this.probing = true;
    try {
      if (!(await this.answersWithin(LINE_PROBE_MS))) this.close('Extension command timed out');
    } finally {
      this.probing = false;
    }
  }

  /** Does the line answer a ping in time? A closed or silent one does not. */
  async answersWithin(ms: number): Promise<boolean> {
    if (!this.channel.isOpen) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); });
    try {
      return await Promise.race([this.send("bridge.ping", []).then(() => true, () => false), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  close(reason: string): void {
    try { this.channel.close(reason); }
    finally { this.dispose(); }
  }

  private onMessage(text: string): void {
    let message: { id?: number; method?: string; params?: unknown[]; result?: unknown; error?: string };
    try {
      message = JSON.parse(text);
    } catch (e) {
      this.log("malformed extension message:", e);
      return;
    }
    if (message.id !== undefined && this.callbacks.has(message.id)) {
      const callback = this.callbacks.get(message.id)!;
      if (message.error !== undefined) callback.reject(new Error(message.error));
      else callback.resolve(message.result);
      return;
    }
    if (message.method) this.onEvent?.(message.method, message.params ?? []);
  }

  private dispose(): void {
    for (const callback of [...this.callbacks.values()]) callback.reject(new Error("Extension connection closed"));
    this.callbacks.clear();
    this.onClose?.();
    this.onClose = null;
  }
}

/** The tab a `chrome.debugger.sendCommand` is for; undefined for every other call. */
function debuggeeTab(method: string, params: unknown[]): number | undefined {
  if (method !== "chrome.debugger.sendCommand") return undefined;
  const tabId = (params[0] as { tabId?: unknown } | undefined)?.tabId;
  return typeof tabId === "number" ? tabId : undefined;
}

/** What a `chrome.*` call is doing, for one log line. Nearly every call is
 *  `chrome.debugger.sendCommand`, so the CDP method and debuggee in `params`
 *  (`[{ tabId, sessionId? }, method, params?]`) are what tell two calls apart. Slow path only. */
function callLabel(method: string, params: unknown[]): string {
  if (method !== "chrome.debugger.sendCommand") return method;
  const debuggee = params[0] as { tabId?: number; sessionId?: string } | undefined;
  const cdpMethod = typeof params[1] === "string" ? params[1] : method;
  const where = [
    debuggee?.tabId === undefined ? null : `tab=${debuggee.tabId}`,
    debuggee?.sessionId ? `session=${debuggee.sessionId}` : null,
  ].filter(Boolean);
  return where.length ? `${cdpMethod} ${where.join(" ")}` : cdpMethod;
}

export abstract class BridgeServerCore {
  /** Implemented in {@link BridgeServer}: the WebSocket half owns the upgrade, and this half is
   *  what the HTTP server hands it to. */
  protected abstract handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  protected readonly uuid = randomUUID();
  private readonly httpServer: http.Server;
  protected readonly wss = new WebSocketServer({ noServer: true });
  protected readonly model: BridgeModel;
  /** Public: `bridge --native-host` names it in the native-messaging manifest's
   *  `allowed_origins` (`native-host.ts`), and the status line reports it. */
  readonly extensionId: string;
  readonly extensionIds: string[];
  protected readonly updates: ExtensionUpdates;
  protected activeOperations = 0;
  protected readonly log: (...args: unknown[]) => void;
  /** Where a stall is reported: the caller's sink if it gave one, stderr otherwise
   *  (stdout is the one status line a host parses — see entries/commands/bridge.ts). */
  protected readonly warn: (...args: unknown[]) => void;
  /** Test seam; null in the product — see {@link BridgeServerOptions.openUrl}. */
  private readonly openUrl: ((url: string) => void | Promise<void>) | null;
  /** Test seam; undefined in the product — see {@link BridgeServerOptions.commandTimeoutMs}. */
  protected readonly commandTimeoutMs: number | undefined;
  protected port = 0;

  protected extension: ExtensionConnection | null = null;
  /** True once the CURRENT extension connection finished its tab handshake. */
  protected extensionInitialized = false;
  /** The active extension's browser-session nonce, once its handshake named one. */
  protected extensionSession: string | null = null;
  /** Other browsers' extensions, connected and parked while the active one still answers
   *  (server.ts `attachExtension`). Released when the active one goes. */
  protected readonly standby = new Set<ExtensionConnection>();
  protected readyWaiters: Array<() => void> = [];
  /** The native leg's listener, when `socketPath` was given. */
  private socketServer: net.Server | null = null;
  private readonly socketPath: string | null;
  private connectInFlight: Promise<void> | null = null;
  protected keepalive: NodeJS.Timeout | null = null;

  constructor(options: BridgeServerOptions = {}) {
    this.log = options.log ?? (() => {});
    this.warn = options.log ?? ((...args: unknown[]) => console.error("[bridge]", ...args));
    this.extensionId = options.extensionId ?? MIRASIM_EXTENSION_ID;
    this.extensionIds = [this.extensionId];
    this.openUrl = options.openUrl ?? null;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.model = new BridgeModel((method, params) => {
      if (this.updates.reloading) throw new Error('The Mirasim extension is reloading; reconnect before continuing.');
      if (!this.extension) throw new Error("Bridge extension not connected");
      return this.extension.send(method, params);
    }, this.log);
    this.updates = new ExtensionUpdates(extensionManifest(),
      () => !this.extension || this.model.clientCount() > 0 || this.activeOperations > 0 || this.extension.pendingCount > 0,
      async () => {
        if (!this.extension) throw new Error('The Mirasim extension disconnected before reloading.');
        return await this.extension.send('bridge.reload', []);
      });
    this.port = options.port ?? 0;
    this.socketPath = options.socketPath ?? null;
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.httpServer.on("upgrade", (req, socket, head) => void this.handleUpgrade(req, socket, head));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, "127.0.0.1", () => resolve());
    });
    this.port = (this.httpServer.address() as AddressInfo).port;
    await this.startNativeLeg();
  }

  /**
   * Listen for the native-messaging shim. A stale socket file is normal after a crash (SIGKILL
   * unlinks nothing), so an unanswered `EADDRINUSE` is removed and retried once. 0600: this
   * socket is a command channel into the user's browser and file permissions are its ONLY gate —
   * deliberately no uuid here (a durable token in a file is what this design avoids). Failure is
   * not fatal: the ws relay still works, so the reason only goes to the log.
   */
  private async startNativeLeg(): Promise<void> {
    const sockPath = this.socketPath;
    if (!sockPath) return;
    // A Windows named pipe is not a file: it has no directory to create, no mode to set and
    // nothing to unlink. Everything below that touches the filesystem is POSIX-only.
    const isPipe = sockPath.startsWith("\\\\.\\pipe\\");
    // The directory must exist BEFORE the bind: macOS answers a bind under a missing directory
    // with EACCES, not ENOENT, so a first start would fail blaming permissions.
    if (!isPipe) {
      try {
        fs.mkdirSync(path.dirname(sockPath), { recursive: true });
      } catch (e) {
        this.warn("native leg unavailable:", e);
        return;
      }
    }
    const server = net.createServer((socket) => {
      socket.on("error", (e) => this.log("native socket error:", e));
      this.attachExtension(socketChannel(socket, (e) => this.warn("native leg:", e.message)));
    });
    server.on("error", (e) => this.warn("native leg listener:", e));
    const listen = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(sockPath, () => resolve());
      });
    try {
      await listen();
    } catch (e) {
      if (isPipe || (e as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        this.warn("native leg unavailable:", e);
        return;
      }
      try {
        fs.unlinkSync(sockPath);
        await listen();
      } catch (retry) {
        this.warn("native leg unavailable:", retry);
        return;
      }
    }
    if (!isPipe) {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {
        /* best effort — a socket we cannot chmod is still ours */
      }
    }
    this.socketServer = server;
    this.log("native leg listening on", sockPath);
  }

  /** Implemented in {@link BridgeServer} — the half that owns the extension line. */
  protected abstract attachExtension(channel: ExtensionChannel): void;

  /** The value for COMPUTER_USE_CDP_URL — a standard DevTools-style HTTP endpoint. */
  cdpUrl(): string {
    return `http://127.0.0.1:${this.port}/${this.uuid}`;
  }

  /** TEST SEAM ONLY — see {@link BridgeServerOptions.openUrl}. Nothing in the product reads it. */
  connectPageUrl(): string {
    const relay = `ws://127.0.0.1:${this.port}/extension/${this.uuid}`;
    return `chrome-extension://${this.extensionId}/connect.html?relay=${encodeURIComponent(relay)}`;
  }

  extensionConnected(): boolean {
    return this.extension !== null;
  }

  /**
   * Have the extension on the line — idempotent; fails loudly, naming the one fix, rather than
   * hang. In the product this only WAITS for the extension to dial in: a timeout means it is not
   * installed, not enabled, or its native host is blocked by policy, none of which another page
   * would fix. Tests inject {@link BridgeServerOptions.openUrl} to kick it.
   */
  async ensureExtension(): Promise<void> {
    if (this.extension && this.extensionInitialized && !this.updates.reloading) return;
    if (!this.connectInFlight) {
      this.connectInFlight = (async () => {
        const ready = this.waitExtensionReady();
        if (this.openUrl) await this.openUrl(this.connectPageUrl());
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The mirasim bridge extension did not connect — is it installed and enabled in your browser?")),
            EXTENSION_WAIT_MS,
          );
          timer.unref?.();
        });
        try {
          await Promise.race([ready, timeout]);
        } finally {
          clearTimeout(timer);
        }
      })();
      this.connectInFlight.catch(() => {}).finally(() => {
        this.connectInFlight = null;
      });
    }
    await this.connectInFlight;
  }

  private waitExtensionReady(): Promise<void> {
    if (this.extension && this.extensionInitialized && !this.updates.reloading) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  stop(): void {
    this.updates.reset();
    if (this.keepalive) clearInterval(this.keepalive);
    this.extension?.close("Bridge stopped");
    for (const client of this.wss.clients) client.close(1000, "Bridge stopped");
    this.httpServer.close();
    this.socketServer?.close();
    this.socketServer = null;
    if (this.socketPath && !this.socketPath.startsWith("\\\\.\\pipe\\")) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        /* already gone */
      }
    }
  }

  // ─── HTTP façade ──────────────────────────────────────────────────────

  /** Keep an operation busy until its last asynchronous command, even if its socket closed. */
  protected async runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.updates.reloading) throw new Error('The Mirasim extension is reloading; reconnect before continuing.');
    this.activeOperations += 1;
    try { return await operation(); }
    finally { this.activeOperations -= 1; }
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const rel = this.stripUuid(url.pathname);
    if (rel === null) {
      res.writeHead(404).end();
      return;
    }
    const answer = (status: number, body: unknown) => {
      const text = JSON.stringify(body, null, 2);
      res.writeHead(status, { "Content-Type": "application/json; charset=UTF-8", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (rel === "/status" && req.method === "GET") {
      const connected = this.extensionConnected() && this.extensionInitialized;
      answer(200, { extensionConnected: connected, extension: this.updates.status(connected), standbyBrowsers: this.standby.size });
      return;
    }
    if (rel === '/extension/reload' && req.method === 'POST') {
      if (req.headers.origin) { answer(403, { error: 'Reload must be requested by the local host.' }); return; }
      try {
        this.updates.request();
        answer(202, { scheduled: true });
      } catch (e) { answer(409, { error: e instanceof Error ? e.message : String(e) }); }
      return;
    }
    if (rel === "/recycle" && req.method === "POST") {
      // Close the tabs the AGENT opened — the host's "close the agent's tab when a task
      // finishes" switch. Never the browser: it is the user's own (see model.recycleAgentTabs).
      void this.runOperation(() => this.model.recycleAgentTabs()).then(
        (result) => answer(200, result),
        (e) => answer(502, { error: e instanceof Error ? e.message : String(e) }),
      );
      return;
    }
    if (rel === "/json/version" && req.method === "GET") {
      answer(200, {
        Browser: "mirasim-bridge",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/cdp/${this.uuid}`,
      });
      return;
    }
    if ((rel === "/json" || rel === "/json/list") && req.method === "GET") {
      void this.runOperation(() => this.model.listTargets()).then(
        (targets) => answer(200, targets),
        (e) => answer(500, { error: e instanceof Error ? e.message : String(e) }),
      );
      return;
    }
    if (rel === "/json/new" && (req.method === "PUT" || req.method === "GET")) {
      // Chrome's own endpoint takes the raw query as the URL (PUT /json/new?https://…).
      const target = decodeURIComponent(url.search.slice(1));
      void (async () => {
        try {
          await this.ensureExtension();
          const { targetId } = await this.runOperation(() => this.model.createTarget(target || undefined));
          answer(200, { id: targetId, type: "page", url: target || "about:blank" });
        } catch (e) {
          answer(500, { error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return;
    }
    res.writeHead(404).end();
  }

  /** `/uuid/json/…` → `/json/…` (trailing slash tolerated); null when the token is wrong. */
  private stripUuid(pathname: string): string | null {
    const prefix = `/${this.uuid}`;
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length).replace(/\/$/, "");
    return rest.startsWith("/") ? rest : null;
  }
}
