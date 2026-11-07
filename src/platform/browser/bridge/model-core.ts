/**
 * Portions Copyright (c) Microsoft Corporation (Playwright), licensed under the Apache License,
 * Version 2.0; modified by MIRASIM, INC. See LICENSE and NOTICE.
 *
 * Bridge tab model — the one place that translates between the chrome.* dialect of the mirasim
 * browser extension and the CDP dialect of playwright-core clients (`chromium.connectOverCDP`).
 *
 * Mechanism adapted from Microsoft Playwright's MCP CDP relay
 * (packages/playwright-core/src/tools/mcp/browserModel.ts, Apache-2.0), with two departures:
 *
 *  - MULTIPLE CDP clients: several computer-use processes can drive one browser, so each client
 *    gets a session namespace over one shared chrome.debugger attachment per tab. Playwright's
 *    relay accepts exactly one client.
 *  - VIRTUAL sessions for `Target.attachToTarget` (`ctx.newCDPSession(page)`): playwright builds
 *    the session wrapper from the RESPONSE alone, so the model answers with an alias routed to
 *    the tab's root debugger session. No `Target.attachedToTarget` event may be emitted for it:
 *    CRBrowser asserts "Duplicate target" on a second attach event for a known page.
 *
 * Window-management commands are answered with fakes on purpose: the agent's tabs live in the
 * USER'S window, and a forwarded `Browser.setWindowBounds` would move a window the user is
 * working in. Off-screen parking is a managed-browser concern only.
 */

export type SendToExtension = (method: string, params: unknown[]) => Promise<unknown>;

import { BridgeClient, STAND_IN_PREFIX, tabIsUnloaded, type BridgeTab, type TabAttachment , type CdpMessage } from "./client.ts";
import { RuntimeDomain, isRuntimeContextEvent } from "./runtime-contexts.ts";

// Re-exported so a caller that only speaks to the model keeps ONE import site.
export { BridgeClient, type BridgeTab, type TabAttachment } from "./client.ts";

/** How long after a page's `Page.windowOpen` a new tab is taken for its popup. Measured: the tab
 *  is announced 15–20 ms after the event. The margin is for a loaded machine, and kept short: a
 *  window that never opened (a blocked popup) leaves its report to the next tab that appears. */
const WINDOW_OPEN_MS = 1_000;

/** Whether two urls name the same page; Chrome may normalize one side (a form's trailing `?`). */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => { try { return new URL(u).href.replace(/\?$/, ""); } catch { return u; } };
  return norm(a) === norm(b);
}

export abstract class BridgeModelCore {
  /** Implemented in {@link BridgeModelCommands}: the client half owns what a reconnect has to
   *  re-learn about the tabs, and this half is what notices the reconnect. */
  protected abstract reconcileKnownTabs(): Promise<void>;
  /** Tabs the extension announced (group members), attached or not yet. */
  protected knownTabs = new Map<number, BridgeTab>();
  /** The subset of {@link knownTabs} the agent OPENED (its own `Target.createTarget`, or an older
   *  extension's blank seed tab). Never a tab the user dragged into the group (that GRANTS a page
   *  the user is keeping) nor one adopted from a group that outlived an earlier connection.
   *  {@link recycleAgentTabs} closes exactly this set. */
  protected agentTabs = new Set<number>();
  /** The browser session those tab ids belong to — see {@link onExtensionConnected}. */
  protected browserSession: string | null = null;
  protected attachments = new Map<number, TabAttachment>();
  /** In-flight attaches, so two clients racing for one tab attach once. */
  private attaching = new Map<number, Promise<TabAttachment>>();
  /** Real CDP child sessions (workers, oopifs) → owning tabId. */
  protected childSessionOwner = new Map<string, number>();
  /** Why the debugger could not (re-)enter a tab, by tab id, for the client that lost it (it sees
   *  only a page that stopped answering). Chrome's words matter: "Cannot access a chrome-extension://
   *  URL of different extension" means another extension's frame is in the page, which no retry
   *  gets past. Read by `Mirasim.attachRefusals`. */
  protected attachRefusals = new Map<number, { url: string; reason: string; at: number }>();
  /** Windows driven pages are about to open, oldest first — see {@link claimPopup}. */
  private windowOpens: Array<{ from: number; url: string; at: number }> = [];
  protected clients = new Set<BridgeClient>();
  private nextClientId = 0;

