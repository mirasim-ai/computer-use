/**
 * Portions Copyright (c) Microsoft Corporation (Playwright), licensed under the Apache License,
 * Version 2.0; modified by MIRASIM, INC. See LICENSE and NOTICE.
 *
 * WebSocket connection to the local mirasim bridge.
 *
 * Deliberately dumb: it executes an allow-list of chrome.* commands sent by the
 * bridge (positional params spread into the call) and forwards the matching
 * chrome.* events back. All CDP/tab-model logic lives in the bridge process,
 * where it is testable; the extension is a hand, not a brain.
 *
 * Mechanism adapted from Microsoft Playwright's browser extension
 * (packages/extension, Apache-2.0) — same wire shape, so the failure modes
 * that implementation already paid for (navigation-detach reattach, drag
 * bookkeeping, service-worker keepalive) stay solved.
 */

import { RUNTIME_INFO } from "./runtime-info.js";

export function debugLog(...args) {
  // eslint-disable-next-line no-console
  console.log("[mirasim-bridge]", ...args);
}

/** chrome.* calls the bridge may invoke — anything else is rejected. */
const ALLOWED_COMMANDS = new Set([
  "chrome.debugger.attach",
  "chrome.debugger.detach",
  "chrome.debugger.sendCommand",
  "chrome.debugger.getTargets",
  "chrome.tabs.create",
  "chrome.tabs.remove",
  "chrome.tabs.query",
  "chrome.tabs.reload",
  "chrome.downloads.search",
]);

/** chrome.* events forwarded to the bridge (positional args, as the listener got them). */
const FORWARDED_EVENTS = [
  "chrome.debugger.onEvent",
  "chrome.debugger.onDetach",
  "chrome.tabs.onCreated",
  "chrome.tabs.onRemoved",
  "chrome.tabs.onReplaced",
];

/** How soon after a navigation-caused detach we try to re-attach. */
const REATTACH_DELAY_MS = 150;
/** How long we wait for the re-attach to stick before giving up on the tab. */
const REATTACH_VERIFY_MS = 2500;
/** A tab that re-detaches within this window is not fought over again. */
const REATTACH_COOLDOWN_MS = 3000;

/**
 * How long the bridge may say NOTHING before this connection is presumed dead: three missed
 * pings, since the bridge pings every 20s even when idle (`server.ts` KEEPALIVE_INTERVAL_MS).
 *
 * The only way to notice a peer that is still there but not moving (a host stopped by the OS, a
 * machine resumed from sleep, a wedged event loop): the port stays open, every flag reads
 * "connected", and each command dies on its own 30s timeout.
 */
const SILENCE_TIMEOUT_MS = 60_000;
/** Cheap enough to run on a live connection; fine-grained enough that the verdict lands
 *  within a ping of the deadline. */
const SILENCE_CHECK_MS = 15_000;

export class RelayConnection {
  /** @param {import("./transport.js").Transport} transport — native port or ws, same messages */
  constructor(transport) {
    this._transport = transport;
    /** Tabs whose debugger this connection holds. */
    this._attachedTabs = new Set();
    this._eventListeners = [];
    this._closed = false;
    this._pendingReattach = new Set();
    this._recentReattach = new Set();

    /** @type {(() => void) | undefined} */
    this.onclose = undefined;
    /** @type {((tabId: number) => void) | undefined} */
    this.ontabattached = undefined;
    /** @type {((tabId: number) => void) | undefined} */
    this.ontabdetached = undefined;

    this._lastInbound = Date.now();
    this._inflightCommands = 0;
    this._reloading = false;
    this._silenceTimer = setInterval(() => this._checkSilence(), SILENCE_CHECK_MS);

    this._installEventForwarders();
    this._transport.onmessage = (message) => void this._onMessage(message);
    this._transport.onclose = () => this._onClose();
  }

  /** Nothing from the bridge for {@link SILENCE_TIMEOUT_MS}: drop the line so the worker's
   *  reconnect loop can build a new one. Closing is safe — a bridge that IS alive answers the
   *  next connection, and the tab group survives a reconnect. */
  _checkSilence() {
    if (this._closed) return;
    const quiet = Date.now() - this._lastInbound;
    if (quiet < SILENCE_TIMEOUT_MS) return;
    debugLog(`bridge silent for ${Math.round(quiet / 1000)}s — treating the connection as dead`);
    this.close("Bridge stopped answering");
  }

  /** Which pipe this connection runs on — 'native' or 'ws'. */
  get transportKind() {
    return this._transport.kind;
  }

  get attachedTabs() {
    return this._attachedTabs;
  }

