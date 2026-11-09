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
import { AccessError } from "./access.js";

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

/** What a paused agent may still do: stay connected, let go of what it holds, and list the tabs it
 *  may use (still filtered by the scope), so it can tell a pause from tabs that went away. */
const ALLOWED_WHILE_PAUSED = new Set(["bridge.ping", "bridge.reload", "bridge.releaseTab", "bridge.info", "chrome.debugger.detach",
  "chrome.tabs.query", "chrome.debugger.getTargets"]);

/** Cookie reads whose answer is filtered by the site rules (`cookies` in the result). */
const COOKIE_READS = new Set(["Network.getAllCookies", "Network.getCookies", "Storage.getCookies"]);
/** Cookie writes checked cookie by cookie (`cookies` in the params). */
const COOKIE_WRITES = new Set(["Network.setCookies", "Storage.setCookies"]);
/** Commands that wipe every site's cookies at once, the blocked ones included. */
const COOKIE_WIPES = new Set(["Network.clearBrowserCookies", "Storage.clearCookies"]);

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
    /** Tabs the bridge has been told about (`attachTab`, a forwarded popup) and not told to forget. */
    this._announced = new Set();
    /**
     * Tabs taken away from the agent (a blocked site, out of scope), with why: from the moment
     * this is set no command reaches them and no event leaves them, before the asynchronous
     * detach has even started.
     * @type {Map<number, {reason: string, url?: string}>}
     */
    this._revoked = new Map();
    /** A tab's child sessions (out-of-process iframes, workers): sessionId → targetId. */
    this._childTargets = new Map();
    /** Child sessions on a blocked site: nothing goes in or out. */
    this._blockedSessions = new Set();
    /** What the bridge said about itself (`bridge.info`); null from a bridge that predates it. */
    this.bridgeInfo = null;
    /**
     * Who decides what the agent may reach (group.js), asked before every tab is listed,
     * attached or driven. Absent, nothing is refused — a test seam, never the product.
     * @type {{policy: import("./access.js").AccessPolicy, visible(tab: chrome.tabs.Tab): boolean, authorizeAttach(tabId: number): Promise<void>, noteCreated?(tab: chrome.tabs.Tab): void} | undefined}
     */
    this.gate = undefined;

    /** @type {(() => void) | undefined} */
    this.onclose = undefined;
    /** @type {((tabId: number) => void) | undefined} */
    this.ontabattached = undefined;
    /** @type {((tabId: number) => void) | undefined} */
    this.ontabdetached = undefined;
    /** A tab the bridge created (`Target.createTarget`): the agent's by definition.
     *  @type {((tabId: number) => void) | undefined} */
    this.ontabcreatedforagent = undefined;

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

  /** Tell the bridge how far the user lets the agent reach, so it can say so when it lists
   *  tabs. A bridge that predates this logs an unknown event and carries on. */
  reportAccess(access) {
    if (!this._closed) this._send({ method: "extension.access", params: [access] });
  }

  isAnnounced(tabId) {
    return this._announced.has(tabId);
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
    if (this.gate && !this.gate.visible(tab)) return;
    this._revoked.delete(tab.id);
    this._announced.add(tab.id);
    this._send({ method: "chrome.tabs.onCreated", params: [tab, { agent: false }] });
  }

  /**
   * Take a tab away from the agent: detach it, and unless `keepListed` (the pause), make the
   * bridge forget it as if it had closed (it is no longer the agent's to see). Commands to it are
   * refused from this call on, with `reason` (access.js `refusal`), until it is attached or
   * announced again.
   */
  revoke(tabId, reason, { url, keepListed = false } = {}) {
    if (this._closed) return;
    this._revoked.set(tabId, { reason, url });
    this._pendingReattach.delete(tabId);
    if (this._attachedTabs.has(tabId)) {
      chrome.debugger.detach({ tabId }).catch(() => {});
      this._notifyDetached(tabId);
      this._send({ method: "chrome.debugger.onDetach", params: [{ tabId }, "target_closed"] });
    }
    for (const [sessionId, child] of this._childTargets) if (child.tabId === tabId) this._forgetChild(sessionId);
    if (!keepListed && this._announced.delete(tabId)) this._send({ method: "chrome.tabs.onRemoved", params: [tabId, { revoked: true }] });
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
    this._announced.clear();
    this._childTargets.clear();
    this._blockedSessions.clear();
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
    if (fullMethod === "chrome.debugger.onEvent" && !this._passesEvent(args)) return;
    if (fullMethod === "chrome.tabs.onCreated") {
      // A popup of a tab the agent drives: in scope as its opener is, and announced like one.
      if (this._revoked.has(tabId)) return;
      this.gate?.noteCreated?.(args[0]);
      if (this.gate && !this.gate.visible(args[0])) return;
      if (args[0]?.id !== undefined) this._announced.add(args[0].id);
    }
    if (fullMethod === "chrome.tabs.onRemoved" || fullMethod === "chrome.tabs.onReplaced") {
      const gone = fullMethod === "chrome.tabs.onRemoved" ? args[0] : args[1];
      this._announced.delete(gone);
      this._revoked.delete(gone);
    }
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

  /**
   * Does a debugger event leave for the bridge? Not from a revoked tab or a blocked child
   * session, and a navigation onto a blocked site is where the tab (or the iframe) is taken
   * away: the event that says what the page now is never reaches the agent.
   */
  _passesEvent([source, method, params]) {
    const tabId = source?.tabId;
    if (this._revoked.has(tabId)) return false;
    if (source?.sessionId && this._blockedSessions.has(source.sessionId)) return false;
    const policy = this.gate?.policy;
    if (!policy) return true;
    if (method === "Target.attachedToTarget") {
      const verdict = policy.siteVerdict(params?.targetInfo?.url);
      if (params?.sessionId) this._childTargets.set(params.sessionId, { tabId, targetId: params?.targetInfo?.targetId, forwarded: !verdict });
      if (verdict) {
        this._blockChild(tabId, params.sessionId, verdict, params.targetInfo.url);
        return false;
      }
      return true;
    }
    if (method === "Target.detachedFromTarget") {
      const child = params?.sessionId ? this._childTargets.get(params.sessionId) : undefined;
      if (params?.sessionId) this._forgetChild(params.sessionId);
      // The bridge hears of a child's end only if it heard of the child.
      return child?.forwarded ?? true;
    }
    if (method === "Page.frameNavigated") {
      const frame = params?.frame;
      const verdict = policy.siteVerdict(frame?.url);
      if (!verdict) return true;
      if (!source?.sessionId && !frame?.parentId) {
        policy.record({ reason: verdict, tabId, url: frame.url });
        this.revoke(tabId, verdict, { url: frame.url });
        this.ontabrevoked?.(tabId);
        return false;
      }
      const child = source?.sessionId ? this._childTargets.get(source.sessionId) : undefined;
      if (child && (frame.id === child.targetId || !frame.parentId)) {
        this._blockChild(tabId, source.sessionId, verdict, frame.url);
        return false;
      }
    }
    return true;
  }

  /** An iframe or worker on a blocked site: let it run (it may be paused waiting for a
   *  debugger), then let go of it, so the page works and the agent never sees inside it. */
  _blockChild(tabId, sessionId, reason, url) {
    if (!sessionId || this._blockedSessions.has(sessionId)) return;
    this._blockedSessions.add(sessionId);
    this.gate?.policy.record({ reason, tabId, url, detail: "frame" });
    void chrome.debugger.sendCommand({ tabId, sessionId }, "Runtime.runIfWaitingForDebugger").catch(() => {})
      .then(() => chrome.debugger.sendCommand({ tabId }, "Target.detachFromTarget", { sessionId }).catch(() => {}));
  }

  _forgetChild(sessionId) {
    this._childTargets.delete(sessionId);
    this._blockedSessions.delete(sessionId);
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
    if (message.method === "bridge.info") {
      const info = (message.params ?? [])[0];
      this.bridgeInfo = info && typeof info === "object" ? { name: String(info.name ?? ""), version: String(info.version ?? "") } : null;
      this.onbridgeinfo?.();
      return {};
    }
    if (!ALLOWED_COMMANDS.has(message.method)) throw new Error(`Unknown method: ${message.method}`);
    const args = message.params ?? [];
    const policy = this.gate?.policy;
    if (policy?.paused && !ALLOWED_WHILE_PAUSED.has(message.method)) {
      policy.record({ reason: "paused" });
      throw new AccessError("paused");
    }
    if (this.gate) return await this._gatedCommand(message.method, args);
    return await this._runCommand(message.method, args);
  }

  /** Every chrome.* command, held against the user's access settings first (access.js). */
  async _gatedCommand(method, args) {
    const { policy } = this.gate;
    switch (method) {
      case "chrome.tabs.query": {
        const tabs = (await this._runCommand(method, args)) ?? [];
        return Array.isArray(tabs) ? tabs.filter((tab) => this.gate.visible(tab)) : tabs;
      }
      case "chrome.debugger.getTargets": {
        const visible = new Set((await chrome.tabs.query({})).filter((tab) => this.gate.visible(tab)).map((tab) => tab.id));
        const targets = (await this._runCommand(method, args)) ?? [];
        return targets.filter((t) => t.tabId !== undefined && visible.has(t.tabId));
      }
      case "chrome.debugger.attach": {
        const tabId = args[0]?.tabId;
        await this.gate.authorizeAttach(tabId);
        this._revoked.delete(tabId);
        return await this._runCommand(method, args);
      }
      case "chrome.debugger.sendCommand":
        return await this._gatedCdp(args);
      case "chrome.tabs.create": {
        const url = args[0]?.url;
        const verdict = policy.siteVerdict(url);
        if (verdict) {
          policy.record({ reason: verdict, url });
          throw new AccessError(verdict, { url });
        }
        return await this._runCommand(method, args);
      }
      case "chrome.tabs.remove":
      case "chrome.tabs.reload": {
        const ids = Array.isArray(args[0]) ? args[0] : [args[0]];
        for (const tabId of ids) {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (tab && !this.gate.visible(tab)) {
            policy.record({ reason: "out-of-scope", tabId });
            throw new AccessError("out-of-scope", { tabId });
          }
        }
        return await this._runCommand(method, args);
      }
      case "chrome.downloads.search": {
        const items = await searchDownloads(args[0]);
        return items.filter((item) => !policy.siteVerdict(item.finalUrl || item.url) && !policy.siteVerdict(item.referrer));
      }
      default:
        return await this._runCommand(method, args);
    }
  }

  /** A CDP command for a tab (or one of its child sessions), held against the site rules. */
  async _gatedCdp(args) {
    const { policy } = this.gate;
    const [debuggee, cdpMethod, params] = args;
    const tabId = debuggee?.tabId;
    const revoked = this._revoked.get(tabId);
    if (revoked) throw new AccessError(revoked.reason, { tabId, url: revoked.url });
    if (debuggee?.sessionId && this._blockedSessions.has(debuggee.sessionId)) throw new AccessError("site-blocked", { url: "this frame's site" });
    const refuse = (reason, details = {}) => {
      policy.record({ reason, tabId, ...details });
      throw new AccessError(reason, { tabId, ...details });
    };
    if (cdpMethod === "Page.navigate") {
      const verdict = policy.siteVerdict(params?.url);
      if (verdict) refuse(verdict, { url: params.url });
    }
    if (COOKIE_WIPES.has(cdpMethod) && policy.restrictive()) refuse("clear-cookies");
    if (COOKIE_WRITES.has(cdpMethod)) {
      for (const cookie of params?.cookies ?? []) {
        const domain = cookie?.domain || hostFromUrl(cookie?.url);
        if (!policy.cookieAllowed(domain)) refuse("cookie-site", { url: domain });
      }
    }
    if (cdpMethod === "Network.setCookie" || cdpMethod === "Network.deleteCookies") {
      const domain = params?.domain || hostFromUrl(params?.url);
      if (!policy.cookieAllowed(domain)) refuse("cookie-site", { url: domain });
    }
    if (cdpMethod === "Storage.clearDataForOrigin" || cdpMethod === "Storage.clearDataForStorageKey") {
      const origin = params?.origin ?? params?.storageKey;
      const verdict = policy.siteVerdict(origin);
      if (verdict) refuse(verdict, { url: origin });
    }
    const result = await this._runCommand("chrome.debugger.sendCommand", args);
    if (COOKIE_READS.has(cdpMethod) && Array.isArray(result?.cookies))
      return { ...result, cookies: result.cookies.filter((c) => policy.cookieAllowed(c.domain)) };
    return result;
  }

  /** Run one allow-listed chrome.* command as asked, with the attach bookkeeping. */
  async _runCommand(method, args) {
    if (method === "chrome.debugger.attach") {
      const target = args[0];
      // A zombie attach from a previous service-worker life throws "Another debugger is
      // already attached" against ourselves. Clearing our own leftover is safe; a REAL
      // other debugger (devtools) re-throws on the second try and that error is honest.
      try {
        await invokeChromeMethod(method, args);
      } catch (e) {
        if (!String(e?.message).includes("already attached")) throw e;
        await chrome.debugger.detach({ tabId: target?.tabId }).catch(() => {});
        await invokeChromeMethod(method, args);
      }
      if (target?.tabId !== undefined) this._notifyAttached(target.tabId);
      return {};
    }
    if (method === "chrome.downloads.search") return await searchDownloads(args[0]);
    const result = await invokeChromeMethod(method, args);
    // Said before the reply leaves: the bridge attaches the tab only once it has the reply.
    if (method === "chrome.tabs.create" && result?.id !== undefined) {
      this.ontabcreatedforagent?.(result.id);
      this._announced.add(result.id);
    }
    return result ?? {};
  }

  _send(message) {
    this._transport.send(message);
  }
}

/**
 * The one use of the `downloads` permission: the agent's download verb asks which files the
 * browser saved since it started waiting, and where (bridge `Mirasim.downloads`). Called by name
 * rather than through the reflective path below, so the permission's use is plain to read —
 * the Web Store rejected 0.1.3 as "requests but does not use downloads" when it was not.
 * @returns {Promise<chrome.downloads.DownloadItem[]>}
 */
async function searchDownloads(query) {
  const { startedAfter, startedBefore } = query && typeof query === "object" ? query : {};
  return await chrome.downloads.search({
    ...(typeof startedAfter === "string" ? { startedAfter } : {}),
    ...(typeof startedBefore === "string" ? { startedBefore } : {}),
  });
}

function hostFromUrl(url) {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
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