  constructor(
    protected readonly sendToExtension: SendToExtension,
    protected readonly log: (...args: unknown[]) => void = () => {},
  ) {}

  // ─── Client lifecycle ─────────────────────────────────────────────────

  addClient(send: (message: CdpMessage) => void): BridgeClient {
    const client = new BridgeClient(++this.nextClientId, send);
    this.clients.add(client);
    return client;
  }

  /**
   * Drop a client and RELEASE the tabs nobody else is driving.
   *
   * Detach the shared debugger after its final client leaves. Runtime snapshots belong
   * to that attachment and must not survive a detach or browser restart.
   */
  removeClient(client: BridgeClient): void {
    this.clients.delete(client);
    client.dispose();
    const tabIds = new Set([...client.sessionByTabId.keys(), ...client.virtualSessions.values()]);
    for (const tabId of tabIds) this.releaseUnusedTab(tabId);
  }

  clientCount(): number {
    return this.clients.size;
  }

  // ─── Extension → model inputs ─────────────────────────────────────────

  onTabCreated(tab: BridgeTab, opener: { agent?: boolean } = {}): void {
    if (tab.id === undefined) return;
    // The extension announces a tab again on later navigations; only the first time is a new tab.
    const appeared = !this.knownTabs.has(tab.id);
    this.knownTabs.set(tab.id, tab);
    if (opener.agent) this.agentTabs.add(tab.id);
    // Announcing an unloaded renderer makes Playwright wait for its initialization and blocks
    // the entire browser connection. Keep its identity for discovery, without attaching it.
    if (tabIsUnloaded(tab)) {
      if (this.attachments.has(tab.id)) {
        this.dropTab(tab.id);
        void this.sendToExtension("bridge.releaseTab", [tab.id]).catch((e) => this.log("release unloaded tab failed:", e));
      }
      return;
    }
    if (appeared) this.claimPopup(tab);
    for (const client of this.clients) {
      if (this.wants(client, tab.id))
        void this.attachAndAnnounce(client, tab.id).catch((e) => this.log("auto-attach failed:", e));
    }
  }

  /**
   * A tab opened from a page a client drives (a popup, a `target=_blank` link, a form posted to a
   * new window) is part of what that client is doing, as on any other endpoint.
   *
   * Told by the OPENER, which is attached: Chrome reports `Page.windowOpen` on the page that opens
   * a window (noopener included) a few ms before the tab exists ({@link onWindowOpen}). The new tab
   * takes the oldest such report from the last {@link WINDOW_OPEN_MS}, when its url, if it has one
   * yet, is the one reported. No other tab is touched to find out: not `chrome.tabs`' openerTabId
   * (for a link followed in a background tab it names whichever tab was in front), and not CDP's
   * openerId, which only the new tab's own debugger session reports.
   */
  private claimPopup(tab: BridgeTab): void {
    // The agent's own new tab can be announced before `createTarget` marks it; it is no popup.
    if (this.agentTabs.has(tab.id!)) return;
    const now = Date.now();
    this.windowOpens = this.windowOpens.filter((o) => now - o.at <= WINDOW_OPEN_MS);
    const url = tab.url ?? "";
    const i = this.windowOpens.findIndex((o) => !url || url === "about:blank" || o.url === "about:blank" || sameUrl(o.url, url));
    if (i < 0) return;
    const [open] = this.windowOpens.splice(i, 1);
    for (const client of this.clients) {
      if (!client.autoAttach || !client.sessionByTabId.has(open!.from)) continue;
      // The agent's page opened it: the agent's for the session, like its opener. A user's tab the
      // client bound opened it: borrowed with it, and let go of the same way.
      if (this.agentTabs.has(open!.from) || client.keptTabs.has(open!.from)) client.keptTabs.add(tab.id!);
      else client.heldTabs.add(tab.id!);
    }
  }

  /** Remember a window a driven page is about to open, for {@link claimPopup}. */
  private onWindowOpen(from: number, params: unknown): void {
    const url = (params as { url?: unknown } | undefined)?.url;
    if (![...this.clients].some((client) => client.autoAttach && client.sessionByTabId.has(from))) return;
    this.windowOpens.push({ from, url: typeof url === "string" ? url : "", at: Date.now() });
  }

  onTabRemoved(tabId: number): void {
    this.knownTabs.delete(tabId);
    this.agentTabs.delete(tabId);
    for (const client of this.clients) {
      client.heldTabs.delete(tabId);
      client.keptTabs.delete(tabId);
    }
    this.dropTab(tabId);
  }

