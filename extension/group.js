/**
 * Portions Copyright (c) Microsoft Corporation (Playwright), licensed under the Apache License,
 * Version 2.0; modified by MIRASIM, INC. See LICENSE and NOTICE.
 *
 * The mirasim tab group — which tabs are the AGENT'S OWN, inside the user's browser.
 *
 * The agent sees every tab; the Chrome tab group titled "mirasim" says whose each tab is:
 *  - tabs the bridge creates (popups, Target.createTarget) are pulled into the group;
 *  - a tab outside the group is the user's: attached and actable, but the driver will not close
 *    or recycle it, and its targets line says `(user's)` (platform/browser/driver.ts
 *    `listTargets`, types.ts `TargetInfo.own`).
 *
 * The group is deliberately NOT a visibility boundary (a task about a page the user already has
 * open would need it handed over first): the agent can read anything and close only its own.
 *
 * Unlike Playwright's extension (which ungroups on disconnect), the group is DURABLE: tabs and
 * group stay on disconnect, and the next connection adopts whatever is still in it.
 *
 * Mechanism adapted from Microsoft Playwright's browser extension (Apache-2.0).
 */

import { debugLog } from "./relay.js";

export const GROUP_TITLE = "mirasim";
const GROUP_COLOR = "cyan";
/** Where the browser-session nonce lives — see {@link browserSessionId}. */
const SESSION_KEY = "mirasim-browser-session";
const NON_DEBUGGABLE_SCHEMES = ["chrome:", "edge:", "devtools:", "chrome-extension:"];
const CONNECTED_BADGE = { text: "✓", color: "#0e7490", title: "Mirasim agent is connected to this tab" };

export function isNonDebuggableUrl(url) {
  return !!url && NON_DEBUGGABLE_SCHEMES.some((s) => url.startsWith(s));
}

/**
 * A nonce identifying THIS browser session, handed to the bridge on every handshake so it can
 * tell one reconnection from another (model.ts `onExtensionConnected`). Data, not a decision.
 *
 * Chrome tab ids are never reused WITHIN a browser session, so across a worker eviction or
 * reconnect the bridge may keep what it knew per tab id. After a browser RESTART the ids start
 * over and the same number can name the user's own page, which `/recycle` must not close.
 * `chrome.storage.session` has exactly that lifetime (survives eviction, cleared on restart): a
 * stored nonce says "same browser session", a missing one says "assume nothing".
 */
export async function browserSessionId() {
  const stored = await chrome.storage.session.get(SESSION_KEY).catch(() => ({}));
  const existing = stored?.[SESSION_KEY];
  if (typeof existing === "string" && existing) return existing;
  const minted = crypto.randomUUID();
  await chrome.storage.session.set({ [SESSION_KEY]: minted }).catch((e) => debugLog("session nonce not stored:", e));
  return minted;
}

export class MirasimTabGroup {
  updateAvailable(version) {
    this._connection.updateAvailable(version);
  }

  /**
   * @param {import("./relay.js").RelayConnection} connection
   */
  constructor(connection) {
    this._connection = connection;
    this._groupId = null;
    /** Cached group membership so hot-path checks stay synchronous. */
    this._groupTabIds = new Set();
    /**
     * Tabs attached because they were simply OPEN, not because the agent opened them.
     * `_onTabAttached` skips these; otherwise the sweep would pull every user tab into the group
     * (the only record of ownership), and with no current window throw "No current window".
     */
    this._userTabIds = new Set();
    /**
     * Tabs the BRIDGE created (relay.js `ontabcreatedforagent`): the agent's, whatever the race
     * below decided. A new tab's first `onUpdated` can arrive before the bridge has attached it,
     * and `_onTabUpdated` would then file it as the user's and keep it out of the group.
     */
    this._agentCreatedTabIds = new Set();
    this._onTabCreatedListener = this._onTabCreated.bind(this);
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    this._onTabReplacedListener = this._onTabReplaced.bind(this);

    /** @type {(() => void) | undefined} */
    this.onclose = undefined;

    this._connection.onclose = () => this._onConnectionClose();
    this._connection.ontabattached = (tabId) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId) => this._onTabDetached(tabId);
    this._connection.ontabcreatedforagent = (tabId) => {
      this._agentCreatedTabIds.add(tabId);
      this._userTabIds.delete(tabId);
    };
    chrome.tabs.onCreated.addListener(this._onTabCreatedListener);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    chrome.tabs.onReplaced.addListener(this._onTabReplacedListener);

