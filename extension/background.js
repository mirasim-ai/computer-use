/**
 * Service worker: owns the single active bridge connection.
 *
 * ONE way in: **native messaging**. `chrome.runtime.connectNative` makes Chrome spawn mirasim's
 * host, which pumps into the running bridge. No address is handed over, so nothing expires —
 * after a browser restart, a mirasim update or a worker eviction this worker just dials again.
 * An open port also keeps the worker alive.
 *
 * The **connect page** (`bridge.connect` below, over a one-shot `ws://127.0.0.1/…` relay) is NOT
 * a product path: its relay uuid is minted per bridge process, so every restart would need a
 * human click. Mirasim never opens it; it is the seam end-to-end tests use in a throwaway
 * Chromium with no native-host manifest.
 *
 * One bridge at a time: a new connection replaces the old.
 *
 * Reconnect policy: probe with ping/pong, tell "host not installed" from "host went away" by the
 * lastError text and stop fast retries on the former, back off 1s→30s on the latter, and arm a
 * `chrome.alarms` alongside the timer because an evicted worker takes its timers with it.
 */

import { RelayConnection, debugLog } from "./relay.js";
import { MirasimTabGroup } from "./group.js";
import { nativeTransport, webSocketTransport } from "./transport.js";

const CONNECT_TIMEOUT_MS = 10_000;
/** How long the native probe waits for `pong` before calling the route dead. */
const PROBE_TIMEOUT_MS = 10_000;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const RECONNECT_ALARM = "mirasim-bridge-reconnect";
/** How often to look again once every candidate said "not installed". Never NEVER: a user who
 *  installs mirasim while Chrome is open would wait for a browser restart. Not slow either: this
 *  recheck IS the time-to-first-connection after loading the extension, and one wake a minute
 *  is what the heartbeat already costs. */
const ABSENT_RECHECK_MINUTES = 1;
/**
 * The heartbeat, armed even while CONNECTED. A closed native port lets the worker terminate
 * (Chrome docs), so when the bridge's host exits the worker can die with it: no `onDisconnect`
 * runs and no timer survives. Only this alarm wakes it to reconnect; the handler returns early
 * while a connection exists.
 */
const HEARTBEAT_MINUTES = 1;

/**
 * Host names, in the order they are tried. The installed app owns the first; a dev instance
 * writes the second, so the two can coexist on one machine without fighting over one manifest
 * (the shape OpenAI's extension uses for its own `.dev` host).
 */
const HOST_CANDIDATES = ["ai.mirasim.browser_bridge", "ai.mirasim.browser_bridge.dev"];

/** Chrome's way of saying the manifest is missing or policy forbids it — as opposed to a host
 *  that started and then went away. The first means retrying forever is pointless. */
const ABSENT_RE = /native messaging host not found|native messaging host is forbidden|not found|forbidden/i;