  onTabReplaced(addedTabId: number, removedTabId: number): void {
    const own = this.agentTabs.has(removedTabId);
    const holders = [...this.clients].filter((client) => client.heldTabs.has(removedTabId));
    const keepers = [...this.clients].filter((client) => client.keptTabs.has(removedTabId));
    this.onTabRemoved(removedTabId);
    if (own) this.agentTabs.add(addedTabId);
    for (const client of holders) client.heldTabs.add(addedTabId);
    for (const client of keepers) client.keptTabs.add(addedTabId);
    // The extension follows with the new tab's metadata. Never reuse the old renderer id.
  }

  onDebuggerEvent(source: { tabId?: number; sessionId?: string }, method: string, params: unknown): void {
    const tabId = source.tabId;
    if (tabId === undefined || !this.attachments.has(tabId)) return;
    if (source.sessionId && this.childSessionOwner.get(source.sessionId) !== tabId) return;
    if (method === "Page.windowOpen") this.onWindowOpen(tabId, params);
    const childSessionId = (params as { sessionId?: string } | undefined)?.sessionId;
    if (method === "Target.attachedToTarget" && childSessionId) this.childSessionOwner.set(childSessionId, tabId);
    else if (method === "Target.detachedFromTarget" && childSessionId) {
      this.childSessionOwner.delete(childSessionId);
      this.attachments.get(tabId)?.runtimes.delete(childSessionId);
      for (const client of this.clients) client.forgetSession(childSessionId);
    }
    const runtimeEvent = isRuntimeContextEvent(method);
    if (runtimeEvent) this.runtimeForSession(tabId, source.sessionId).update(method, params);
    if (source.sessionId) {
      // Child-session event: clients were announced the real CDP sessionId, so it passes
      // through untranslated; a client that never met it drops the unknown id silently.
      for (const client of this.clients) {
        if (method.startsWith("Runtime.")) client.runtimeEvent(source.sessionId, method, params);
        else client.send({ sessionId: source.sessionId, method, params });
      }
      return;
    }
    for (const client of this.clients) {
      const alias = client.sessionByTabId.get(tabId);
      if (alias) {
        if (method.startsWith("Runtime.")) client.runtimeEvent(alias, method, params);
        else client.send({ sessionId: alias, method, params });
      }
      // Read-only observers use explicit flattened sessions rather than auto-attach.
      // Each alias must receive its own events, including screencast frames to acknowledge.
      for (const [sessionId, owner] of client.virtualSessions) {
        if (owner === tabId) {
          if (method.startsWith("Runtime.")) client.runtimeEvent(sessionId, method, params);
          else client.send({ sessionId, method, params });
        }
      }
    }
  }

  onDebuggerDetach(source: { tabId?: number }): void {
    if (source.tabId !== undefined) this.dropTab(source.tabId);
  }

  /** The extension connection died (Chrome quit, service worker gone): every tab is stale. Tell
   *  each client its pages are gone so drivers reopen instead of hanging.
   *
   *  `agentTabs` deliberately SURVIVES ({@link onExtensionConnected} decides): the next connection
   *  re-adopts the group's tabs with no `agent` flag (the extension cannot know who opened them),
   *  so clearing it here would leave `/recycle` closing nothing for that browser's life. */
  onExtensionDisconnected(): void {
    for (const tabId of [...this.attachments.keys()]) this.dropTab(tabId);
    this.knownTabs.clear();
    this.childSessionOwner.clear();
  }

  /**
   * A handshake finished. `browserSession` is the extension's nonce for THIS browser session
   * (extension/group.js `browserSessionId`). Same nonce ⇒ the remembered tab ids still name the
   * same tabs (Chrome does not reuse tab ids within a session), so agent-tab marks survive a
   * service-worker eviction or reconnect. A different or missing nonce (a restarted browser, or an
   * extension too old to say) ⇒ the ids may now name the user's pages, so the marks go.
   */
  onExtensionConnected(browserSession?: string): void {
    const sameSession = !!browserSession && browserSession === this.browserSession;
    if (!sameSession) this.agentTabs.clear();
    // The bridge log is the only place this decision is visible, and it decides whether a tab
    // gets closed on the user's behalf. `kept=0` on a first connect is the normal reading.
    this.log(`extension connected: ${sameSession ? "same" : "new"} browser session, kept ${this.agentTabs.size} agent tab mark(s)`);
    this.browserSession = browserSession ?? null;
  }

