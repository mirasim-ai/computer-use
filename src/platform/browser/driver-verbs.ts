/**
 * The VERBS: what a tool call turns into on a browser page.
 *
 * The chain is `BrowserDriverConnect` (a live page that is ours) → this → `BrowserDriver` (what the
 * platform declares about itself, and the reads). `perform` decides whether the session is awake
 * enough for this verb, and `dispatch` maps a kind to the act, through the shared chromium
 * implementations so a verb behaves the same in a tab as in an Electron window.
 */

import { readFileSync } from "node:fs";
import { type Page } from "playwright-core";
import { type ActResult } from "../types.ts";
import { NO_TAB_OPEN_NOTE, NO_TAB_YET_NOTE, userTabCloseRefusal } from "./messages.ts";
import { endpointFileFor, keepInBackground } from "./acquire.ts";
import { isFrontmost, returnFocusIfTaken } from "./focus-guard.ts";
import { BrowserDriverConnect } from "./driver-connect.ts";
import { landedNote, NAV_TIMEOUT_MS, navVerdict } from "./navigate.ts";
import { newBackgroundPage } from "./tabs.ts";
import { detectInterference, overlaySensitive } from "./overlay-guard.ts";
import { performUploadToRef, refuseMissingFiles } from "../chromium/actions.ts";
import { performRunJs } from "../chromium/run-js.ts";
import { withPageCapture } from "../chromium/shot.ts";
export abstract class BrowserDriverVerbs extends BrowserDriverConnect {
  /** close_tab on an id the session holds no page for: a subclass that lists such tabs answers
   *  for them; null is "no such tab". */
  protected async closeDormantTab(_id: string, _confirmed: boolean): Promise<ActResult | null> {
    return null;
  }

  /** The managed browser's pid, resolved lazily by {@link browserPid}; null = unavailable. */
  private pid: number | null | undefined;
  /** One CDP session per page for window-state upkeep (ensureComposited) and the viewport verb. */
  private cdpSessions = new WeakMap<Page, import("playwright-core").CDPSession>();
  /** Tabs currently carrying a viewport override, so `close()` can put every one of them back:
   *  the group is durable, and a tab left at a size the user never chose is ours to undo. */
  protected readonly overridden = new Set<Page>();