    /** Resolves once the initial handshake (adopt + initialized) is done. */
    this.ready = this._initialize();
  }

  connectedTabIds() {
    return [...this._groupTabIds];
  }

  close(reason) {
    this._connection.close(reason);
  }

  /**
   * Adopt the existing mirasim group's tabs, and open NOTHING: a connect is not a request for a
   * page (the driver binds a listed tab or opens its own, platform/browser/tabs.ts
   * `claimSessionTab`), and a seeded blank tab would later count as the user's, unclosable. The
   * group comes back with the agent's first tab (`_addTabToGroup`). Ends with `didInitialize`,
   * which unblocks the bridge's CDP side against a populated tab model.
   */
  async _initialize() {
    // Identity BEFORE any tab: the bridge keys what it remembers on the browser session, and a
    // tab announced ahead of the nonce is a tab the bridge forgets (relay.js `didConnect`).
    this._connection.didConnect(await browserSessionId());
    const existing = (await chrome.tabGroups.query({ title: GROUP_TITLE }))[0];
    if (existing) {
      this._groupId = existing.id;
      const tabs = await chrome.tabs.query({ groupId: existing.id });
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        this._groupTabIds.add(tab.id);
        if (!isNonDebuggableUrl(tab.url)) this._connection.attachTab(tab);
      }
    }
    // Everything else the browser has open: attached, never grouped. Failures are per tab and
    // silent by design — an undebuggable page (chrome://, the Web Store) is simply not a surface.
    await this._attachEverythingElse();
    this._connection.didInitialize();
  }

  /**
   * A tab opened FROM one of the user's tabs (a link, `window.open`) is the user's. Mark it here,
   * at creation: the bridge attaches it at once as a popup (relay.js), before `_onTabUpdated`
   * would see it, and `_onTabAttached` would then group it. Bridge-created tabs have no opener;
   * one opened from a group tab is the agent's, and Chrome groups it itself.
   */
  _onTabCreated(tab) {
    if (tab.id === undefined || tab.openerTabId === undefined) return;
    if (!this._groupTabIds.has(tab.openerTabId)) this._userTabIds.add(tab.id);
  }

  _onTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.groupId !== undefined) this._onTabGroupChanged(tabId, tab);
    if (changeInfo.url === undefined && changeInfo.discarded === undefined && changeInfo.status === undefined) return;
    if (tab.discarded || tab.status === "unloaded") {
      if (!isNonDebuggableUrl(tab.url)) this._connection.attachTab(tab);
      return;
    }
    // Chrome resets per-tab badge state on navigation; re-apply it.
    if (this._connection.attachedTabs.has(tabId)) void this._updateBadge(tabId, CONNECTED_BADGE);
    // Any tab, not just the group's: a tab opened after connect becomes a surface on its first
    // navigation. Group membership decides OWNERSHIP, not reachability.
    else if (!isNonDebuggableUrl(tab.url)) {
      if (!this._groupTabIds.has(tabId) && !this._agentCreatedTabIds.has(tabId)) this._userTabIds.add(tabId);
      this._connection.attachTab(tab);
    }
  }

  /** Single entry point for membership changes, user-dragged or self-inflicted. */
  _onTabGroupChanged(tabId, tab) {
    const inOurGroup = this._groupId !== null && tab.groupId === this._groupId;
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup) return;
    if (inOurGroup) {
      // Dragging a tab in grants OWNERSHIP, not access — every tab is reachable already.
      this._groupTabIds.add(tabId);
      this._userTabIds.delete(tabId);
      if (!isNonDebuggableUrl(tab.url)) this._connection.attachTab(tab);
    } else {
      // Dragged out: theirs again. NOT detached — only the agent's claim is taken back.
      this._groupTabIds.delete(tabId);
      this._userTabIds.add(tabId);
    }
  }

  _onTabRemoved(tabId) {
    this._groupTabIds.delete(tabId);
    this._userTabIds.delete(tabId);
    this._agentCreatedTabIds.delete(tabId);
  }

  /** Newer Chrome versions replace the tab id when discarding its renderer. */
  async _onTabReplaced(addedTabId, removedTabId) {
    const grouped = this._groupTabIds.has(removedTabId);
    this._onTabRemoved(removedTabId);
    let tab;
    try { tab = await chrome.tabs.get(addedTabId); } catch { return; }
    this._userTabIds.delete(addedTabId);
    if (grouped) this._groupTabIds.add(addedTabId);
    else this._userTabIds.add(addedTabId);
    if (!isNonDebuggableUrl(tab.url)) this._connection.attachTab(tab);
  }

  /**
   * Attach every open tab not already attached — the connect-time sweep. Tabs opened LATER
   * arrive through `_onTabUpdated`.
   */
  async _attachEverythingElse() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (e) { debugLog("tab query failed:", e); return; }
    for (const tab of tabs) {
      if (tab.id === undefined || this._connection.attachedTabs.has(tab.id)) continue;
      if (isNonDebuggableUrl(tab.url)) continue;
      if (!this._groupTabIds.has(tab.id)) this._userTabIds.add(tab.id);
      this._connection.attachTab(tab);
    }
  }

  _onTabAttached(tabId) {
    void this._updateBadge(tabId, CONNECTED_BADGE);
    // The user's own tab is attached but NOT grouped: that would relabel it and physically move
    // it in their window.
    if (this._userTabIds.has(tabId)) return;
    void this._addTabToGroup(tabId);
  }

  /** Detached (drag-out, close, external). Clear the badge; the tab keeps its group
   *  membership — the user's intent is still there and a navigation re-attaches. */
  _onTabDetached(tabId) {
    void this._updateBadge(tabId, { text: "" });
  }

  _onConnectionClose() {
    chrome.tabs.onCreated.removeListener(this._onTabCreatedListener);
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    chrome.tabs.onReplaced.removeListener(this._onTabReplacedListener);
    // Keep the group and its tabs (the next connection adopts them); only clear the badges.
    for (const tabId of this._groupTabIds) void this._updateBadge(tabId, { text: "" });
    this._groupTabIds.clear();
    this.onclose?.();
  }

  async _updateBadge(tabId, { text, color, title }) {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text }),
        chrome.action.setTitle({ tabId, title: title || "" }),
        color ? chrome.action.setBadgeBackgroundColor({ tabId, color }) : Promise.resolve(),
      ]);
    } catch {
      /* tab already closed */
    }
  }

  /** Move an attached tab into the group, creating the group on first use. */
  async _addTabToGroup(tabId) {
    if (this._groupTabIds.has(tabId)) return;
    // The group can vanish under us: Chrome deletes one whose last tab closed (what `/recycle`
    // does). A stale `_groupId` would make every join throw and leave the agent's tabs outside
    // the group, so a failed join drops the id and retries once via the create branch.
    for (const attempt of [0, 1]) {
      try {
        await this._retryOnDrag(async () => {
          if (this._groupId === null) {
            this._groupId = await chrome.tabs.group({ tabIds: [tabId] });
            await chrome.tabGroups.update(this._groupId, { color: GROUP_COLOR, title: GROUP_TITLE });
          } else {
            await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
          }
        });
        this._groupTabIds.add(tabId);
        return;
      } catch (e) {
        if (attempt === 0 && this._groupId !== null) { this._groupId = null; continue; }
        debugLog("error adding tab to group:", e);
      }
    }
  }

  /** Chrome throws "user may be dragging a tab" mid-drag; retry until it clears. */
  async _retryOnDrag(fn) {
    const delays = [0, 100, 200, 400, 800];
    let lastError;
    for (const delay of delays) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        await fn();
        return;
      } catch (e) {
        if (!String(e?.message).includes("user may be dragging a tab")) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }
}