  /**
   * Targets for the `/json/list` façade: every KNOWN tab, with LIVE url and title. Not the
   * attach-time `targetInfo` (never refreshed, so a navigated tab would read `about:blank`), and
   * not only ATTACHED tabs (a tab is detached once no client drives it, so that would answer
   * "no pages" with the whole group open — and `hasPageTarget` believes it).
   */
  async listTargets(client?: BridgeClient): Promise<Array<{ id: string; tabId: number; type: string; url: string; title: string; unloaded: boolean; held?: boolean }>> {
    await this.reconcileKnownTabs();
    let live: BridgeTab[] = [];
    try {
      live = ((await this.sendToExtension("chrome.tabs.query", [{}])) as BridgeTab[]) ?? [];
    } catch (e) {
      this.log("live tab query failed:", e);
    }
    const byId = new Map(live.filter((t) => t.id !== undefined).map((t) => [t.id!, t]));
    const out: Array<{ id: string; tabId: number; type: string; url: string; title: string; unloaded: boolean; held?: boolean }> = [];
    for (const tabId of this.knownTabs.keys()) {
      const tab = byId.get(tabId);
      const info = this.attachments.get(tabId)?.targetInfo;
      out.push({
        tabId,
        // An unattached tab has no CDP targetId yet; a stable stand-in keeps the row usable
        // as an identity (and it becomes the real id the moment a client attaches).
        id: typeof info?.targetId === "string" ? info.targetId : `${STAND_IN_PREFIX}${tabId}`,
        type: "page",
        url: tab?.url ?? (typeof info?.url === "string" ? info.url : ""),
        title: tab?.title ?? (typeof info?.title === "string" ? info.title : ""),
        unloaded: tabIsUnloaded(tab ?? this.knownTabs.get(tabId)!),
        // Asked by a client: whether it has this tab as a page. One it does not is listed only,
        // and binding it is `Mirasim.restoreTab`.
        ...(client ? { held: client.sessionByTabId.has(tabId) } : {}),
      });
    }
    return out;
  }

  /**
   * Keep only the tab the client is on among the user's tabs it borrowed ({@link BridgeClient.heldTabs}),
   * and hand back the rest as if it had never asked: each page goes away for this client alone, and
   * the debugger leaves the tab once no other client drives it. By tab id, which a cross-process
   * navigation keeps while Playwright's page object for it is replaced. `keep` undefined: none.
   */
  holdOnly(client: BridgeClient, keep: number | undefined): void {
    for (const tabId of [...client.heldTabs]) if (tabId !== keep && !this.agentTabs.has(tabId)) this.releaseClientTab(client, tabId);
  }

