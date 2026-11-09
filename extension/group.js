/**
 * Portions Copyright (c) Microsoft Corporation (Playwright), licensed under the Apache License,
 * Version 2.0; modified by MIRASIM, INC. See LICENSE and NOTICE.
 *
 * The mirasim tab group — which tabs the agent may use, inside the user's browser.
 *
 * Every Chrome tab group titled "mirasim" (one per window at most, by our hand) is the agent's
 * side of the browser:
 *  - tabs the bridge creates (Target.createTarget) are pulled into the group;
 *  - the user hands a tab over by clicking the toolbar icon on it (toolbar.js) or dragging it
 *    in, and takes it back by dragging it out or from the panel — which also detaches it;
 *  - the driver closes only tabs its session opened; one the user handed over stays theirs to
 *    close (platform/browser/driver-tabs.ts `ownPages`).
 *
 * How far beyond the group the agent sees is the user's choice (access.js): in the default
 * `group` scope the group, the agent's own tabs and their popups are ALL it can list or attach;
 * `all` lists every tab as before 0.1.3; `ask` lists every tab and asks before attaching one
 * outside the group. The site rules hold in every scope. This class answers those questions for
 * the relay (`connection.gate`), which refuses the rest.
 *
 * Unlike Playwright's extension (which ungroups on disconnect), the group is DURABLE: tabs and
 * group stay on disconnect, and the next connection adopts whatever is still in it.
 *
 * Mechanism adapted from Microsoft Playwright's browser extension (Apache-2.0).
 */

import { debugLog } from "./relay.js";
import { AccessError } from "./access.js";

export const GROUP_TITLE = "mirasim";
const GROUP_COLOR = "cyan";
/** Where the browser-session nonce lives — see {@link browserSessionId}. */
const SESSION_KEY = "mirasim-browser-session";
const NON_DEBUGGABLE_SCHEMES = ["chrome:", "edge:", "devtools:", "chrome-extension:", "view-source:"];
/** Pages Chrome never lets an extension's debugger into, whatever their scheme. */
const NON_DEBUGGABLE_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];
/** How long an attach waits for the user's answer in `ask` scope; under the bridge's own 30s
 *  command timeout (server-core.ts EXTENSION_COMMAND_TIMEOUT_MS), so the refusal is ours. */
const ASK_WAIT_MS = 20_000;

export function isNonDebuggableUrl(url) {
  if (!url) return false;
  if (NON_DEBUGGABLE_SCHEMES.some((s) => url.startsWith(s))) return true;
  try {
    const u = new URL(url);
    return NON_DEBUGGABLE_HOSTS.includes(u.hostname) && (u.hostname !== "chrome.google.com" || u.pathname.startsWith("/webstore"));
  } catch {
    return false;
  }
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

/** Is this one of ours? Read live, so it works with no connection (the toolbar click). */
export async function isMirasimGroup(groupId) {
  if (groupId === undefined || groupId < 0) return false;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  return group?.title === GROUP_TITLE;
}

/** Chrome throws "user may be dragging a tab" mid-drag; retry until it clears. */
async function retryOnDrag(fn) {
  const delays = [0, 100, 200, 400, 800];
  let lastError;
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      return await fn();
    } catch (e) {
      if (!String(e?.message).includes("user may be dragging a tab")) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * Hand a tab to the agent: into the mirasim group of ITS window, created there if missing — a
 * group in another window would move the user's tab across windows. Needs no connection: the
 * group is durable and the next connection adopts it.
 */
export async function addToMirasimGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId !== undefined && tab.groupId >= 0 && (await isMirasimGroup(tab.groupId))) return;
  const [existing] = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
  await retryOnDrag(async () => {
    if (existing) {
      await chrome.tabs.group({ groupId: existing.id, tabIds: [tabId] });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { color: GROUP_COLOR, title: GROUP_TITLE });
    }
  });
}

export class MirasimTabGroup {
  updateAvailable(version) {
    this._connection.updateAvailable(version);
  }

