/**
 * Getting CONNECTED: the endpoint ladder, the context wiring, and the tab claim — everything
 * between "a session was asked for a browser" and "we hold a live page that is ours".
 *
 * The chain is `ChromiumPageDriver` → `BrowserDriverCore` → `BrowserDriverTabs` (which page is
 * ours) → this → `BrowserDriver` (the verbs); everything here CALLS the ownership slice, never
 * the reverse.
 *
 * Connection is lazy. A caller-provided endpoint is strict (explicit sessions stay
 * deterministic); otherwise the environment hint, the conventional local endpoint, then the
 * managed Chrome, adopt-or-launch on a persistent profile (acquire.ts has the ladder).
 */

import type { Page } from "playwright-core";
import { connectBrowserCdp } from "./cdp-connection.ts";
import { acquireManagedBrowser, openBlankTab, publishTabIdentity } from "./acquire.ts";
import { acquireBridge, bridgeJustStarted, extensionHeldElsewhere, waitForExtension } from "./bridge/acquire-bridge.ts";
import { claimIsolatedTab, claimNamedTab, claimSessionTab, newBackgroundPage, pageTargetInfo } from "./tabs.ts";
import { bridgeBrowserSession } from "./bridge-tabs.ts";
import { BROWSER_SWITCHED_NOTE, isBridgeExtensionGone, msgBridgeExtensionElsewhere, msgBridgeExtensionGone, msgBridgeJustStarted, msgEndpointUnavailable, REOPENED_NOTE, SURFACE_REIDENTIFIED_NOTE, TAB_DETACHED_NOTE, TAB_REOPENED_AFTER_SELF_CLOSE_NOTE, TAB_REOPENED_NOTE, tabRefusedNote } from "./messages.ts";
import { SurfaceUnreadableError } from "../types.ts";
import { KEEP_IN_TAB_JS } from "./keep-in-tab.ts";
import { ActionJournal } from "./journal.ts";
import { captureEvidenceShot } from "../chromium/shot.ts";
import { ensureRefSelector } from "../chromium/page-refs.ts";
import { REIDENTIFIED_WHY } from "./driver-core.ts";
import { BrowserDriverTabs } from "./driver-tabs.ts";

export abstract class BrowserDriverConnect extends BrowserDriverTabs {
  private endpoints(): string[] {
    if (this.explicit) return [this.cdpUrl];
    return [...new Set([this.cdpUrl, this.fallbackCdpUrl])];
  }

  protected async ensure(): Promise<void> {
    // Every path below reaches the browser through the endpoint, so one wrapper covers them all:
    // a bridge whose extension has gone is UNREADABLE, not failed (see msgBridgeExtensionGone).
    try {
      await this.ensureInner();
    } catch (e) {
      if (isBridgeExtensionGone(e)) throw new SurfaceUnreadableError(await this.extensionGoneMessage());
      throw e;
    }
  }

  /** The extension-gone refusal, sharpened when this session found the bridge itself. */
  private async extensionGoneMessage(): Promise<string> {
    if (!this.cfg.extension || this.cfg.cdpUrl) return msgBridgeExtensionGone();
    const owner = await extensionHeldElsewhere(this.cfg.home);
    if (owner) return msgBridgeExtensionElsewhere(owner);
    return bridgeJustStarted(this.cfg.home, 90_000) ? msgBridgeJustStarted() : msgBridgeExtensionGone();
  }