  /** Opens the handshake by saying WHICH browser session the tab ids that follow belong to
   *  (the nonce from group.js `browserSessionId`); the bridge decides what to do with it.
   *
   *  It must come BEFORE the first `attachTab`: the bridge drops what it remembers about a
   *  session it cannot recognise, so a tab announced ahead of the nonce would be forgotten. A
   *  bridge that predates this logs it as an unknown event and carries on. */
  didConnect(browserSession) {
    this._send({ method: "extension.connected", params: [browserSession] });
  }

  /** Ends the initial handshake: the bridge holds client CDP traffic until this arrives,
   *  so `Target.setAutoAttach` is always answered from a populated tab model. */
  didInitialize() {
    this._send({ method: "extension.initialized", params: [RUNTIME_INFO] });
  }

  updateAvailable(version) {
    this._send({ method: "extension.updateAvailable", params: [version] });
  }

  close(reason) {
    this._transport.close(reason);
    // ws.onclose fires asynchronously; run the bookkeeping now so no CDP event
    // is forwarded to a connection we already decided is gone.
    this._onClose();
  }

  /** Announce a tab to the bridge as if it had just been created; the bridge responds by
   *  attaching the debugger, which flows back through the command channel.
   *
   *  Always `{ agent: false }`: tabs the agent opens are created by the bridge, which marks
   *  them itself (`createTarget`). */
  attachTab(tab) {
    if (this._closed || (this._attachedTabs.has(tab.id) && !tab.discarded && tab.status !== "unloaded")) return;
    this._send({ method: "chrome.tabs.onCreated", params: [tab, { agent: false }] });
  }

  /** Detach a tab the user dragged out of the group. chrome.debugger.detach does not fire
   *  onDetach for the caller, so the event the bridge needs is synthesized. */
  detachTab(tabId) {
    if (this._closed || !this._attachedTabs.has(tabId)) return;
    chrome.debugger.detach({ tabId }).catch((e) => debugLog("detach failed:", e));
    this._notifyDetached(tabId);
    this._send({ method: "chrome.debugger.onDetach", params: [{ tabId }, "target_closed"] });
  }

  /**
   * Release a tab the bridge is done with (its last CDP client went away), WITHOUT
   * telling the bridge — it already knows; it asked.
   *
   * The detach is the point: one debugger session per tab is shared by every client, so a later
   * client's `Runtime.enable` lands on an already-enabled domain, Chrome replays no execution
   * contexts, and its `evaluate` hangs forever. A fresh attach brings the replay back. The tab
   * keeps its group membership.
   */
  releaseTab(tabId) {
    if (this._closed) return;
    chrome.debugger.detach({ tabId }).catch(() => {}); // already gone is the good case
    if (this._attachedTabs.has(tabId)) this._notifyDetached(tabId);
    this._pendingReattach.delete(tabId);
  }

  _notifyAttached(tabId) {
    this._attachedTabs.add(tabId);
    this._pendingReattach.delete(tabId);
    this.ontabattached?.(tabId);
  }

  _notifyDetached(tabId) {
    this._attachedTabs.delete(tabId);
    this.ontabdetached?.(tabId);
  }