  async perform(kind: string, a: Record<string, any>): Promise<ActResult> {
    // A receipt remains queryable after its tab closes; querying must never reopen a tab.
    if (kind === "download" && typeof a.id === "string") return await this.downloads.query(a.id, a.timeoutMs, a.stop, this.browser ?? undefined);
    // The two verbs that OPEN a tab wake a dormant session; everything else is answered without
    // one, so a click after close_tab({all}) says what is wrong instead of silently taking a
    // fresh tab in the user's window.
    if (kind === "open_url" || kind === "new_tab") {
      this.wokeAfterSelfClose = this.closedItsLastTab;
      this.closedItsLastTab = false;
    }
    else if (this.closedItsLastTab) return { ok: false, note: NO_TAB_OPEN_NOTE };
    await this.ensure();
    // Holding no tab yet (the extension bridge opens none up front): the two verbs that
    // open one open it here — and new_tab's tab IS this one, or a second would sit blank beside it.
    let openedTab: string | null = null;
    if (!this.active) {
      if (kind !== "open_url" && kind !== "new_tab") return { ok: false, note: NO_TAB_YET_NOTE };
      this.active = await newBackgroundPage(this.context);
      this.claim(this.active);
      if (kind === "new_tab") {
        openedTab = this.tabId(this.active);
        if (!a.url) return { ok: true, note: `new tab ${openedTab} is now the target` };
        kind = "open_url"; // what is left of new_tab is the navigation
      }
    }
    // Before the verb: the navigation listener must exist when the navigation fires, and
    // `open_url` is answered above `dispatchPage`, where the read paths attach it. Missed, the
    // session's FIRST navigation gets no post-nav wait and hands back a shell.
    this.hookNavigation();
    await this.ensureComposited();
    // Before anything can raise it: was this browser already the user's frontmost app?
    const hadFocus = await isFrontmost(this.browserPid());
    this.lastPoint = null;
    // Extension mode: another extension's overlay (autofill, password manager) may sit over the
    // page with no signal observation carries. Refuse the verb with a note instead of letting it
    // land on the interloper. Read verbs and pure navigation are exempt — an overlay does not
    // change what they return.
    if (this.cfg.extension && overlaySensitive(kind)) {
      const interferer = await detectInterference(this.page());
      if (interferer) {
        const note = `another extension or overlay is over the page right now — ${interferer}. `
          + "Close it (dismiss the popup, click away from the autofill suggestion, switch off the interfering extension for this site), then re-observe and act. "
          + "Acting now would land on the overlay, not the target.";
        this.journal?.publishAction(kind, a, this.lastPoint, { ok: false, note });
        return { ok: false, note };
      }
    }
    let res: ActResult;
    try {
      // Evidence capture is asynchronous. Let it finish before navigation or a viewport
      // change: Chrome's capture cleanup can otherwise restore the previous page size.
      const page = this.page();
      res = await withPageCapture(page, () => {
        if (this.page() !== page || page.isClosed()) {
          return Promise.resolve({ ok: false, note: "the target changed while waiting for capture — re-observe the intended tab before acting" });
        }
        return this.dispatch(kind, a);
      });
    } catch (e) {
      // A dispatch that THREW (Playwright timeout, detached frame, …) is still an action that
      // was attempted: journal it as ok:false with the reason, then propagate unchanged.
      const reason = e instanceof Error ? (e.message.split("\n")[0] ?? "dispatch failed") : String(e);
      this.journal?.publishAction(kind, a, this.lastPoint, { ok: false, note: reason });
      throw e;
    }
    if (openedTab) res = { ...res, note: `new tab ${openedTab} is now the target; ${res.note ?? ""}` };
    // Journal the dispatch verdict as-is — the pending note below is model context ("the
    // browser had been closed"), not evidence about THIS action, so it stays out of the line.
    this.journal?.publishAction(kind, a, this.lastPoint, res);
    // A tab the PAGE opened (`target=_blank`) raises the browser and cannot be stopped at the
    // source, so put the window back after. No-op unless the host asked for background mode or
    // while the user has revealed it.
    if (this.managedProfileDir && !this.closedItsLastTab && kind !== "activate") await keepInBackground(this.context, this.page(), this.managedProfileDir, this.cfg);
    // ...and if a window appeared anyway, give the keyboard back: focus follows the frontmost
    // APPLICATION, not the window (focus-guard.ts). `hadFocus` keeps this from fighting the user:
    // a browser already frontmost when the action started is one THEY are using.
    if (this.windowAppeared) {
      this.windowAppeared = false;
      if (!hadFocus && kind !== "activate") await returnFocusIfTaken(this.browserPid());
    }
    const note = this.takePendingNote();
    if (note) res.note = res.note ? `${note}. ${res.note}` : note;
    return res;
  }

  /** The managed browser's own pid, from the endpoint file it publishes. Read once — the
   *  browser outlives this process, and a pid that changed means a new endpoint file anyway. */
  private browserPid(): number | null {
    if (this.pid === undefined) {
      this.pid = null;
      try {
        const ep = JSON.parse(readFileSync(endpointFileFor(this.managedProfileDir!), "utf8")) as { pid?: number };
        if (typeof ep.pid === "number") this.pid = ep.pid;
      } catch {
        /* no endpoint file (or a torn write) — the net simply does not run */
      }
    }
    return this.pid;
  }

  /** One CDP session per page, cached. Two callers: the composited-state upkeep below and the
   *  viewport verb — both need the raw protocol on the page playwright already holds. */
  protected async cdpFor(page: Page): Promise<import("playwright-core").CDPSession> {
    let session = this.cdpSessions.get(page);
    if (!session) {
      session = await this.context.newCDPSession(page);
      this.cdpSessions.set(page, session);
    }
    return session;
  }

  /**
   * Un-minimize the managed window before acting. A minimized window stops COMPOSITING: wheel
   * input hangs its full CDP timeout and the screencast freezes. In offscreen mode the window then
   * goes back to the parking spot (minimizing meant "I don't want to see this"). Managed browsers
   * only — an attached browser's window is the user's.
   */
  private async ensureComposited(): Promise<void> {
    if (!this.managedProfileDir) return;
    try {
      const session = await this.cdpFor(this.page());
      const { windowId, bounds } = await session.send("Browser.getWindowForTarget");
      if (bounds.windowState !== "minimized") return;
      // windowState cannot be combined with a position in one call (CDP contract).
      await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      if (this.cfg.window === "offscreen") {
        await session.send("Browser.setWindowBounds", { windowId, bounds: { left: -4000, top: 200 } });
      }
    } catch {
      /* composited-state upkeep is best-effort — the action itself is the arbiter */
    }
  }

