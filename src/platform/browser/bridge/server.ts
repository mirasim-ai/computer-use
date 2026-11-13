/**
 * Portions Copyright (c) Microsoft Corporation (Playwright), licensed under the Apache License,
 * Version 2.0; modified by MIRASIM, INC. See LICENSE and NOTICE.
 *
 * `BridgeServer` — the WebSocket half: the endpoints the extension and the playwright-core
 * clients connect to, and the routing between them.
 *
 * `server-core.ts` is the other half: the lifecycle (start, the extension handshake, keepalive) and
 * the HTTP façade that makes this look like a Chrome DevTools endpoint. They are one class, in the
 * order they run: nothing here can happen before the core has an extension on the line.
 */

import http from "node:http";

import type { Duplex } from "node:stream";
import { WebSocket, type RawData } from "ws";
import { type CdpMessage } from "./model.ts";

import { BridgeServerCore, ExtensionConnection } from "./server-core.ts";
import { webSocketChannel, type ExtensionChannel } from "./extension-channel.ts";
import { parseExtensionRuntime } from './extension-updates.ts';
import { ownVersion } from "../../../entries/version.ts";

// Re-exported so callers keep importing the options shape from here.
export type { BridgeServerOptions } from "./server-core.ts";

/** How often the bridge pings the extension so the service worker stays awake. */
const KEEPALIVE_INTERVAL_MS = 20_000;
/** How long the active extension gets to answer a ping before a newcomer may take over. */
const INCUMBENT_PROBE_MS = 5_000;
/** How long a parked browser waits after the active line drops before it is let in: long enough
 *  for the SAME browser to redial (its backoff starts at 1 s), so a hiccup — a host crash, an
 *  extension reload — does not hand the bridge to the other browser. */
const STANDBY_GRACE_MS = 5_000;

/** Which host runs this bridge: the desktop app bundles it under Electron, `npx` runs it in Node. */
function bridgeIdentity(): { name: string; version: string } {
  const version = ownVersion();
  return { name: process.versions.electron ? "Mirasim" : "Computer Use", version: version === "0.0.0" ? "" : version };
}

export class BridgeServer extends BridgeServerCore {

  // ─── WebSocket endpoints ──────────────────────────────────────────────