  /**
   * @param {import("./relay.js").RelayConnection} connection
   * @param {import("./access.js").AccessPolicy} policy
   */
  constructor(connection, policy) {
    this._connection = connection;
    this.policy = policy;
    /** The group the agent's own new tabs join (the first mirasim group, else one we create). */
    this._groupId = null;
    /** Every mirasim group, in any window: membership in any of them is a hand-over. */
    this._groupIds = new Set();
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
    /** Popups of tabs in scope (a popup window cannot join a group): in scope as their opener. */
    this._inheritedTabIds = new Set();
    /** Ask scope: the user's open question per tab, and the tabs they said no to. */
    this._asks = new Map();
    this._declined = new Set();
    this._onTabCreatedListener = this._onTabCreated.bind(this);
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    this._onTabReplacedListener = this._onTabReplaced.bind(this);
    this._onGroupUpdatedListener = this._onGroupUpdated.bind(this);
    this._onGroupRemovedListener = (group) => {
      this._groupIds.delete(group.id);
      if (this._groupId === group.id) this._groupId = null;
    };

    /** @type {(() => void) | undefined} */
    this.onclose = undefined;
    /** A tab's state for the toolbar changed (attached, detached, joined, left). */
    /** @type {((tabId: number) => void) | undefined} */
    this.ontabstate = undefined;

    connection.gate = this;
    this._connection.onclose = () => this._onConnectionClose();
    this._connection.ontabattached = (tabId) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId) => this.ontabstate?.(tabId);
    this._connection.ontabrevoked = (tabId) => this.ontabstate?.(tabId);
    this._connection.ontabcreatedforagent = (tabId) => {
      this._agentCreatedTabIds.add(tabId);
      this._userTabIds.delete(tabId);
    };
    this._unwatchPolicy = policy.onChange(() => void this.reevaluate());
    chrome.tabs.onCreated.addListener(this._onTabCreatedListener);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    chrome.tabs.onReplaced.addListener(this._onTabReplacedListener);
    chrome.tabGroups.onUpdated.addListener(this._onGroupUpdatedListener);
    chrome.tabGroups.onRemoved.addListener(this._onGroupRemovedListener);

