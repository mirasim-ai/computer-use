/**
 * Portions Copyright (c) Microsoft Corporation (Playwright), licensed under the Apache License,
 * Version 2.0; modified by MIRASIM, INC. See LICENSE and NOTICE.
 *
 * One CONNECTED client of the bridge, and the shapes the extension and the clients exchange.
 *
 * A client is bookkeeping, not behaviour: which CDP sessions it was handed, which tab each one
 * stands for, and the ids it minted. The model that decides what a client may DO is the other file.
 */

import { RuntimeContexts, type RuntimeDomain } from "./runtime-contexts.ts";

/** Structural mirror of the chrome.tabs.Tab fields the model reads. */
export interface BridgeTab {
  id?: number;
  url?: string;
  title?: string;
  /** Where a navigation that has not committed yet is going. */
  pendingUrl?: string;
  discarded?: boolean;
  status?: string;
  windowId?: number;
  splitViewId?: number;
  width?: number;
  height?: number;
  active?: boolean;
}

/** Chrome retains a tab-strip entry even when its renderer has been unloaded. */
export function tabIsUnloaded(tab: BridgeTab): boolean {
  return tab.discarded === true || tab.status === "unloaded";
}

/** One debugger attachment shared by every client. `targetInfo` is Chrome's own
 *  (it carries the real targetId/browserContextId playwright asserts on). */
export interface TabAttachment {
  tabId: number;
  targetInfo: { targetId: string; [key: string]: unknown };
  /** Root (empty key) and real child debugger sessions have independent Runtime domains. */
  runtimes: Map<string, RuntimeDomain>;
}

/** A command the extension took and did not answer in time, while the line itself still works.
 *  `tabId` and `cdpMethod` are set for a `chrome.debugger.sendCommand`: the tab is what is stuck. */
export class ExtensionUnanswered extends Error {
  constructor(message: string, readonly ms: number, readonly tabId?: number, readonly cdpMethod?: string) {
    super(message);
  }
}

export type CdpMessage = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
};

/** What an UNATTACHED tab is listed under: a tab joins the group long before any client
 *  attaches to it, and a `/json/list` row without an identity cannot be acted on at all. Chrome's
 *  own targetId takes over the moment an attachment exists — but until then this IS the tab's
 *  published id, so every command that takes one has to accept it back ({@link BridgeModel.tabIdForTarget}). */
export const STAND_IN_PREFIX = "mirasim-tab-";

export const FAKE_WINDOW = {
  windowId: 1,
  bounds: { left: 0, top: 0, width: 1440, height: 900, windowState: "normal" },
};

/** One connected playwright-core client and its private session namespace. */
export class BridgeClient {
  readonly id: number;
  autoAttach = false;
  /**
   * Beyond the agent's own tabs (the model's `agentTabs`), auto-attach hands a client only these
   * two sets, so a tab nobody is driving keeps no debugger: Playwright pins media features on every
   * page it attaches to, and its dialog handlers answer that page's prompts. Both survive a
   * debugger detach (a cross-process navigation re-attaches the same tab); a closed tab ends them.
   *
   * `heldTabs`: the user's tabs it BORROWED — one it bound (`Mirasim.restoreTab`) and the popups
   * those open. Let go of as soon as the client is on another tab (`Mirasim.holdOnly`).
   */
  readonly heldTabs = new Set<number>();
  /** Popups of the agent's own pages (or of theirs): the agent's for as long as the client lasts. */
  readonly keptTabs = new Set<number>();
  /** tabId → this client's alias for the tab's root debugger session. */
  readonly sessionByTabId = new Map<number, string>();
  readonly tabBySessionId = new Map<string, number>();
  /** `Target.attachToTarget` aliases (`newCDPSession`) → tabId. */
  readonly virtualSessions = new Map<string, number>();
  /** `Target.attachToBrowserTarget` aliases — playwright's `newCDPSession` opens
   *  one first and sends the target attach THROUGH it; commands on these route
   *  exactly like root-level commands. */
  readonly browserSessions = new Set<string>();
  private nextSession = 0;
  private readonly runtimes = new Map<string, RuntimeContexts>();
  private readonly initializedFrames = new Set<string>();
  private readonly frameReplies = new Map<number, string>();
  private readonly pendingFrames = new Map<string, RuntimeContexts>();