  private releaseClientTab(client: BridgeClient, tabId: number): void {
    client.heldTabs.delete(tabId);
    const attachment = this.attachments.get(tabId);
    const alias = client.dropTab(tabId);
    if (alias && attachment) client.send({ method: "Target.detachedFromTarget", params: { sessionId: alias, targetId: attachment.targetInfo.targetId } });
    this.releaseUnusedTab(tabId);
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /** Does auto-attach hand this client the tab? The agent's tabs (every client is told of
   *  those), its pages' popups and the ones it borrowed ({@link BridgeClient}) — never the rest of the
   *  user's browsing, which stays listed and unattached until a client binds it. */
  protected wants(client: BridgeClient, tabId: number): boolean {
    return client.autoAttach && (this.agentTabs.has(tabId) || client.keptTabs.has(tabId) || client.heldTabs.has(tabId));
  }

  protected releaseUnusedTab(tabId: number): void {
    if (!this.attachments.has(tabId) || [...this.clients].some((client) =>
      client.sessionByTabId.has(tabId) || [...client.virtualSessions.values()].includes(tabId))) return;
    this.dropTab(tabId);
    void this.sendToExtension("bridge.releaseTab", [tabId]).catch((error) => this.log("release failed:", error));
  }

  protected runtimeForSession(tabId: number, sessionId?: string): RuntimeDomain {
    const attachment = this.attachments.get(tabId);
    if (!attachment) throw new Error(`No debugger attachment for tab: ${tabId}`);
    const key = sessionId ?? "";
    let runtime = attachment.runtimes.get(key);
    if (!runtime) {
      runtime = new RuntimeDomain();
      attachment.runtimes.set(key, runtime);
    }
    return runtime;
  }

  protected resolveSession(client: BridgeClient, sessionId: string): { tabId: number; cdpSessionId?: string } {
    const byAlias = client.tabBySessionId.get(sessionId);
    if (byAlias !== undefined) return { tabId: byAlias };
    const byVirtual = client.virtualSessions.get(sessionId);
    if (byVirtual !== undefined) return { tabId: byVirtual };
    const owner = this.childSessionOwner.get(sessionId);
    if (owner !== undefined) return { tabId: owner, cdpSessionId: sessionId };
    throw new Error(`No tab for sessionId: ${sessionId}`);
  }

  /** The tab a client-visible targetId names: Chrome's real id once attached, or the stand-in
   *  `/json/list` published before that — a client acting on a listed row is ordinary CDP. */
  protected tabIdForTarget(targetId: string): number | undefined {
    for (const attachment of this.attachments.values()) {
      if (attachment.targetInfo.targetId === targetId) return attachment.tabId;
    }
    if (!targetId.startsWith(STAND_IN_PREFIX)) return undefined;
    const tabId = Number(targetId.slice(STAND_IN_PREFIX.length));
    return Number.isInteger(tabId) && this.knownTabs.has(tabId) ? tabId : undefined;
  }

  protected async attachAndAnnounce(client: BridgeClient, tabId: number): Promise<void> {
    let attachment: TabAttachment;
    try {
      attachment = await this.ensureAttached(tabId);
    } catch (e) {
      this.attachRefusals.set(tabId, { url: this.knownTabs.get(tabId)?.url ?? "", reason: e instanceof Error ? e.message : String(e), at: Date.now() });
      for (const id of this.attachRefusals.keys()) { if (this.attachRefusals.size <= 20) break; this.attachRefusals.delete(id); }
      throw e;
    }
    this.attachRefusals.delete(tabId);
    this.announce(client, attachment);
  }

  protected announce(client: BridgeClient, attachment: TabAttachment): void {
    if (client.sessionByTabId.has(attachment.tabId)) return;
    const sessionId = client.tabAlias(attachment.tabId);
    client.send({
      method: "Target.attachedToTarget",
      params: {
        sessionId,
        targetInfo: { ...attachment.targetInfo, attached: true },
        waitingForDebugger: false,
      },
    });
  }

  protected ensureAttached(tabId: number): Promise<TabAttachment> {
    const tab = this.knownTabs.get(tabId);
    if (!tab) return Promise.reject(new Error(`Tab ${tabId} was closed; list tabs again.`));
    if (tabIsUnloaded(tab)) return Promise.reject(new Error(`Tab ${tabId} is unloaded by Chrome. Restore this tab before attaching its renderer.`));
    const existing = this.attachments.get(tabId);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.attaching.get(tabId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      await this.sendToExtension("chrome.debugger.attach", [{ tabId }, "1.3"]);
      const result = (await this.sendToExtension("chrome.debugger.sendCommand", [{ tabId }, "Target.getTargetInfo"])) as
        | { targetInfo?: TabAttachment["targetInfo"] }
        | undefined;
      if (!result?.targetInfo?.targetId) throw new Error(`Tab ${tabId} reported no targetInfo`);
      const attachment: TabAttachment = { tabId, targetInfo: result.targetInfo, runtimes: new Map() };
      this.attachments.set(tabId, attachment);
      return attachment;
    })();
    this.attaching.set(tabId, promise);
    promise.catch(() => {}).finally(() => this.attaching.delete(tabId));
    return promise;
  }

  /** Shared detach bookkeeping: alias teardown + `Target.detachedFromTarget`
   *  (with targetId — playwright routes page teardown by it, not the session). */
  protected dropTab(tabId: number): void {
    const attachment = this.attachments.get(tabId);
    this.attachments.delete(tabId);
    for (const [childId, owner] of this.childSessionOwner) if (owner === tabId) {
      this.childSessionOwner.delete(childId);
      for (const client of this.clients) client.forgetSession(childId);
    }
    for (const client of this.clients) {
      const alias = client.dropTab(tabId);
      if (alias && attachment) {
        client.send({
          method: "Target.detachedFromTarget",
          params: { sessionId: alias, targetId: attachment.targetInfo.targetId },
        });
      }
    }
  }
}