  protected async handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const origin = req.headers.origin;
    if (url.pathname === `/extension/${this.uuid}`) {
      if (origin && !this.extensionIds.some((id) => origin === `chrome-extension://${id}`)) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attachExtension(webSocketChannel(ws)));
      return;
    }
    if (url.pathname === `/cdp/${this.uuid}`) {
      if (origin) {
        // CDP clients are local processes; a browser page has no business here.
        socket.destroy();
        return;
      }
      // Complete the handshake only once the extension is up — the client's own
      // connect timeout turns a missing extension into a clean, attributable error.
      try {
        await this.ensureExtension();
      } catch (e) {
        this.log("rejecting CDP client:", e);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attachCdpClient(ws));
      return;
    }
    socket.destroy();
  }

  /**
   * A new extension line. With none active it is taken at once. With one active, it is held until
   * its handshake names its browser session (relay.js `didConnect`, the first thing it sends):
   *
   *  - the SAME browser (a service-worker restart reconnecting), or one too old to say which → it
   *    replaces the active line, whose tab model is stale by definition;
   *  - ANOTHER browser while the active one still answers → it is PARKED: kept open, ignored.
   *    Taking it over flipped the bridge between two browsers about once a second (measured: two
   *    browsers with the extension, 56 takeovers in 60 s, each one killing every session's tab),
   *    and closing it does the same — the extension redials within a second, because a connect
   *    that reached the host resets its backoff (background.js `_adopt`). An open, ignored line is
   *    the one answer that ends its retry loop. Its tabs are never attached: attaching is the
   *    bridge's call, and nothing is sent to a parked line.
   *  - another browser while the active one does NOT answer → it takes over.
   */
  protected attachExtension(channel: ExtensionChannel): void {
    const connection = new ExtensionConnection(channel, this.log, this.warn, this.commandTimeoutMs);
    if (!this.extension) {
      this.activateExtension(connection, []);
      return;
    }
    const held: Array<[string, unknown[]]> = [];
    let decided = false;
    connection.onEvent = (method, params) => {
      held.push([method, params]);
      if (decided) return;
      if (method === "extension.connected") {
        decided = true;
        const session = typeof params[0] === "string" ? params[0] : null;
        void this.admitExtension(connection, held, session);
      }
    };
    connection.onClose = () => { this.standby.delete(connection); };
  }

  private async admitExtension(connection: ExtensionConnection, held: Array<[string, unknown[]]>, session: string | null): Promise<void> {
    const incumbent = this.extension;
    const sameOrUnknown = !session || !this.extensionSession || session === this.extensionSession;
    if (incumbent && !sameOrUnknown && await incumbent.answersWithin(INCUMBENT_PROBE_MS)) {
      // Another line became active while the probe ran: judge against that one instead.
      if (this.extension !== incumbent) return this.admitExtension(connection, held, session);
      if (!connection.isOpen) return;
      connection.onEvent = null;
      this.standby.add(connection);
      this.warn("another browser's extension connected while one is active; it waits in standby until the active browser goes");
      return;
    }
    if (connection.isOpen) this.activateExtension(connection, held);
  }

  /** Make `connection` THE extension line, replaying what it said while it was being admitted. */
  private activateExtension(connection: ExtensionConnection, held: Array<[string, unknown[]]>): void {
    const replaced = this.extension;
    this.extension = null; // the outgoing line's onClose must not release the standby browsers
    replaced?.close("Replaced by a new extension connection");
    if (replaced) this.model.onExtensionDisconnected();
    if (this.keepalive) clearInterval(this.keepalive);
    this.updates.reset();
    this.extension = connection;
    this.extensionInitialized = false;
    this.extensionSession = null;
    connection.onEvent = (method, params) => {
      if (this.extension === connection) this.onExtensionEvent(method, params);
    };
    connection.onClose = () => {
      if (this.extension !== connection) return;
      this.extension = null;
      this.extensionSession = null;
      this.updates.reset();
      this.extensionInitialized = false;
      if (this.keepalive) clearInterval(this.keepalive);
      this.keepalive = null;
      this.model.onExtensionDisconnected();
      // The active browser went: once it has had the grace to come back, let a parked one take
      // over. Closing its line is how — its extension redials within a second and, with nothing
      // active, is taken at once.
      setTimeout(() => {
        if (this.extension) return;
        for (const parked of this.standby) parked.close("The active browser left; reconnect to take over");
        this.standby.clear();
      }, STANDBY_GRACE_MS).unref?.();
    };
    for (const [method, params] of held) this.onExtensionEvent(method, params);
    this.keepalive = setInterval(() => {
      connection.send("bridge.ping", []).catch(() => {});
    }, KEEPALIVE_INTERVAL_MS);
    this.keepalive.unref?.();
  }

  private onExtensionEvent(method: string, params: unknown[]): void {
    switch (method) {
      case "chrome.tabs.onCreated": {
        // Second arg (`{ agent }`): opened FOR the agent, not handed to it; absent, the tab stays
        // unmarked and is never recycled. Only an older extension's seed tab carries it.
        const [tab, opener] = params as [{ id?: number } | undefined, { agent?: boolean } | undefined];
        this.model.onTabCreated(tab ?? {}, opener ?? {});
        break;
      }
      case "chrome.tabs.onRemoved":
        this.model.onTabRemoved((params as [number])[0]);
        break;
      case "chrome.tabs.onReplaced":
        this.model.onTabReplaced(...params as [number, number]);
        break;
      case "chrome.debugger.onEvent": {
        const [source, cdpMethod, cdpParams] = params as [{ tabId?: number; sessionId?: string }, string, unknown];
        this.model.onDebuggerEvent(source ?? {}, cdpMethod, cdpParams);
        break;
      }
      case "chrome.debugger.onDetach":
        this.model.onDebuggerDetach((params as [{ tabId?: number }])[0] ?? {});
        break;
      case "extension.connected": {
        // Opens the handshake, before any tab is announced: which browser session the tab ids
        // that follow belong to (extension/relay.js `didConnect`).
        this.extensionSession = typeof params[0] === "string" ? params[0] : null;
        this.model.onExtensionConnected((params as [string | undefined])[0]);
        break;
      }
      case "extension.initialized": {
        const runtime = parseExtensionRuntime(params[0]);
        if (runtime && !this.extensionIds.includes(runtime.id)) {
          this.extension?.close('Unexpected extension identity');
          return;
        }
        this.updates.runtime = runtime;
        this.extensionInitialized = true;
        // Who is on this end, for the extension's panel. An extension that predates the panel
        // answers "Unknown method", which is nothing to act on.
        void this.extension?.send("bridge.info", [bridgeIdentity()]).catch(() => {});
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const resolve of waiters) resolve();
        break;
      }
      case "extension.access":
        // How far the user lets the agent reach (extension/access.js), for the driver to say so.
        this.model.setAccess(params[0]);
        break;
      case 'extension.updateAvailable': {
        const version = params[0];
        if (typeof version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(version)) break;
        this.updates.updateVersion = version;
        try { this.updates.request(); } catch (e) { this.log('extension update waits for manual reload:', e); }
        break;
      }
      default:
        this.log("unknown extension event:", method);
    }
  }

  private attachCdpClient(ws: WebSocket): void {
    if (this.updates.reloading) { ws.close(1013, 'The Mirasim extension is reloading'); return; }
    const client = this.model.addClient((message) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    });
    ws.on("message", (data: RawData) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(data.toString()) as CdpMessage;
      } catch (e) {
        this.log("malformed CDP message:", e);
        return;
      }
      void (async () => {
        const { id, sessionId, method, params } = message;
        if (method === "Page.getFrameTree" && id !== undefined && sessionId)
          client.trackFrameTree(id, sessionId);
        try {
          const result = await this.runOperation(() => this.model.handleCommand(client, method ?? "", params, sessionId));
          client.send({ id, sessionId, result });
        } catch (e) {
          client.send({ id, sessionId, error: { message: e instanceof Error ? e.message : String(e) } });
        }
      })();
    });
    ws.on("close", () => this.model.removeClient(client));
    ws.on("error", () => this.model.removeClient(client));
  }
}
