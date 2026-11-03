/**
 * WHICH PAGE IS OURS: claiming a tab, recognising it again after a re-mint, and picking the one a
 * verb acts on.
 *
 * A Playwright `Page` object can be replaced under us and a tab can be closed by the page itself;
 * Chrome's targetId is the only name that survives both, so ownership is tracked by object (the
 * hot path) AND by targetId. {@link BrowserDriverConnect} is the slice above.
 */

import { type Frame, type Page } from "playwright-core";
import { userWantsVisible } from "./acquire.ts";
import { pageContextId, pageTargetInfo } from "./tabs.ts";
import { msgOwnWindowFailed, NO_TAB_OPEN_NOTE, NO_TAB_YET_NOTE } from "./messages.ts";
import { SAVE_PICKER_JS } from "./save-picker.ts";
import { SurfaceUnreadableError } from "../types.ts";
import { ADOPTED_WHY, APPEARED_WHY, BrowserDriverCore, REIDENTIFIED_WHY } from "./driver-core.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export abstract class BrowserDriverTabs extends BrowserDriverCore {
  /** Take ownership of a page: the object for the hot path, its Chrome targetId for the
   *  identity that survives a re-mint. The id is read in the background — a claim must not
   *  wait on a CDP round trip, and a page that dies before it answers was never re-findable. */
  protected claim(p: Page): void {
    this.mine.add(p);
    this.rememberIdentity(p);
    this.armSavePicker(p);
  }

  /** Give an OWNED page the save-picker shim (see save-picker.ts): registered for its later
   *  documents, run once in the current one. In the background like the identity read — a page
   *  that refuses it keeps its native panel, which is the behaviour without the shim. Never on a
   *  tab the user opened: their own saves stay theirs. */
  private armSavePicker(p: Page): void {
    if (this.savePickerPages.has(p)) return;
    this.savePickerPages.add(p);
    void p.addInitScript(SAVE_PICKER_JS).catch(() => {});
    void p.evaluate(SAVE_PICKER_JS).catch(() => {});
  }

  /** Record a page's Chrome targetId as ours, and as the ACTIVE one while it still is. */
  protected rememberIdentity(p: Page): void {
    void pageTargetInfo(p).then(({ targetId }) => {
      if (!targetId) return;
      this.ownedTargetIds.add(targetId);
      if (this.active === p) this.activeTargetId = targetId;
    }).catch(() => {});
  }

  /**
   * What a page that is not in `mine` actually is, by Chrome's identity rather than by
   * playwright's object: `same` = the very page `active` pointed at (a re-mint), `ours` =
   * another tab this session owns, null = not ours at all. Either of the first two re-claims it.
   */
  protected async recognise(p: Page): Promise<"same" | "ours" | null> {
    const { targetId } = await pageTargetInfo(p).catch(() => ({ targetId: "" }));
    if (!targetId || !this.ownedTargetIds.has(targetId)) return null;
    this.mine.add(p);
    this.armSavePicker(p); // a re-minted page lost the old object's init script
    return targetId === this.activeTargetId ? "same" : "ours";
  }

  /** Prove (once) whether a page is in OUR isolated context — see {@link pageCtxIds}. */
  private async ownsIsolatedPage(p: Page): Promise<boolean> {
    let id = this.pageCtxIds.get(p);
    if (id === undefined) {
      id = await pageContextId(p).catch(() => "");
      this.pageCtxIds.set(p, id);
    }
    return id !== "" && id === this.ctxId;
  }

  /** Make a new page the active one — immediately when it already has a URL, otherwise
   * after its first real navigation (bounded: a page still on about:blank after 1.5s is
   * not adopted at all). Attached mode additionally requires our own window; named-tab mode
   * requires the page to have been OPENED BY one of ours (its opener) — on a shared browser
   * the page event also fires for every other surface's freshly-created tabs. */
  protected adoptWhenReal(p: Page): void {
    const adopt = () => {
      if (this.tab?.isolated) {
        // Everything in OUR context is this surface's — even an opener-less (noopener)
        // popup — and nothing outside it is, however it was opened.
        void this.ownsIsolatedPage(p).then((own) => {
          if (own) { this.claim(p); this.makeActive(p, ADOPTED_WHY); }
        }).catch(() => {});
        return;
      }
      if (this.tab) {
        void p.opener().then((o) => {
          if (o && this.mine.has(o)) { this.claim(p); this.makeActive(p, ADOPTED_WHY); }
        }).catch(() => {});
        return;
      }
      if (!this.attached) {
        if (this.mine.has(p)) { this.makeActive(p, ADOPTED_WHY); return; }
        // A stranger by object may still be ours by identity — ask Chrome before saying so.
        void this.recognise(p)
          .then((known) => this.makeActive(p, known === "same" ? REIDENTIFIED_WHY : known === "ours" ? ADOPTED_WHY : APPEARED_WHY))
          .catch(() => this.makeActive(p, APPEARED_WHY));
        return;
      }
      void this.ownsPage(p).then((own) => { if (own) this.makeActive(p, ADOPTED_WHY); }).catch(() => {});
    };
    if (p.url() !== "about:blank") { adopt(); return; }
    const onNav = (frame: Frame) => {
      if (frame !== p.mainFrame() || p.isClosed() || p.url() === "about:blank") return;
      clearTimeout(timer);
      p.off("framenavigated", onNav);
      adopt();
    };
    const timer = setTimeout(() => p.off("framenavigated", onNav), 1500);
    timer.unref?.();
    p.on("framenavigated", onNav);
  }

  protected page(): Page {
    // No page, by the session's own decision. Every read and act path arrives here, so one guard
    // gives them all the same sentence instead of a playwright error about a closed target.
    if (this.closedItsLastTab) throw new SurfaceUnreadableError(NO_TAB_OPEN_NOTE);
    if (!this.active) throw new SurfaceUnreadableError(NO_TAB_YET_NOTE);
    if (this.active.isClosed()) {
      // Synchronous, so ownership can only be read from the cache — and a page we have not
      // proven ours is skipped. Falling back to another surface's (or the user's) tab is the
      // one mistake that must not happen here; a closed page is recoverable (`ensure` reopens).
      const open = this.context.pages().filter(
        (p) => !p.isClosed()
          && (this.tab ? (this.tab.isolated ? this.pageCtxIds.get(p) === this.ctxId : this.mine.has(p))
            : !this.attached || this.ownWindowId === null || this.windowIds.get(p) === this.ownWindowId),
      );
      // Prefer a tab with real content — a stray about:blank must not shadow the page
      // the task actually lives in.
      const real = open.filter((p) => p.url() !== "about:blank");
      this.makeActive(real[real.length - 1] ?? open[open.length - 1] ?? this.active, "the tab it was on was closed");
    }
    return this.active;
  }

  /**
   * Open the agent's OWN window and remember it — the whole of attached mode rests on this.
   *
   * `Target.createTarget{newWindow}`, not `context.newPage()`: the latter activates the
   * application and steals the keyboard even when the window is off-screen. Only OUR window is
   * parked off-screen; the user's stay put.
   */
  protected async openOwnWindow(): Promise<Page> {
    const before = new Set(this.context.pages());
    const session = await this.browser!.newBrowserCDPSession();
    try {
      await session.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
    } finally {
      await session.detach().catch(() => {});
    }
    let page: Page | undefined;
    for (let i = 0; i < 40; i++) {
      page = this.context.pages().find((p) => !before.has(p) && !p.isClosed());
      if (page) break;
      await sleep(25);
    }
    if (!page) throw new Error(msgOwnWindowFailed());
    const cdp = await this.context.newCDPSession(page);
    try {
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      this.ownWindowId = windowId;
      this.windowIds.set(page, windowId);
      // Off-screen only when the host asked for a background browser, and never once the user
      // has asked to look at it (the preview panel's reveal flag).
      if (this.cfg.window === "offscreen" && !(this.managedProfileDir && userWantsVisible(this.managedProfileDir))) {
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: -4000, top: 200 } });
      }
    } catch {
      // Presentation only — a window we could not place is still a window we can drive.
    } finally {
      await cdp.detach().catch(() => {});
    }
    return page;
  }

  /** Is this page inside the agent's own window? Always true when not attached. */
  protected async ownsPage(p: Page): Promise<boolean> {
    if (!this.attached || this.ownWindowId === null) return true;
    let id = this.windowIds.get(p);
    if (id === undefined) {
      try {
        const cdp = await this.context.newCDPSession(p);
        try { id = (await cdp.send("Browser.getWindowForTarget")).windowId; }
        finally { await cdp.detach().catch(() => {}); }
        this.windowIds.set(p, id);
      } catch {
        return false; // cannot prove it is ours ⇒ treat it as the user's
      }
    }
    return id === this.ownWindowId;
  }

  /**
   * The pages this driver may act on: every open page normally, ONLY those in the agent's own
   * window when attached, ONLY our claimed/opened tabs in named-tab mode (other tabs of a shared
   * browser are parallel surfaces' work). Every enumeration goes through here — a stray
   * `context.pages()` is how cross-surface typing happens.
   */
  protected async ownPages(): Promise<Page[]> {
    const open = this.context.pages().filter((p) => !p.isClosed());
    if (this.tab?.isolated) {
      // The whole isolated context is this surface's — and nothing outside it, which the
      // wrapper cannot tell apart (it files every foreign context's pages here too).
      const mine: Page[] = [];
      for (const p of open) if (await this.ownsIsolatedPage(p)) mine.push(p);
      return mine;
    }
    if (this.tab) return open.filter((p) => this.mine.has(p));
    // An endpoint we did not launch is not ours, so neither are its tabs: the bridge exposes
    // every tab the user has open (extension/group.js), and `return open` would let
    // `close_tab({all})` close the person's browsing. Visibility is wider (visiblePages).
    if (!this.managedProfileDir) return open.filter((p) => this.mine.has(p));
    if (!this.attached || this.ownWindowId === null) return open;
    const mine: Page[] = [];
    for (const p of open) if (await this.ownsPage(p)) mine.push(p);
    return mine;
  }

  /**
   * What the session may SEE: every tab the endpoint exposes, so a task about a page the user
   * already has open needs no hand-over. The counterpart of {@link ownPages} (what it may CLOSE);
   * the difference is rendered on every targets line (`TargetInfo.own`).
   *
   * Only on an endpoint we did not launch: a managed browser is ours entirely, and attached mode
   * keeps its boundary of a WINDOW of the user's own Chrome.
   */
  protected async visiblePages(): Promise<Page[]> {
    // Seeing every tab is for a session sharing the browser with its USER. A session holding a
    // tab CLAIM (`name:`/`ctx:`) shares it with PEERS, and widening would let it read and focus a
    // parallel surface's page (test/named-tabs.ts). `reuse` is NOT a claim: it is the extension
    // default.
    if (this.managedProfileDir || this.attached || this.tab) return this.ownPages();
    return this.context.pages().filter((p) => !p.isClosed());
  }

  protected tabId(p: Page): string {
    let id = this.tabIds.get(p);
    if (!id) { id = `t${this.nextTabId++}`; this.tabIds.set(p, id); }
    return id;
  }
}