  private async dispatch(kind: string, a: Record<string, any>): Promise<ActResult> {
    const page = this.page();
    switch (kind) {
      case "download":
        if (a.stop || a.timeoutMs !== undefined) return { ok: false, note: "download stop/timeoutMs require an existing id; omit them to arm a watch" };
        return await this.downloads.arm(this.browser!, page);
      case "upload": {
        const paths: string[] = Array.isArray(a.paths) ? a.paths : [];
        const bad = refuseMissingFiles(paths);
        if (bad) return bad;
        if (a.ref) {
          const res = await performUploadToRef(paths, a.ref, () => this.locate(a.ref, a.name, false), () => this.missing(a.ref, a.name));
          // Here a chooser IS answerable, so the ref-route refusal keeps its second half.
          if (!res.ok && res.note?.includes("did not take the files")) {
            return { ...res, note: `${res.note}; for a button that opens a chooser, drop ref and click the button next` };
          }
          return res;
        }
        if (this.armedChooser) page.off("filechooser", this.armedChooser as any);
        const handler = (fc: { setFiles(p: string[]): Promise<void> }) => { void fc.setFiles(paths); };
        this.armedChooser = handler;
        page.once("filechooser", handler as any);
        return { ok: true, note: `the next file chooser will receive ${paths.length} `
          + `file${paths.length === 1 ? "" : "s"} — nothing has changed yet; click the control that opens it` };
      }
      case "dialog": {
        // Arming only: nothing changes yet, so the note says what WILL happen.
        this.armedDialog = { accept: a.answer === "accept", ...(typeof a.text === "string" ? { text: a.text } : {}) };
        return { ok: true, note: `the next JS dialog will be ${a.answer}ed — `
          + "nothing on the page has changed yet; the answer is used when the action that raises the dialog runs" };
      }
      case "open_url":
        // No `navPending` here: the navigation itself raises it (ChromiumPageDriver.hookNavigation),
        // which is the only way a click- or Enter-driven navigation gets the same treatment.
        try {
          await page.goto(a.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
          return { ok: true, note: landedNote("opened", a.url, page.url()) };
        } catch (e) { return navVerdict(e); }
      case "activate":
        await page.bringToFront();
        return { ok: true, note: "activated this browser tab and its window — foreground focus was requested explicitly" };
      case "run_js":
        // No navPending, no focus net, no journal beyond the note: it is a read channel. A caller
        // that CHANGES the page with it owes that in its report (the schema says so; nothing here
        // can enforce it).
        return await performRunJs(() => page, a.code);
      case "back": {
        // `commit`, not `domcontentloaded`: a bfcache restore produces NO new document, so the
        // load events never fire and the wait could only time out. Rendering is the settle/change
        // verdict's job after the act.
        //
        // The same restore carries no network Response, so a null return does NOT mean "nothing to
        // go back to"; the url before and after tells them apart (identical adjacent urls still
        // read as "no earlier page").
        const before = page.url();
        try {
          const resp = await page.goBack({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS });
          // The landing url, as `open_url` reports one: a history entry can be a redirect's
          // target, so "back" may not reach the page the caller pictures.
          return resp === null && page.url() === before
            ? { ok: true, note: "no earlier page in this tab's history" }
            : { ok: true, note: `went back to ${page.url()}` };
        } catch (e) { return navVerdict(e); }
      }
      case "reload": {
        const before = page.url();
        try {
          await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
          return { ok: true, note: landedNote("reloaded", before, page.url()) };
        } catch (e) { return navVerdict(e); }
      }
      case "new_tab": {
        const tab = await newBackgroundPage(this.context);
        this.claim(tab);
        // A model-requested move, like focusTarget: assigned, never raised, no announcement —
        // but observation continuity ends here (the delta base and rect table are keyed by refs
        // the new page will mint again from e0).
        this.active = tab;
        this.resetObservationState();
        const id = this.tabId(tab);
        if (typeof a.url === "string" && a.url) {
          try {
            await tab.goto(a.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
          } catch (e) {
            const v = navVerdict(e);
            return { ...v, note: `new tab ${id} is now the target; ${v.note ?? "its navigation did not finish"}` };
          }
          return { ok: true, note: `new tab ${id} is now the target; ${landedNote("opened", a.url, tab.url())}` };
        }
        return { ok: true, note: `new tab ${id} is now the target` };
      }
      case "viewport": {
        // A virtualized list mounts what fits the USER'S real window (x.com's feed: 3 posts per
        // read). The ORDER is the contract: an override on an ALREADY loaded page changes the
        // viewport but not the rows, because the virtualizer mounts on its own events; set BEFORE
        // the navigation, x.com gave 12 rows against 3.
        const session = await this.cdpFor(page);
        if (a.reset) {
          await session.send("Emulation.clearDeviceMetricsOverride");
          this.overridden.delete(page);
          return { ok: true, note: "viewport override cleared — this tab is back to the real window size" };
        }
        const width = Math.round(Number(a.width) || 1200);
        const height = Math.round(Number(a.height) || 1700);
        // Keep native pixel density: captures use another CDP session, whose own
        // native-density restore otherwise changes the page's DPR after each shot.
        await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: false });
        this.overridden.add(page);
        const actual = await page.evaluate("({ width: innerWidth, height: innerHeight })") as { width: number; height: number };
        if (actual.width !== width || actual.height !== height) {
          return { ok: false, note: `viewport ${width}x${height} did not take effect — the page reports ${actual.width}x${actual.height}` };
        }
        return { ok: true, note: `viewport of this tab set to ${width}x${height} — navigate AFTER this, `
          + "not before, or a list already mounted keeps the rows it has; the size is the user's own again "
          + "on viewport({reset:true}) or when this session ends" };
      }
      case "close_tab": {
        // `ownPages` is the boundary, the same one listTargets publishes: a tab this session did
        // not open or claim is not ours to close, and in extension mode the rest of that window
        // is the user's own browsing.
        const own = (await this.ownPages()).filter((p) => !p.isClosed());
        // `all`: closing one id at a time goes stale as the target moves, so the loop is done here,
        // where the ownership boundary lives. NOT lifecycle management: the caller asks (the
        // durable-group decision).
        if (a.all) {
          if (typeof a.id === "string" && a.id) {
            return { ok: false, note: "close_tab takes id OR all, not both — all closes every tab this session owns" };
          }
          for (const p of own) await p.close().catch(() => {});
          this.closedItsLastTab = true;
          return { ok: true, note: `closed ${own.length} tab${own.length === 1 ? "" : "s"} — every one this session `
            + "opened or claimed; the user's own tabs were not touched. open_url or new_tab starts a fresh one" };
        }
        // With several platforms mounted, computer.surfaces() lists ids as "browser/t1"; accept the
        // id exactly as that listing gave it.
        const id = typeof a.id === "string" && a.id ? a.id.replace(`${this.platform}/`, "") : this.tabId(page);
        let target = own.find((p) => this.tabId(p) === id);
        let theirs = false;
        if (!target) {
          // Two refusals: the listing carries the user's tabs too, so for those "no tab with id X"
          // would be a lie — what is wrong is whose tab it is.
          const visible = (await this.visiblePages()).find((p) => this.tabId(p) === id);
          if (!visible) {
            const dormant = await this.closeDormantTab(id, a.confirmed === true);
            return dormant ?? { ok: false, note: `no tab with id ${id} — call computer.surfaces() for current ids` };
          }
          if (!a.confirmed) return { ok: false, note: userTabCloseRefusal(id) };
          target = visible;
          theirs = true;
        }
        const wasActive = target === this.active;
        await target.close().catch(() => {});
        // Say whose it was: a model repeats its last note to the person, who needs to see "closed
        // one of your tabs" if the asking went wrong.
        const whose = theirs ? " — the user's own, closed on the agreement you reported" : "";
        if (!wasActive) return { ok: true, note: `closed tab ${id}${whose}; the target is unchanged` };
        // Closing the tab you are ON moves the target: refs are minted per page and collide
        // across tabs, so the note carries the tab-switch warning.
        const next = own.find((p) => p !== target && !p.isClosed());
        if (!next) {
          this.closedItsLastTab = true;
          return { ok: true, note: `closed tab ${id}${whose} — this session has no tab left; open_url or new_tab starts a fresh one` };
        }
        this.active = next;
        this.resetObservationState();
        return { ok: true, note: `closed tab ${id}${whose}; the target moved to ${this.tabId(next)} — re-observe before acting on any earlier ref` };
      }
    }
    // The seven universal verbs: ChromiumPageDriver owns them, shared with the electron driver.
    return (await this.dispatchPage(kind, a)) ?? { ok: false, note: `unknown action kind ${kind}` };
  }

}