  /**
   * Why the bridge could not get back into the tab this session lost, if it recorded a refusal —
   * `Mirasim.attachRefusals` (bridge/model-commands.ts). The re-attach is tried ~150 ms after the
   * detach, so a loss noticed sooner gets one more look. A non-bridge endpoint errors: no record.
   */
  private async attachRefusal(lostUrl: string): Promise<string | null> {
    if (!lostUrl || lostUrl === "about:blank" || !this.browser) return null;
    for (let look = 0; look < 2; look++) {
      if (look) await new Promise((r) => setTimeout(r, 500));
      try {
        const session = await this.browser.newBrowserCDPSession();
        try {
          const res = await (session as unknown as { send(m: string): Promise<{ refusals?: { url: string; reason: string }[] }> })
            .send("Mirasim.attachRefusals");
          const hit = res.refusals?.find((r) => r.url === lostUrl);
          if (hit) return hit.reason;
        } finally {
          await session.detach().catch(() => {});
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Record the bridge's browser-session nonce, and act on a CHANGE of it.
   *
   * The extension bridge serves one extension at a time (bridge/server.ts `attachExtension`): when
   * the active browser goes, another browser's extension that was waiting takes over, and a
   * restarted browser comes back as a new session; the nonce is the only thing that tells. Measured
   * before this: the bound tab read as merely "closed", a blank tab was opened in the browser that
   * had just connected (one the task never named), and nothing said the browser itself had
   * changed. Now the session is left holding NO tab and the model is told, as on a first connect
   * to the bridge. A null nonce (off the bridge, or a bridge too old to name one) is never a change.
   * Returns whether the browser changed.
   */
  protected noteBridgeSession(session: string | null): boolean {
    if (!session) return false;
    const before = this.bridgeSession;
    this.bridgeSession = session;
    if (!before || before === session) return false;
    this.resetObservationState();
    this.active = undefined;
    this.appendNote(BROWSER_SWITCHED_NOTE);
    return true;
  }

  private async ensureInner(): Promise<void> {
    if (this.browser?.isConnected()) {
      // Holding no tab is not having lost one: on the extension bridge the session opens none up front.
      if (!this.active) return;
      const open = await this.ownPages();
      // None of our own, but a live tab of the USER'S bound: nothing went away, so there is nothing
      // to reopen — a blank tab here would be one nobody asked for (the session only binds theirs).
      if (!open.length && this.active.isClosed()) {
        // Dormant on purpose: reopening is right for a tab that went away UNDER us, wrong for
        // one this session closed deliberately.
        if (this.closedItsLastTab) return;
        // Not a tab that went away: the whole browser behind the bridge changed. Open nothing there.
        if (this.noteBridgeSession(await bridgeBrowserSession(this.browser))) return;
        // Every window is gone while the process lingers (macOS keeps Chrome alive) — the user
        // closed it. Open a fresh BACKGROUND tab and tell the model. The note is set on every
        // endpoint, not just managed ones: a silent reopen on the bridge or electron yields a
        // right-looking answer about a different page. Only the WORDING varies: "the browser had
        // been closed" would be a lie on a bridge, so the tab wording is the default.
        this.resetObservationState(); // refs died with the closed pages
        const lostUrl = this.active?.url() ?? "";
        // Attached: the window that vanished was OURS, and the user's own windows may well
        // still be on screen — take a new window rather than a tab in one of theirs.
        this.active = this.attached ? await this.openOwnWindow()
          : this.tab ? await this.reclaimTab()
          : await newBackgroundPage(this.context);
        this.claim(this.active);
        // What happened is readable only from what we landed on: a blank page means the tab (or
        // browser) really went away; a page with a URL means nothing closed and the ids were
        // re-minted under us, as a bridged browser does on every extension reconnection.
        const blank = !this.active.url() || this.active.url() === "about:blank";
        this.pendingNote = !blank ? SURFACE_REIDENTIFIED_NOTE
          : this.wokeAfterSelfClose ? TAB_REOPENED_AFTER_SELF_CLOSE_NOTE
          : this.managedProfileDir && !this.tab ? REOPENED_NOTE
          : this.explicit && !this.managedProfileDir && !this.attached
            ? ((r) => r ? tabRefusedNote(r) : TAB_DETACHED_NOTE)(await this.attachRefusal(lostUrl))
          : TAB_REOPENED_NOTE;
        this.wokeAfterSelfClose = false;
        await this.publishClaim();
      } else if (this.active.isClosed()) {
        // Our tab went away but others remain: a tab close, not a shutdown. Prefer real
        // content: a stray about:blank must not shadow the page the task lives in.
        const real = open.filter((p) => p.url() !== "about:blank");
        const next = real[real.length - 1] ?? open[open.length - 1]!;
        // …unless it is the SAME page under a new object (a bridge reconnection, e.g. after a
        // service-worker eviction): "the tab was closed" would be false of the TAB.
        const known = await this.recognise(next).catch(() => null);
        this.makeActive(next, known === "same" ? REIDENTIFIED_WHY : "the tab it was on was closed");
      }
      return;
    }
    if (this.browser) {
      this.browser = null;
      // The managed browser died under us; the ladder below relaunches it off-screen, and the
      // model is told so it re-observes instead of trusting stale refs.
      if (this.managedProfileDir) this.pendingNote = REOPENED_NOTE;
      this.resetObservationState();
      // Its page died with that connection; the claim below names the next one, or none.
      this.active = undefined;
    }

    // Extension mode without a named endpoint: find this home's bridge, or start one. Asked on
    // every (re)connect, so a bridge restarted since the last one is found again.
    if (this.cfg.extension && !this.cfg.cdpUrl) {
      const bridge = await acquireBridge(this.cfg.home);
      this.cdpUrl = bridge.cdpUrl;
      if (!(await waitForExtension(this.cdpUrl, bridge.fresh ? 0 : 15_000, this.cfg.home))) throw new SurfaceUnreadableError(await this.extensionGoneMessage());
    }
    const attempted = this.endpoints();
    let lastError: unknown;
    for (const url of attempted) {
      try {
        this.browser = await connectBrowserCdp(url);
      } catch (e) {
        lastError = e;
        // A browser with zero page targets rejects Playwright's handshake; one blank tab over
        // HTTP revives it. EXTERNAL endpoints only: for the managed browser a closed window is
        // the user's decision.
        if (await openBlankTab(url)) {
          try { this.browser = await connectBrowserCdp(url); }
          catch (retryError) { lastError = retryError; }
        }
      }
      if (this.browser) {
        await ensureRefSelector(this.browser);
        this.cdpUrl = url;
        break;
      }
    }

    if (!this.browser && !this.explicit) {
      // The managed browser (acquire.ts): keeps logins and OUTLIVES this process, so the next
      // run attaches through its published port. Throws with guidance when no Chrome exists —
      // never a silent degrade.
      const acquired = await acquireManagedBrowser(this.cfg.profileDir, this.cfg);
      this.browser = acquired.browser;
      this.cdpUrl = acquired.cdpUrl;
      this.managedProfileDir = acquired.profileDir;
      this.journal = new ActionJournal(
        acquired.profileDir,
        () => captureEvidenceShot(() => this.page()),
        () => { try { return this.page().url(); } catch { return ""; } }, // a lost page is still an action to record
        this.cfg,
      );
      this.attached = this.cfg.attached;
    }
    if (!this.browser) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
      throw new Error(msgEndpointUnavailable(this.cdpUrl, detail));
    }
    this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    // A reconnect that lands on a different browser behind the bridge says so too.
    this.noteBridgeSession(await bridgeBrowserSession(this.browser));
    if (this.attached) {
      // The profile is the user's: taking one of their tabs, even a blank one, puts the agent in
      // a window they are looking at. Open our own; `ownPages` keeps every other window out of
      // reach (see {@link openOwnWindow}).
      this.active = await this.openOwnWindow();
    } else if (this.tab?.isolated) {
      // The claim picks the context. `this.context` stays the wrapper (where page events fire);
      // the ID is what separates our pages from everyone else's.
      const claim = await claimIsolatedTab(this.browser, this.tab.key);
      this.active = claim.page;
      this.ctxId = claim.ctxId;
      this.pageCtxIds.set(claim.page, claim.ctxId);
      this.context = this.active.context();
    } else {
      // Tab selection policy (new tab / reuse / named claim / none) lives with acquisition.
      this.active = (await claimSessionTab(this.context, this.tab?.key ?? null, this.cfg)) ?? undefined;
    }
    if (this.active) this.claim(this.active);
    this.wireContext();
    await this.installKeepInTab(this.active);
    await this.publishClaim();
  }

  /** After every claim, a tab surface records in its endpoint file WHICH slice of the shared
   *  browser is its own, so a host acting on the file (the preview card's ×) closes that slice,
   *  never the whole browser (`publishTabIdentity` in acquire.ts). */
  private async publishClaim(): Promise<void> {
    if (!this.tab || !this.managedProfileDir || !this.active) return;
    try {
      const { targetId, ctxId } = await pageTargetInfo(this.active);
      publishTabIdentity(this.managedProfileDir, { key: this.tab.key, isolated: this.tab.isolated, ctxId, targetId });
    } catch {
      // Observer data — never fail the claim over it.
    }
  }

  /**
   * Per-context wiring, registered once per BrowserContext — on fresh connect, and again when an
   * isolated re-claim minted a new context (see {@link reclaimTab}).
   *
   * Page adoption: a new tab becomes active, as when a user follows a link, but only once it is
   * REAL (see adoptWhenReal): a tab that stays at about:blank (an extension's scratch page) would
   * otherwise strand every later action on an empty page. Attached: only tabs in OUR window.
   *
   * JS dialogs: with no listener Playwright dismisses them SILENTLY. Handle them and say so:
   * alert → accept; confirm/prompt are decisions the model never saw → dismiss; beforeunload →
   * accept, or its navigation hangs. The `dialog` verb overrides that for exactly one dialog.
   * Attached mode answers only dialogs on OUR pages.
   */
  private wireContext(): void {
    this.context.on("page", (p) => {
      // A page appearing is the ONE thing that makes Chrome frontmost, so it is the only moment
      // the focus net has to run (see focus-guard.ts); ours open in the background and never do.
      this.windowAppeared = true;
      this.adoptWhenReal(p);
    });
    this.context.on("dialog", (dialog) => {
      void (async () => {
        const dialogPage = dialog.page();
        if (this.attached && (!dialogPage || !(await this.ownsPage(dialogPage).catch(() => false)))) return;
        const kind = dialog.type();
        const armed = this.armedDialog;
        this.armedDialog = null; // one dialog, one answer — never a standing policy
        const accept = armed ? armed.accept : (kind === "alert" || kind === "beforeunload");
        // Whether the answer LANDED, not whether it was attempted: another CDP client (the
        // user's DevTools) may answer first, and the note is the model's only evidence.
        let landed = true;
        try { await (accept ? dialog.accept(armed?.text) : dialog.dismiss()); } catch { landed = false; }
        if (kind === "beforeunload") return; // plumbing, not a page fact worth a note
        const said = `a JS dialog appeared: «${dialog.message().slice(0, 120)}»`;
        const note = !landed
          ? `${said} — it was already answered before your ${accept ? "accept" : "dismiss"} `
            + "could land (another client shares this browser), so the page took an answer you did "
            + "not choose. Check what the page did before acting on it"
          // The armed case says who decided; the default note's "did not happen" would lie here.
          : armed
            ? `${said} — ${accept ? "accepted" : "dismissed"} as you asked`
              + (armed.text !== undefined ? ` with text «${armed.text.slice(0, 60)}»` : "")
            : `${said} — it was auto-${accept ? "accepted" : "dismissed"}; `
              + "if the flow needs a confirm, it did not happen";
        this.appendNote(note);
      })();
    });
  }

  /**
   * Keep clicks in one tab so the browser never grabs the user's keyboard (see KEEP_IN_TAB_JS).
   * Added once per context; the current page gets it directly because an init script only
   * reaches documents created after it. NOT gated on window position: a new tab makes Chrome
   * frontmost wherever its window sits.
   *
   * ATTACHED: an init script is CONTEXT-wide and would stop the user's own `_blank` links opening
   * tabs, so inject into our page only; an uncaught `_blank` opens in our window anyway.
   */
  private async installKeepInTab(page: Page | undefined): Promise<void> {
    if (this.keepInTabInstalled) return;
    if (!this.attached) {
      this.keepInTabInstalled = true;
      await this.context.addInitScript(KEEP_IN_TAB_JS).catch(() => { this.keepInTabInstalled = false; });
    }
    await page?.evaluate(KEEP_IN_TAB_JS).catch(() => {});
  }

  /**
   * Re-claim this surface's tab after every one of our pages closed. Shared mode reopens a
   * stamped tab in the shared context; isolated mode re-claims by stamp — and when the old
   * context died with its tab (nothing durable names an empty context), the claim minted a
   * fresh one, so the ownership id moves with it.
   */
  private async reclaimTab(): Promise<Page> {
    const tab = this.tab!;
    if (!tab.isolated) return claimNamedTab(this.context, tab.key);
    const { page, ctxId } = await claimIsolatedTab(this.browser!, tab.key);
    this.ctxId = ctxId;
    this.pageCtxIds.set(page, ctxId);
    if (page.context() !== this.context) {
      // Only on a Playwright that tracks foreign contexts as real wrappers: re-wire the new one.
      this.context = page.context();
      this.keepInTabInstalled = false;
      this.wireContext();
      await this.installKeepInTab(page);
    }
    return page;
  }
}