    /** Resolves once the initial handshake (adopt + initialized) is done. */
    this.ready = this._initialize();
  }

  connectedTabIds() {
    return [...this._connection.attachedTabs];
  }

  isAttached(tabId) {
    return this._connection.attachedTabs.has(tabId);
  }

  get bridgeInfo() {
    return this._connection.bridgeInfo;
  }

  close(reason) {
    this._connection.close(reason);
  }

  // ─── what the agent may reach (relay.js `gate`) ──────────────────────────

  /** The agent's side of the browser, whatever the scope: the groups, its tabs, their popups. */
  _isHandedOver(tabId) {
    return this._groupTabIds.has(tabId) || this._agentCreatedTabIds.has(tabId) || this._inheritedTabIds.has(tabId);
  }

  _inScope(tab) {
    return this.policy.settings.scope !== "group" || this._isHandedOver(tab.id);
  }

  /** Why the agent may not see this tab, or null when it may. */
  _refusalFor(tab) {
    if (!tab || tab.id === undefined) return "out-of-scope";
    if (isNonDebuggableUrl(tab.url) || isNonDebuggableUrl(tab.pendingUrl)) return "out-of-scope";
    const verdict = this.policy.siteVerdict(tab.url) ?? this.policy.siteVerdict(tab.pendingUrl);
    if (verdict) return verdict;
    return this._inScope(tab) ? null : "out-of-scope";
  }

  /** Listed to the bridge at all? */
  visible(tab) {
    return this._refusalFor(tab) === null;
  }

  /** A popup of a tab the agent drives (relay.js forwards those): in scope as its opener. */
  noteCreated(tab) {
    if (tab?.id === undefined || tab.openerTabId === undefined) return;
    if (this._isHandedOver(tab.openerTabId) || this.policy.grants.has(tab.openerTabId)) this._inheritedTabIds.add(tab.id);
  }

  /** The attach itself: everything `visible` asks, and in `ask` scope the user's yes. */
  async authorizeAttach(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const reason = this._refusalFor(tab);
    if (reason) {
      this.policy.record({ reason, tabId, url: tab?.url });
      throw new AccessError(reason, { tabId, url: tab?.url });
    }
    if (this.policy.settings.scope !== "ask" || this._isHandedOver(tabId) || this.policy.grants.has(tabId)) return;
    if (this._declined.has(tabId)) throw new AccessError("declined", { tabId });
    const allowed = await this._ask(tab);
    if (allowed === undefined) throw new AccessError("ask-pending", { tabId });
    if (!allowed) throw new AccessError("declined", { tabId });
  }

  /**
   * Ask the user in a small window whether the agent may use `tab`. Resolves true or false with
   * their answer, or undefined after {@link ASK_WAIT_MS}: the window stays up, and an answer
   * given later still counts for the agent's next try.
   */
  _ask(tab) {
    let ask = this._asks.get(tab.id);
    if (!ask) {
      ask = { waiters: new Set(), windowId: null };
      this._asks.set(tab.id, ask);
      const url = chrome.runtime.getURL(`ask.html?tab=${tab.id}`);
      chrome.windows
        .create({ url, type: "popup", width: 440, height: 300, focused: true })
        .then((win) => {
          ask.windowId = win?.id ?? null;
        })
        .catch((e) => debugLog("ask window failed:", e));
    } else if (ask.windowId !== null) {
      void chrome.windows.update(ask.windowId, { focused: true }).catch(() => {});
    }
    return new Promise((resolve) => {
      const waiter = (answer) => {
        clearTimeout(timer);
        resolve(answer);
      };
      const timer = setTimeout(() => {
        ask.waiters.delete(waiter);
        this.policy.record({ reason: "ask-pending", tabId: tab.id, url: tab.url });
        resolve(undefined);
      }, ASK_WAIT_MS);
      ask.waiters.add(waiter);
    });
  }

  /** The ask window's answer (background.js routes it here). */
  answerAsk(tabId, allow) {
    const ask = this._asks.get(tabId);
    this._asks.delete(tabId);
    if (allow) {
      this._declined.delete(tabId);
      this.policy.grant(tabId);
    } else {
      this._declined.add(tabId);
      this.policy.record({ reason: "declined", tabId });
    }
    for (const waiter of ask?.waiters ?? []) waiter(allow);
    if (ask?.windowId !== null && ask?.windowId !== undefined) void chrome.windows.remove(ask.windowId).catch(() => {});
    this.ontabstate?.(tabId);
  }

  /**
   * Settings or the pause changed: take away what is no longer the agent's, announce what now
   * is. Tabs already attached when the user switches to `ask` keep going — the switch is about
   * the next tab, not a reason to cut the agent off mid-task.
   */
  async reevaluate() {
    this._connection.reportAccess(this.accessSummary());
    // The pause lets go of every tab at once rather than refusing what comes next: a refused
    // evaluate leaves the client's page unusable even after the resume, while a detached tab
    // stays listed and is attached again the next time the agent binds it.
    if (this.policy.paused) for (const tabId of [...this._connection.attachedTabs]) this._connection.revoke(tabId, "paused", { keepListed: true });
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch { return; }
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      if (this.policy.settings.scope === "ask" && this._connection.attachedTabs.has(tab.id)) this.policy.grant(tab.id);
      const reason = this._refusalFor(tab);
      const known = this._connection.isAnnounced(tab.id) || this._connection.attachedTabs.has(tab.id);
      if (reason && known) this._connection.revoke(tab.id, reason, { url: tab.url });
      else if (!reason && !known) this._connection.attachTab(tab);
      this.ontabstate?.(tab.id);
    }
  }

  /** What the bridge passes on when it lists tabs (relay.js `reportAccess`). */
  accessSummary() {
    const { scope, blocked, allowOnly } = this.policy.settings;
    return { scope, siteRules: blocked.length > 0 || allowOnly, paused: this.policy.paused };
  }

  /** The panel's "take back": out of the group, out of the agent's hands, detached. */
  async takeBack(tabId) {
    this._agentCreatedTabIds.delete(tabId);
    this._inheritedTabIds.delete(tabId);
    this.policy.forget(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && this._groupIds.has(tab.groupId)) await retryOnDrag(() => chrome.tabs.ungroup(tabId)).catch((e) => debugLog("ungroup failed:", e));
    this._release(tabId, tab);
  }

  /** A tab leaves the agent's side: detached now, and unlisted where the scope says so. */
  _release(tabId, tab) {
    this._groupTabIds.delete(tabId);
    this._userTabIds.add(tabId);
    this.policy.forget(tabId);
    if (tab && this._refusalFor(tab)) this._connection.revoke(tabId, this._refusalFor(tab), { url: tab.url });
    else this._connection.detachTab(tabId);
    this.ontabstate?.(tabId);
  }

  // ─── the group and its tabs ──────────────────────────────────────────────

  /**
   * Adopt the existing mirasim groups' tabs, and open NOTHING: a connect is not a request for a
   * page (the driver binds a listed tab or opens its own, platform/browser/tabs.ts
   * `claimSessionTab`), and a seeded blank tab would later count as the user's, unclosable. The
   * group comes back with the agent's first tab (`_addTabToGroup`). Ends with `didInitialize`,
   * which unblocks the bridge's CDP side against a populated tab model.
   */
  async _initialize() {
    // Identity BEFORE any tab: the bridge keys what it remembers on the browser session, and a
    // tab announced ahead of the nonce is a tab the bridge forgets (relay.js `didConnect`).
    this._connection.didConnect(await browserSessionId());
    await this.policy.ready;
    this._connection.reportAccess(this.accessSummary());
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
    for (const group of groups) {
      this._groupIds.add(group.id);
      this._groupId ??= group.id;
      const tabs = await chrome.tabs.query({ groupId: group.id });
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        this._groupTabIds.add(tab.id);
        this._connection.attachTab(tab);
      }
    }
    // Everything else the browser has open, where the scope lists it: never grouped. Failures
    // are per tab and silent by design — an undebuggable page (chrome://, the Web Store) is
    // simply not a surface.
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
    if (changeInfo.groupId !== undefined) void this._onTabGroupChanged(tabId, tab);
    if (changeInfo.url === undefined && changeInfo.discarded === undefined && changeInfo.status === undefined) return;
    // A navigation can take a tab out of reach (a blocked site) or bring it back.
    const reason = this._refusalFor(tab);
    if (reason) {
      if (this._connection.isAnnounced(tabId) || this._connection.attachedTabs.has(tabId)) {
        if (changeInfo.url !== undefined && reason !== "out-of-scope") this.policy.record({ reason, tabId, url: tab.url });
        this._connection.revoke(tabId, reason, { url: tab.url });
        this.ontabstate?.(tabId);
      }
      return;
    }
    if (tab.discarded || tab.status === "unloaded") {
      this._connection.attachTab(tab);
      return;
    }
    // Any tab, not just the group's: a tab opened after connect becomes a surface on its first
    // navigation where the scope lists it. Group membership decides OWNERSHIP, not reachability.
    if (!this._connection.attachedTabs.has(tabId)) {
      if (!this._groupTabIds.has(tabId) && !this._agentCreatedTabIds.has(tabId)) this._userTabIds.add(tabId);
      this._connection.attachTab(tab);
    }
  }

  /** A group got (or lost) the mirasim title: its tabs join (or leave) with it. */
  async _onGroupUpdated(group) {
    const ours = group.title === GROUP_TITLE;
    if (ours === this._groupIds.has(group.id)) return;
    if (ours) {
      this._groupIds.add(group.id);
      // A group the user's click made is where the agent's own new tabs go too, not a second one.
      this._groupId ??= group.id;
    } else {
      this._groupIds.delete(group.id);
      if (this._groupId === group.id) this._groupId = null;
    }
    const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
    for (const tab of tabs) if (tab.id !== undefined) await this._onTabGroupChanged(tab.id, tab);
  }

  /** Single entry point for membership changes, user-dragged or self-inflicted. */
  async _onTabGroupChanged(tabId, tab) {
    if (tab.groupId !== undefined && tab.groupId >= 0 && !this._groupIds.has(tab.groupId) && (await isMirasimGroup(tab.groupId))) {
      this._groupIds.add(tab.groupId);
      this._groupId ??= tab.groupId;
    }
    const inOurGroup = this._groupIds.has(tab.groupId);
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup) return;
    if (inOurGroup) {
      // Handed over: the agent may use it (and in `group` scope, only now sees it at all).
      this._groupTabIds.add(tabId);
      this._userTabIds.delete(tabId);
      this._declined.delete(tabId);
      this._connection.attachTab(tab);
      this.ontabstate?.(tabId);
    } else {
      // Dragged out: taken back. Detached at once, and unlisted unless the scope lists every tab.
      this._agentCreatedTabIds.delete(tabId);
      this._inheritedTabIds.delete(tabId);
      this._release(tabId, tab);
    }
  }

  _onTabRemoved(tabId) {
    this._groupTabIds.delete(tabId);
    this._userTabIds.delete(tabId);
    this._agentCreatedTabIds.delete(tabId);
    this._inheritedTabIds.delete(tabId);
    this._declined.delete(tabId);
    this.policy.forget(tabId);
  }

  /** Newer Chrome versions replace the tab id when discarding its renderer. */
  async _onTabReplaced(addedTabId, removedTabId) {
    const grouped = this._groupTabIds.has(removedTabId);
    const agents = this._agentCreatedTabIds.has(removedTabId);
    const inherited = this._inheritedTabIds.has(removedTabId);
    const granted = this.policy.grants.has(removedTabId);
    this._onTabRemoved(removedTabId);
    let tab;
    try { tab = await chrome.tabs.get(addedTabId); } catch { return; }
    this._userTabIds.delete(addedTabId);
    if (grouped) this._groupTabIds.add(addedTabId);
    else this._userTabIds.add(addedTabId);
    if (agents) this._agentCreatedTabIds.add(addedTabId);
    if (inherited) this._inheritedTabIds.add(addedTabId);
    if (granted) this.policy.grant(addedTabId);
    this._connection.attachTab(tab);
  }

  /**
   * Announce every open tab the scope lists and the bridge has not heard of — the connect-time
   * sweep. Tabs opened LATER arrive through `_onTabUpdated`.
   */
  async _attachEverythingElse() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (e) { debugLog("tab query failed:", e); return; }
    for (const tab of tabs) {
      if (tab.id === undefined || this._connection.attachedTabs.has(tab.id)) continue;
      if (!this._groupTabIds.has(tab.id)) this._userTabIds.add(tab.id);
      this._connection.attachTab(tab);
    }
  }

  _onTabAttached(tabId) {
    this.ontabstate?.(tabId);
    // The user's own tab is attached but NOT grouped: that would relabel it and physically move
    // it in their window.
    if (this._userTabIds.has(tabId)) return;
    void this._addTabToGroup(tabId);
  }

  _onConnectionClose() {
    chrome.tabs.onCreated.removeListener(this._onTabCreatedListener);
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    chrome.tabs.onReplaced.removeListener(this._onTabReplacedListener);
    chrome.tabGroups.onUpdated.removeListener(this._onGroupUpdatedListener);
    chrome.tabGroups.onRemoved.removeListener(this._onGroupRemovedListener);
    this._unwatchPolicy();
    for (const ask of this._asks.values()) for (const waiter of ask.waiters) waiter(undefined);
    this._asks.clear();
    // Keep the group and its tabs (the next connection adopts them).
    this._groupTabIds.clear();
    this.onclose?.();
  }

  /** Move an attached tab into the group, creating the group on first use. */
  async _addTabToGroup(tabId) {
    if (this._groupTabIds.has(tabId)) return;
    // The group can vanish under us: Chrome deletes one whose last tab closed (what `/recycle`
    // does). A stale `_groupId` would make every join throw and leave the agent's tabs outside
    // the group, so a failed join drops the id and retries once via the create branch.
    for (const attempt of [0, 1]) {
      try {
        await retryOnDrag(async () => {
          if (this._groupId === null) {
            this._groupId = await chrome.tabs.group({ tabIds: [tabId] });
            this._groupIds.add(this._groupId);
            await chrome.tabGroups.update(this._groupId, { color: GROUP_COLOR, title: GROUP_TITLE });
          } else {
            await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
          }
        });
        this._groupTabIds.add(tabId);
        return;
      } catch (e) {
        if (attempt === 0 && this._groupId !== null) { this._groupIds.delete(this._groupId); this._groupId = null; continue; }
        debugLog("error adding tab to group:", e);
      }
    }
  }
}