class BridgeExtension {
  constructor() {
    this._activeGroup = null;
    /** Transport of the active connection, for the status reply. */
    this._transport = null;
    /** Set once every candidate answered "not installed" — stops the retry loop until
     *  something changes (a new install, or the user's explicit connect). */
    this._hostAbsent = false;
    this._connecting = false;
    this._attempt = 0;
    this._timer = null;
    this._lastError = null;
    this._updateVersion = null;
    chrome.runtime.onUpdateAvailable.addListener(({ version }) => {
      this._updateVersion = version;
      if (this._activeGroup) this._activeGroup.updateAvailable(version);
      else if (!this._connecting) chrome.runtime.reload();
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Promise-based responses are not supported by Chrome; return true when async.
      switch (message?.type) {
        case "bridge.connect":
          this._connectWs(message.relayUrl, sender).then(
            () => sendResponse({ success: true }),
            (e) => sendResponse({ success: false, error: e?.message ?? String(e) }),
          );
          return true;
        case "bridge.status":
          sendResponse({
            connected: !!this._activeGroup,
            transport: this._transport,
            hostAbsent: this._hostAbsent,
            reconnectAttempt: this._attempt,
            error: this._lastError,
            tabIds: this._activeGroup?.connectedTabIds() ?? [],
          });
          return false;
        default:
          return false;
      }
    });

    // An alarm survives worker eviction; the timer does not. Both land here.
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== RECONNECT_ALARM) return;
      if (this._activeGroup) return; // connected: the heartbeat has nothing to do
      // Drop the absent flag first, or `_connectNative` returns at once and never rechecks.
      this._hostAbsent = false;
      void this._connectNative();
    });
    chrome.runtime.onStartup.addListener(() => void this._connectNative());
    chrome.runtime.onInstalled.addListener(() => void this._connectNative());
    // Worker start IS the reconnect trigger: eviction plus any event wakes us right back up.
    void this._connectNative();
  }

  // ─── native messaging ────────────────────────────────────────────────────

  /** Try each host in turn; keep the first that answers `pong`. */
  async _connectNative() {
    if (this._activeGroup || this._connecting || this._hostAbsent) return;
    this._connecting = true;
    let everyCandidateAbsent = true;
    try {
      for (const name of HOST_CANDIDATES) {
        const port = await this._probe(name);
        if (port === "absent") continue;
        everyCandidateAbsent = false;
        if (!port) continue;
        await this._adopt(new RelayConnection(nativeTransport(port)), "native");
        debugLog("bridge connected over native messaging:", name);
        return;
      }
    } catch (e) {
      this._lastError = e?.message ?? String(e);
      debugLog("native connect failed:", e);
    } finally {
      this._connecting = false;
    }
    if (everyCandidateAbsent) {
      // No manifest anywhere, or policy says no: stop the fast retries but keep a slow alarm,
      // the only thing that survives worker eviction to notice an install.
      this._hostAbsent = true;
      if (this._timer) clearTimeout(this._timer);
      this._timer = null;
      this._armAlarm(ABSENT_RECHECK_MINUTES);
      debugLog(`no native host installed; rechecking every ${ABSENT_RECHECK_MINUTES}min, fallback path meanwhile`);
      return;
    }
    this._scheduleRetry();
  }

  /**
   * Connect one candidate and ask it whether the whole route is alive.
   *
   * The host answers `pong` only once it has the bridge's socket, so a pong means mirasim is
   * running and reachable — not merely that a binary exists. Returns the port on success,
   * `"absent"` when Chrome says the host is not installed/forbidden, else null.
   */
  _probe(name) {
    return new Promise((resolve) => {
      let port;
      try {
        port = chrome.runtime.connectNative(name);
      } catch (e) {
        resolve(ABSENT_RE.test(e?.message ?? "") ? "absent" : null);
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        port.onDisconnect.removeListener(onDisconnect);
        port.onMessage.removeListener(onMessage);
        if (value !== port) {
          try {
            port.disconnect();
          } catch {
            /* already gone */
          }
        }
        resolve(value);
      };
      const onDisconnect = () => {
        const message = chrome.runtime.lastError?.message ?? "";
        this._lastError = message || "native host disconnected";
        finish(ABSENT_RE.test(message) ? "absent" : null);
      };
      const onMessage = (msg) => {
        if (msg?.type === "pong") finish(port);
      };
      port.onDisconnect.addListener(onDisconnect);
      port.onMessage.addListener(onMessage);
      const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
      try {
        port.postMessage({ type: "ping" });
      } catch {
        finish(null);
      }
    });
  }

  _scheduleRetry() {
    this._attempt += 1;
    const delay = Math.min(BACKOFF_FIRST_MS * 2 ** (this._attempt - 1), BACKOFF_MAX_MS);
    this._clearRetry();
    this._timer = setTimeout(() => void this._connectNative(), delay);
    // Alarms are minute-grained, so this is the floor, not the schedule: the timer wins while
    // the worker lives and the alarm is what picks up after an eviction.
    this._armAlarm(HEARTBEAT_MINUTES);
    debugLog(`native reconnect in ${delay}ms (attempt ${this._attempt})`);
  }

  /** Idempotent enough for our purposes: creating an existing alarm replaces it. */
  _armAlarm(minutes) {
    chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
  }

  /** Stop the FAST retries only. The alarm is never cleared here — see HEARTBEAT_MINUTES. */
  _clearRetry() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  // ─── the connect page (TEST SEAM — see the file header) ──────────────────

  async _connectWs(relayUrl, sender) {
    if (typeof relayUrl !== "string" || !/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(relayUrl))
      throw new Error("Refusing non-local relay URL");
    const ws = await this._openWebSocket(relayUrl);
    await this._adopt(new RelayConnection(webSocketTransport(ws)), "ws");
    debugLog("bridge connected:", relayUrl);
    // A user who went through the page has told us the host is worth looking for again.
    this._hostAbsent = false;

    // The connect page did its one job; close it so nothing flashes longer than it must.
    const senderTabId = sender?.tab?.id;
    if (senderTabId !== undefined) await chrome.tabs.remove(senderTabId).catch(() => {});
  }

  _openWebSocket(relayUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out connecting to the mirasim bridge"));
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Could not reach the mirasim bridge (is mirasim running?)"));
      };
    });
  }

  // ─── whichever transport won ─────────────────────────────────────────────

  async _adopt(connection, transport) {
    this._activeGroup?.close("Replaced by a new bridge connection");
    this._activeGroup = null;
    const group = new MirasimTabGroup(connection);
    group.onclose = () => {
      if (this._activeGroup !== group) return;
      this._activeGroup = null;
      this._transport = null;
      // Native reconnects on its own; the ws path needs a new hand-over.
      if (transport === "native") this._scheduleRetry();
    };
    this._activeGroup = group;
    this._transport = transport;
    this._attempt = 0;
    this._lastError = null;
    this._clearRetry();
    // Armed WHILE connected, deliberately — see HEARTBEAT_MINUTES.
    this._armAlarm(HEARTBEAT_MINUTES);
    await group.ready;
    if (this._updateVersion) group.updateAvailable(this._updateVersion);
  }
}

new BridgeExtension();
