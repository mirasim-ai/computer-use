/**
 * Portions Copyright (c) Microsoft Corporation (Playwright), licensed under the Apache License,
 * Version 2.0; modified by MIRASIM, INC. See LICENSE and NOTICE.
 *
 * The COMMANDS a bridge client may send: the CDP surface the extension stands in for.
 *
 * The seam with `model.ts` is direction: everything there is the model's own state and what the
 * EXTENSION pushes into it (tabs appearing, debugger events, a page closing); this is what a CLIENT
 * asks for, and every method here has to answer in Chrome's own vocabulary or playwright-core will
 * not believe it.
 */

import { BridgeClient, FAKE_WINDOW, tabIsUnloaded, type BridgeTab, type TabAttachment } from "./client.ts";
import { BridgeModelCore } from "./model-core.ts";
import { hostname } from "node:os";

type RestoredTab = { targetId: string; reloaded: boolean; viewport?: { width: number; height: number } };

export abstract class BridgeModelCommands extends BridgeModelCore {
  private readonly restoringTabs = new Map<string, Promise<{ attachment: TabAttachment; result: RestoredTab }>>();
  // ─── Client → model commands ──────────────────────────────────────────

  /**
   * Full CDP command dispatch for one client message: interceptions first,
   * then session-routed forwarding over chrome.debugger.
   */
  async handleCommand(client: BridgeClient, method: string, params: unknown, sessionId: string | undefined): Promise<unknown> {
    // A browser-target session is the root by another name.
    if (sessionId && client.browserSessions.has(sessionId)) return await this.handleCommand(client, method, params, undefined);
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "Mirasim.tabs":
        return { tabs: await this.listTargets(client), browserSession: this.browserSession };
      case "Mirasim.tabTarget": {
        return { targetId: await this.tabTarget(Number(p.tabId), String(p.browserSession ?? "")) };
      }
      case "Mirasim.restoreTab": {
        const { attachment, result } = await this.restoreTab(Number(p.tabId), String(p.targetId ?? ""), String(p.browserSession ?? ""));
        // To the client that bound it, and only that one: another client asks for itself.
        client.heldTabs.add(attachment.tabId);
        this.announce(client, attachment);
        return result;
      }
      case "Mirasim.releaseTab": {
        this.assertBrowserSession(String(p.browserSession ?? ""));
        this.releaseClientTab(client, Number(p.tabId));
        return {};
      }
      case "Mirasim.closeTab": {
        // A listed tab no client attached: closing it is `chrome.tabs.remove`, no debugger needed.
        this.assertBrowserSession(String(p.browserSession ?? ""));
        const tabId = Number(p.tabId);
        if (!this.knownTabs.has(tabId)) throw new Error(`Tab ${tabId} was closed; list tabs again.`);
        await this.sendToExtension("chrome.tabs.remove", [tabId]);
        return {};
      }
      case "Browser.getVersion":
        return { protocolVersion: "1.3", product: "Chrome/mirasim-bridge", userAgent: "mirasim-bridge/1.0" };
      case "Browser.setDownloadBehavior":
        // A FAKE whose caller cannot tell: Chrome never gets it, so a download lands wherever the
        // user's browser puts it; the download verb reads the REAL location via Mirasim.downloads.
        // It must STAY a fake (unlike `Browser.close` below): playwright sends it during
        // `connectOverCDP`, so refusing it kills the handshake. Pinned in `test/extension-bridge.ts`.
        return {};
      case "Mirasim.downloads": {
        if (typeof p.since !== "string" || !Number.isFinite(Date.parse(p.since))) throw new Error("Downloads require an ISO start time");
        if (p.until !== undefined && (typeof p.until !== "string" || !Number.isFinite(Date.parse(p.until)))) throw new Error("Downloads require an ISO end time");
        const items = await this.sendToExtension("chrome.downloads.search", [{ startedAfter: p.since,
          ...(p.until === undefined ? {} : { startedBefore: p.until }) }]);
        return { host: hostname(), items };
      }
      case "Browser.getWindowForTarget":
        // The real answer is the user's window, which the driver would then park off-screen.
        // One fake window keeps the driver's own-window bookkeeping coherent.
        return structuredClone(FAKE_WINDOW);
      case "Browser.setWindowBounds":
        // The other half of the fake above: one made-up window, nothing to move. Every
        // computer-use caller is gated on a posture extension mode never has (offscreen window,
        // managed profile), so only playwright's connect-time housekeeping sends it.
        return {};
      case "Mirasim.attachRefusals": {
        // Not Chrome's vocabulary, and meant not to be: a client that lost a tab asks why, and a
        // real browser answers an unknown method with an error, which reads as "no record".
        const since = Date.now() - 60_000;
        return { refusals: [...this.attachRefusals.values()].filter((r) => r.at >= since).map(({ url, reason }) => ({ url, reason })) };
      }
      case "Browser.close":
        // The browser is the USER'S OWN; recycling the agent's tabs is `recycleAgentTabs`.
        // Refused rather than faked: a client that reads a silent {} as success (a host
        // preview's × falling back to this verb) would report a still-running browser as closed.
        throw new Error("Browser.close is not available on the mirasim bridge — the browser is the user's own");
      case "Target.setAutoAttach":
        if (!sessionId) {
          await this.enableAutoAttach(client);
          return {};
        }
        break; // session-level (workers/oopifs) forwards to the tab
      case "Target.createTarget":
        return await this.createTarget(typeof p.url === "string" ? p.url : undefined);
      case "Target.closeTarget":
        return await this.closeTarget(typeof p.targetId === "string" ? p.targetId : undefined);
      case "Target.attachToTarget":
        if (!sessionId) return await this.attachToTarget(client, typeof p.targetId === "string" ? p.targetId : undefined);
        break;
      case "Target.attachToBrowserTarget":
        if (!sessionId) return { sessionId: client.browserAlias() };
        break;
      case "Runtime.enable": {
        if (!sessionId) throw new Error("Runtime.enable requires a target session");
        const route = this.resolveSession(client, sessionId);
        const runtime = this.runtimeForSession(route.tabId, route.cdpSessionId);
        const subscribe = client.enableRuntime(sessionId);
        try {
          const result = await runtime.enable(() => this.sendToExtension("chrome.debugger.sendCommand", [
            { tabId: route.tabId, ...(route.cdpSessionId ? { sessionId: route.cdpSessionId } : {}) },
            method,
            ...(params === undefined ? [] : [params]),
          ]));
          if (subscribe) {
            // First-enable events already delivered to this alias are deduplicated.
            // A later alias learns the same live ids without interrupting other clients.
            for (const context of runtime.values())
              client.runtimeEvent(sessionId, "Runtime.executionContextCreated", context, true);
          }
          return result;
        } catch (error) {
          if (subscribe) client.disableRuntime(sessionId);
          throw error;
        }
      }
      case "Runtime.disable":
        if (!sessionId) throw new Error("Runtime.disable requires a target session");
        this.resolveSession(client, sessionId);
        client.disableRuntime(sessionId);
        return {}; // unsubscribe this alias; the shared domain stays enabled until detach
      case "Target.detachFromTarget": {
        const detachId = typeof p.sessionId === "string" ? p.sessionId : undefined;
        const virtualOwner = detachId ? client.virtualSessions.get(detachId) : undefined;
        if (detachId && virtualOwner !== undefined) {
          client.virtualSessions.delete(detachId);
          client.forgetSession(detachId);
          this.releaseUnusedTab(virtualOwner);
          return {};
        }
        if (detachId && client.browserSessions.delete(detachId)) return {};
        // A real child session detaches through its OWNING tab; an unknown id is
        // already gone, and "done" is the honest answer.
        const owner = detachId ? this.childSessionOwner.get(detachId) : undefined;
        if (detachId && owner === undefined) return {};
        if (detachId && owner !== undefined) {
          return await this.sendToExtension("chrome.debugger.sendCommand", [
            { tabId: owner },
            method,
            { sessionId: detachId },
          ]);
        }
        break;
      }
    }
    if (!sessionId) return await this.sendBrowserCommand(method, params);
    const route = this.resolveSession(client, sessionId);
    return await this.sendToExtension("chrome.debugger.sendCommand", [
      { tabId: route.tabId, ...(route.cdpSessionId ? { sessionId: route.cdpSessionId } : {}) },
      method,
      ...(params === undefined ? [] : [params]),
    ]);
  }

  /**
   * Attach the tabs this client is handed ({@link wants}: the agent's, and any it asked for) and
   * announce each; new ones follow. The user's other tabs are listed (`Mirasim.tabs`), never
   * attached: a debugger on a tab nobody drives turned it light (Playwright's media emulation)
   * and answered its dialogs. Reconciles against LIVE tabs first: a tab closed while nothing was
   * watching it can leave a ghost in `knownTabs`, and a ghost hands the client a page whose
   * renderer is gone, where `evaluate` never returns.
   */
  private async enableAutoAttach(client: BridgeClient): Promise<void> {
    client.autoAttach = true;
    await this.reconcileKnownTabs();
    const tabIds = [...this.knownTabs].filter(([id, tab]) => !tabIsUnloaded(tab) && this.wants(client, id)).map(([id]) => id);
    await Promise.all(tabIds.map((tabId) => this.attachAndAnnounce(client, tabId).catch((e) => this.log("attach failed:", e))));
  }

  /** Drop `knownTabs` entries whose tab no longer exists. Best-effort: a failed query
   *  leaves the model as it was rather than emptying it. */
  protected async reconcileKnownTabs(): Promise<void> {
    let live: BridgeTab[];
    try {
      live = ((await this.sendToExtension("chrome.tabs.query", [{}])) as BridgeTab[]) ?? [];
    } catch (e) {
      this.log("tab reconcile failed:", e);
      return;
    }
    const alive = new Map(live.filter((t) => t.id !== undefined).map((t) => [t.id!, t]));
    for (const tabId of [...this.knownTabs.keys()]) {
      const tab = alive.get(tabId);
      if (!tab) {
        this.knownTabs.delete(tabId);
        this.agentTabs.delete(tabId);
        this.dropTab(tabId);
      } else {
        const wasUnloaded = tabIsUnloaded(this.knownTabs.get(tabId)!);
        this.knownTabs.set(tabId, tab);
        if (tabIsUnloaded(tab) && this.attachments.has(tabId)) {
          this.dropTab(tabId);
          void this.sendToExtension("bridge.releaseTab", [tabId]).catch((e) => this.log("release unloaded tab failed:", e));
        } else if (wasUnloaded && !tabIsUnloaded(tab)) {
          for (const client of this.clients) if (this.wants(client, tabId))
            void this.attachAndAnnounce(client, tabId).catch((e) => this.log("restored tab attach failed:", e));
        }
      }
    }
  }

  /** This browser-side identity query does not attach or wake an unloaded renderer. */
  protected assertBrowserSession(expected: string): void {
    if (!expected || !this.browserSession) throw new Error("Reload the Mirasim extension before restoring tabs: this connection has no browser-session identity.");
    if (expected !== this.browserSession) throw new Error("The browser restarted; list tabs and bind the intended target again.");
  }

  private async tabTarget(tabId: number, browserSession: string): Promise<string> {
    this.assertBrowserSession(browserSession);
    await this.reconcileKnownTabs();
    if (!this.knownTabs.has(tabId)) throw new Error(`Tab ${tabId} was closed; list tabs again.`);
    let targets: Array<{ tabId?: number; id: string }>;
    try { targets = await this.sendToExtension("chrome.debugger.getTargets", []) as typeof targets; }
    catch (e) {
      if (String(e).includes("Unknown method")) throw new Error("Reload the Mirasim extension to enable restoring unloaded tabs.");
      throw e;
    }
    const target = targets.find((t) => t.tabId === tabId);
    this.assertBrowserSession(browserSession);
    if (!target?.id) throw new Error(`Chrome did not identify tab ${tabId}; refusing to restore an unknown target.`);
    return target.id;
  }

  /**
   * Attach a caller-selected tab after it has claimed the target, reloading it in the background
   * first when Chrome had unloaded it. The caller announces it to the client that asked.
   */
  private restoreTab(tabId: number, expectedTargetId: string, browserSession: string): Promise<{ attachment: TabAttachment; result: RestoredTab }> {
    this.assertBrowserSession(browserSession);
    const key = `${browserSession}:${tabId}`;
    const existing = this.restoringTabs.get(key);
    if (existing) return existing.then((restored) => {
      if (restored.result.targetId !== expectedTargetId) throw new Error("Tab identity changed; list and bind it again before acting.");
      return restored;
    });
    const restore = (async () => {
      if (!expectedTargetId) throw new Error("Restoring a tab requires its claimed target identity.");
      if (await this.tabTarget(tabId, browserSession) !== expectedTargetId) throw new Error(`Tab ${tabId} changed identity before restoration; no reload was sent.`);
      const tab = this.knownTabs.get(tabId);
      if (!tab) throw new Error(`Tab ${tabId} was closed; list tabs again.`);
      const reloaded = tabIsUnloaded(tab);
      if (reloaded) {
        try { await this.sendToExtension("chrome.tabs.reload", [tabId]); }
        catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          throw new Error(reason.includes("Unknown method")
            ? "Reload the Mirasim extension to enable restoring unloaded tabs."
            : `Could not restore tab ${tabId}: ${reason}`);
        }
        const deadline = Date.now() + 10_000;
        while (tabIsUnloaded(this.knownTabs.get(tabId) ?? { discarded: true })) {
          if (Date.now() >= deadline) throw new Error(`Tab ${tabId} remained unloaded after restoration; no action was sent to its page.`);
          await new Promise((resolve) => setTimeout(resolve, 50));
          await this.reconcileKnownTabs();
          if (!this.knownTabs.has(tabId)) throw new Error(`Tab ${tabId} closed while restoring; no replacement tab was opened.`);
        }
      }
      const attachment = await this.ensureAttached(tabId);
      if (attachment.targetInfo.targetId !== expectedTargetId) throw new Error(`Tab ${tabId} changed identity while restoring; list and bind it again before acting.`);
      // Chrome 155 can restore a background renderer with a zero-size viewport. Offer an
      // observed size from the same window/split, never wake another tab to measure it.
      const peers = [...this.knownTabs.values()].filter((t) => t.windowId === tab.windowId
        && t.splitViewId === tab.splitViewId && (t.width ?? 0) > 0 && (t.height ?? 0) > 0);
      const sized = peers.find((t) => t.id === tabId) ?? peers.find((t) => t.active) ?? peers[0];
      return { attachment, result: { targetId: attachment.targetInfo.targetId, reloaded,
        ...(sized ? { viewport: { width: sized.width!, height: sized.height! } } : {}) } };
    })();
    this.restoringTabs.set(key, restore);
    void restore.finally(() => this.restoringTabs.delete(key)).catch(() => {});
    return restore;
  }

  /** Create a tab (in the user's window; the extension pulls it into the mirasim
   *  group) — background on purpose, so the user's active tab is never stolen. */
  async createTarget(url: string | undefined): Promise<{ targetId: string }> {
    const tab = (await this.sendToExtension("chrome.tabs.create", [{ url: url || "about:blank", active: false }])) as BridgeTab;
    if (tab?.id === undefined) throw new Error("Failed to create tab");
    this.knownTabs.set(tab.id, tab);
    // The agent asked for this one, so it is the agent's to recycle (see {@link agentTabs}).
    this.agentTabs.add(tab.id);
    const attachment = await this.ensureAttached(tab.id);
    for (const client of this.clients) {
      if (client.autoAttach) this.announce(client, attachment);
    }
    return { targetId: attachment.targetInfo.targetId };
  }

  /**
   * Close the tabs the AGENT opened, and only those — the `/recycle` verb behind the "close the
   * agent's tab when a task finishes" switch. Never `Browser.close`, even when the group empties:
   * Chrome removes an emptied group itself and the next agent tab recreates it
   * (extension/group.js `_addTabToGroup`).
   */
  async recycleAgentTabs(): Promise<{ closed: number }> {
    await this.reconcileKnownTabs();
    const doomed = [...this.agentTabs].filter((tabId) => this.knownTabs.has(tabId));
    let closed = 0;
    for (const tabId of doomed) {
      try {
        await this.sendToExtension("chrome.tabs.remove", [tabId]);
        closed += 1;
      } catch (e) {
        // A tab that refuses to close is not worth failing the recycle over — the user can
        // close it, and the next reconcile forgets it either way.
        this.log("recycle failed for tab", tabId, e);
      }
      this.knownTabs.delete(tabId);
      this.agentTabs.delete(tabId);
      this.dropTab(tabId);
    }
    return { closed };
  }

  private async closeTarget(targetId: string | undefined): Promise<{ success: boolean }> {
    const tabId = targetId ? this.tabIdForTarget(targetId) : undefined;
    if (tabId === undefined) return { success: false };
    // Closing needs no attachment: it is `chrome.tabs.remove`, and the tab is the thing.
    await this.sendToExtension("chrome.tabs.remove", [tabId]);
    return { success: true };
  }

  /** `newCDPSession`: answer with a virtual alias for the tab's root session.
   *  Response only — `model-core.ts`'s header says why no event may be emitted. */
  private async attachToTarget(client: BridgeClient, targetId: string | undefined): Promise<{ sessionId: string }> {
    const tabId = targetId ? this.tabIdForTarget(targetId) : undefined;
    if (tabId === undefined) throw new Error(`No target with id: ${targetId}`);
    // A stand-in id names a not-yet-attached tab; attaching is what this command asks for.
    await this.ensureAttached(tabId);
    return { sessionId: client.virtualAlias(tabId) };
  }

  /** Browser-level command with no session (Storage.* & co): chrome.debugger
   *  needs a target, and any attached tab answers browser-scoped questions. */
  private async sendBrowserCommand(method: string, params: unknown): Promise<unknown> {
    if (method === "Target.getTargetInfo" && !(params as { targetId?: unknown } | undefined)?.targetId) {
      // Playwright asks about the root after auto-attach, and only waits for the answer. The
      // virtual root answers it, so connecting attaches nothing beyond what auto-attach handed
      // over, and a browser with every tab unloaded or unattached stays connectable.
      return { targetInfo: { targetId: "mirasim-browser", type: "browser", title: "", url: "", attached: true } };
    }
    const attached = this.attachments.values().next().value as TabAttachment | undefined;
    // Between tasks nothing may be attached while the group still has tabs, and any of them can
    // carry a browser-scoped question: attach one for the question, then let it go again.
    const tabId = attached?.tabId ?? [...this.knownTabs].find(([, tab]) => !tabIsUnloaded(tab))?.[0];
    if (tabId === undefined) throw new Error(`No tab to forward browser-level command: ${method}`);
    if (!attached) await this.ensureAttached(tabId);
    try {
      return await this.sendToExtension("chrome.debugger.sendCommand", [
        { tabId },
        method,
        ...(params === undefined ? [] : [params]),
      ]);
    } finally {
      if (!attached) this.releaseUnusedTab(tabId);
    }
  }

}