  _installEventForwarders() {
    for (const fullMethod of FORWARDED_EVENTS) {
      const target = resolveChromeMember(fullMethod);
      const listener = (...args) => this._onChromeEvent(fullMethod, args);
      target.obj[target.name].addListener(listener);
      this._eventListeners.push(() => target.obj[target.name].removeListener(listener));
    }
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._silenceTimer);
    this._pendingReattach.clear();
    this._recentReattach.clear();
    for (const remove of this._eventListeners) remove();
    this._eventListeners = [];
    for (const tabId of [...this._attachedTabs]) {
      chrome.debugger.detach({ tabId }).catch(() => {});
      this._notifyDetached(tabId);
    }
    this.onclose?.();
  }


  /** Forward chrome.* events that concern attached tabs; run detach bookkeeping. */
  _onChromeEvent(fullMethod, args) {
    const tabId = this._tabIdForEvent(fullMethod, args);
    if (tabId === undefined) return;
    if (!this._attachedTabs.has(tabId) && !this._forwardsWhenDetached(fullMethod)) return;
    this._send({ method: fullMethod, params: args });
    if (fullMethod === "chrome.debugger.onDetach") {
      const reason = args[1];
      this._notifyDetached(tabId);
      // A cross-process navigation detaches the debugger with `target_closed` even though
      // the tab lives on. Re-attach after a beat; a tab that detaches again immediately is
      // left alone (something else owns it).
      if (reason === "target_closed" && this._maybeScheduleReattach(tabId)) return;
    } else if (fullMethod === "chrome.tabs.onReplaced") {
      this._notifyDetached(tabId);
    }
  }

  _maybeScheduleReattach(tabId) {
    if (this._closed) return false;
    if (this._recentReattach.has(tabId)) return false;
    this._recentReattach.add(tabId);
    setTimeout(() => this._recentReattach.delete(tabId), REATTACH_COOLDOWN_MS);
    this._pendingReattach.add(tabId);
    setTimeout(() => void this._tryReattach(tabId), REATTACH_DELAY_MS);
    return true;
  }

  async _tryReattach(tabId) {
    if (this._closed || !this._pendingReattach.has(tabId)) return;
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      this._pendingReattach.delete(tabId);
      return;
    }
    if (this._closed || !this._pendingReattach.has(tabId)) return;
    if (this._attachedTabs.has(tabId)) {
      this._pendingReattach.delete(tabId);
      return;
    }
    this.attachTab(tab);
    setTimeout(() => {
      if (this._closed || !this._pendingReattach.has(tabId)) return;
      this._pendingReattach.delete(tabId);
      if (!this._attachedTabs.has(tabId)) debugLog("gave up re-attaching tab", tabId);
    }, REATTACH_VERIFY_MS);
  }

  _tabIdForEvent(fullMethod, args) {
    switch (fullMethod) {
      case "chrome.debugger.onEvent":
      case "chrome.debugger.onDetach":
        return args[0]?.tabId;
      case "chrome.tabs.onCreated":
        // Only popups opened by an attached tab are the bridge's business.
        return args[0]?.openerTabId;
      case "chrome.tabs.onRemoved":
        return args[0];
      case "chrome.tabs.onReplaced":
        return args[1]; // removed id; Chrome assigns a new id when discarding a tab
      default:
        return undefined;
    }
  }

  /** Does this event still concern the bridge even though we hold no debugger for the tab?
   *  Closures do: a tab released between tasks is still one the bridge lists and may hand to
   *  the next client, and a client handed a closed tab waits on a renderer that is gone. */
  _forwardsWhenDetached(fullMethod) {
    return fullMethod === "chrome.tabs.onRemoved" || fullMethod === "chrome.tabs.onReplaced";
  }

  async _onMessage(message) {
    this._lastInbound = Date.now();
    this._inflightCommands += 1;
    const response = { id: message.id };
    try {
      response.result = await this._handleCommand(message);
    } catch (e) {
      response.error = e?.message ?? String(e);
    } finally {
      this._inflightCommands -= 1;
    }
    this._send(response);
  }

  async _handleCommand(message) {
    if (this._reloading) throw new Error("The Mirasim extension is reloading; reconnect before continuing.");
    if (message.method === "bridge.reload") {
      // The bridge also waits for all CDP clients, including clients between tool calls.
      // This last guard protects against commands or attachments that have not drained yet.
      if (this._inflightCommands !== 1 || this._attachedTabs.size) throw new Error("The Mirasim extension is busy; finish the browser task before reloading.");
      this._reloading = true;
      setTimeout(() => chrome.runtime.reload(), 100); // send the receipt before closing the port
      return { scheduled: true };
    }
    // Application-level keepalive: receiving and answering it resets the MV3
    // service-worker idle timer in both directions.
    if (message.method === "bridge.ping") return {};
    if (message.method === "bridge.releaseTab") {
      this.releaseTab((message.params ?? [])[0]);
      return {};
    }
    if (!ALLOWED_COMMANDS.has(message.method)) throw new Error(`Unknown method: ${message.method}`);
    const args = message.params ?? [];
    if (message.method === "chrome.debugger.attach") {
      const target = args[0];
      // A zombie attach from a previous service-worker life throws "Another debugger is
      // already attached" against ourselves. Clearing our own leftover is safe; a REAL
      // other debugger (devtools) re-throws on the second try and that error is honest.
      try {
        await invokeChromeMethod(message.method, args);
      } catch (e) {
        if (!String(e?.message).includes("already attached")) throw e;
        await chrome.debugger.detach({ tabId: target?.tabId }).catch(() => {});
        await invokeChromeMethod(message.method, args);
      }
      if (target?.tabId !== undefined) this._notifyAttached(target.tabId);
      return {};
    }
    const result = await invokeChromeMethod(message.method, args);
    return result ?? {};
  }

  _send(message) {
    this._transport.send(message);
  }
}

/** Resolve chrome.<api>.<member> for reflective invocation and listener setup. */
function resolveChromeMember(fullMethod) {
  const parts = fullMethod.split(".");
  if (parts[0] !== "chrome" || parts.length < 3) throw new Error(`Invalid chrome method: ${fullMethod}`);
  let obj = chrome;
  for (let i = 1; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
    if (obj === undefined) throw new Error(`Unknown chrome path in ${fullMethod}`);
  }
  return { obj, name: parts[parts.length - 1] };
}

async function invokeChromeMethod(fullMethod, args) {
  const { obj, name } = resolveChromeMember(fullMethod);
  const fn = obj[name];
  if (typeof fn !== "function") throw new Error(`Not a function: ${fullMethod}`);
  return await fn.apply(obj, args);
}