  constructor(
    id: number,
    private readonly sendMessage: (message: CdpMessage) => void,
  ) {
    this.id = id;
  }

  /** Playwright installs its main-frame listeners after this reply. Track the wire
   *  response, not handleCommand's promise: a delayed response must keep the gate shut. */
  trackFrameTree(id: number, sessionId: string): void {
    // A raw CDP consumer that already enabled Runtime can consume its notifications;
    // a later frame query is not initialization and must not suspend that subscription.
    if (this.initializedFrames.has(sessionId) || this.runtimes.has(sessionId)) return;
    this.frameReplies.set(id, sessionId);
    if (!this.pendingFrames.has(sessionId)) this.pendingFrames.set(sessionId, new RuntimeContexts());
  }

  send(message: CdpMessage): void {
    this.sendMessage(message);
    if (message.id === undefined) return;
    const sessionId = this.frameReplies.get(message.id);
    if (sessionId === undefined) return;
    this.frameReplies.delete(message.id);
    const pending = this.pendingFrames.get(sessionId);
    this.pendingFrames.delete(sessionId);
    if (!message.error) this.initializedFrames.add(sessionId);
    // The response goes first. Playwright's WebSocket transport drains each message's
    // microtasks before dispatching the next, so the frame/listeners exist for these.
    for (const params of pending?.values() ?? [])
      this.sendMessage({ sessionId, method: "Runtime.executionContextCreated", params });
  }

  enableRuntime(sessionId: string): boolean {
    if (this.runtimes.has(sessionId)) return false;
    this.runtimes.set(sessionId, new RuntimeContexts());
    return true;
  }

  disableRuntime(sessionId: string): void {
    this.runtimes.delete(sessionId);
    this.pendingFrames.get(sessionId)?.clear();
  }

  runtimeEvent(sessionId: string, method: string, params: unknown, replay = false): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || (replay && runtime.has(params))) return;
    runtime.update(method, params);
    const pending = this.pendingFrames.get(sessionId);
    pending?.update(method, params);
    if (pending && method === "Runtime.executionContextCreated") return;
    this.send({ sessionId, method, params });
  }

  forgetSession(sessionId: string): void {
    this.disableRuntime(sessionId);
    this.initializedFrames.delete(sessionId);
    this.pendingFrames.delete(sessionId);
    for (const [id, owner] of this.frameReplies) if (owner === sessionId) this.frameReplies.delete(id);
  }

  dispose(): void {
    this.runtimes.clear();
    this.initializedFrames.clear();
    this.pendingFrames.clear();
    this.frameReplies.clear();
  }

  tabAlias(tabId: number): string {
    let alias = this.sessionByTabId.get(tabId);
    if (!alias) {
      alias = `mir-c${this.id}-t${++this.nextSession}`;
      this.sessionByTabId.set(tabId, alias);
      this.tabBySessionId.set(alias, tabId);
    }
    return alias;
  }

  virtualAlias(tabId: number): string {
    const alias = `mir-c${this.id}-v${++this.nextSession}`;
    this.virtualSessions.set(alias, tabId);
    return alias;
  }

  browserAlias(): string {
    const alias = `mir-c${this.id}-b${++this.nextSession}`;
    this.browserSessions.add(alias);
    return alias;
  }

  dropTab(tabId: number): string | null {
    const alias = this.sessionByTabId.get(tabId) ?? null;
    if (alias) {
      this.forgetSession(alias);
      this.sessionByTabId.delete(tabId);
      this.tabBySessionId.delete(alias);
    }
    for (const [v, t] of this.virtualSessions) if (t === tabId) {
      this.forgetSession(v);
      this.virtualSessions.delete(v);
    }
    return alias;
  }
}
