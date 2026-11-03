/**
 * BrowserDriver — ComputerUseDriver over playwright-core via CDP: the observe/act primitives.
 * The other slice of the class — connection, tab claim and ownership — is
 * {@link BrowserDriverCore} (`driver-core.ts` → `driver-tabs.ts` → `driver-connect.ts`); those
 * headers map the chain and the ladder.
 */

import { Type } from "typebox";
import type { Page } from "playwright-core";
import { type ActResult, type HeaderChanges, type OwnershipResource, type Snapshot, type TargetInfo, SurfaceUnreadableError, text, type ToolResult, type VerbSpec, type Verdict } from "../types.ts";
import { NO_TAB_OPEN_NOTE, NO_TAB_YET_NOTE } from "./messages.ts";
import { PASTE_VERB, SELECT_OPTION_VERB } from "../chromium/actions-value.ts";
import { SELECT_TEXT_VERB } from "../chromium/select-text.ts";
import { DIALOG_VERB, DRAG_VERB, UPLOAD_VERB } from "../chromium/actions.ts";
import { RUN_JS_CODE_DESC } from "../chromium/run-js.ts";
import { BrowserDriverVerbs } from "./driver-verbs.ts";
import { previewPage } from "../chromium/preview.ts";
import { withPageCapture } from "../chromium/shot.ts";
import { DOWNLOAD_VERB } from "./downloads.ts";
import { bridgeRequest, bridgeTabs, restoreBridgeTab } from "./bridge-tabs.ts";

/** How long `close()` waits for the journal's queued line (one evidence shot's worth: the shot
 *  itself is capped at 4s, and a whole run's exit must not hang on an observer channel). */
const JOURNAL_DRAIN_MS = 5_000;

/** A LISTING's budget for one tab's title — see {@link boundedTitle}. */
const TITLE_BUDGET_MS = 1_500;

/**
 * One tab's title, or "" (callers fall back to the url) — never a wait worth noticing.
 *
 * `page.title()` runs in the page, and `listTargets` asks every tab at once, so an unbounded read
 * makes the LISTING as slow as the sickest tab: one playwright held without a url took 78 s to
 * fail. A listing is a READ and must not block on a page mid-navigation, hung in JS or waiting on
 * a beforeunload dialog.
 */
async function boundedTitle(page: { title(): Promise<string>; url(): string }): Promise<string> {
  // No url = playwright never saw this page navigate; asking it anything is the 78s case above.
  if (!page.url()) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.title().catch(() => ""),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), TITLE_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BrowserDriver extends BrowserDriverVerbs {
  private unloadedSelection: { id: string; tabId: number; targetId: string; browserSession: string } | null = null;

  override async activeTarget(): Promise<string | null> {
    return this.unloadedSelection?.id ?? super.activeTarget();
  }

  override async ownershipResources(): Promise<OwnershipResource[]> {
    if (this.unloadedSelection) return [{ key: `chromium:${this.unloadedSelection.targetId}`, mode: "exclusive" }];
    return super.ownershipResources();
  }

  override async prepareTarget(): Promise<void> {
    const selected = this.unloadedSelection;
    if (!selected) return;
    const { page, viewport } = await restoreBridgeTab(this.browser!, selected.tabId, selected.targetId, selected.browserSession);
    this.tabIds.set(page, selected.id);
    this.active = page;
    this.unloadedSelection = null;
    this.resetObservationState();
    const size = await page.evaluate("({ width: innerWidth, height: innerHeight })") as { width: number; height: number };
    if (size.width <= 0 || size.height <= 0) {
      // Reuse the viewport verb and its disconnect cleanup; no activation or native input.
      // With no measurable peer, the verb's documented default supplies a working viewport.
      const resized = await this.perform("viewport", viewport ?? {});
      if (!resized.ok) throw new SurfaceUnreadableError(`The restored tab has no usable viewport: ${resized.note ?? "resize failed"}`);
      this.appendNote("Chrome restored this background tab with a zero-size viewport; applied a temporary viewport, cleared when this driver disconnects.");
    }
    this.appendNote("Chrome had unloaded this tab; restored the same tab in the background. Read its current state before continuing.");
  }

  protected override page(): Page {
    if (this.unloadedSelection) throw new SurfaceUnreadableError(`Tab ${this.unloadedSelection.id} has not been restored; no other page was observed or operated.`);
    return super.page();
  }

  protected override adoptWhenReal(page: Page): void {
    if (!this.unloadedSelection) super.adoptWhenReal(page);
  }
  protected override previewTarget() {
    if (this.unloadedSelection) return Promise.resolve(null);
    if (!this.browser?.isConnected() || !this.active || this.active.isClosed()) return Promise.resolve(null);
    return previewPage(this.active, this.cdpUrl, "browser");
  }
  readonly platform = "browser";

  /** Close only tabs owned by this managed session unless the user chose to keep them. Attached
   * user Chrome is left alone; the host lifecycle still disconnects the driver afterwards. */
  override async turnEnded(info: { sessionId: string; turnId: string; hookEventName: string; keepBrowserTabs?: boolean }): Promise<void> {
    if (this.attached || info.keepBrowserTabs === true) return;
    const own = await this.ownPages().catch(() => []);
    for (const page of own) await page.close().catch(() => {});
    if (own.length) {
      this.closedItsLastTab = true;
      this.resetObservationState();
    }
  }

  // ── Declared variance ───────────────────────────────────────────────────────

  override extraVerbs(): VerbSpec[] {
    const verbs: VerbSpec[] = [
      { kind: "open_url", schema: Type.Object({ kind: Type.Literal("open_url"), url: Type.String({ description: "Full URL to open. Only URLs that appeared on a page or were given in the task — never guess domains." }) }) },
      { kind: "activate", schema: Type.Object({ kind: Type.Literal("activate") }, { description: "Bring this browser tab and its window to the foreground. This changes the user's foreground window: explain the effect and obtain permission unless it is already authorized. focus() only selects the target. Embedded writes normally wait for the person to yield the window; activate() is an explicit foreground handoff, revoked by subsequent human input. Do not use it to bypass an input wait without the user handing over control." }) },
      { kind: "back", schema: Type.Object({ kind: Type.Literal("back") }) },
      { kind: "reload", schema: Type.Object({ kind: Type.Literal("reload") }) },
      // A second tab of the session's own, on request. Popups a page opens are adopted where the
      // browser allows it, but in extension mode the bridge collects only tabs the agent itself
      // created — so multi-tab work needs a verb that creates one deliberately.
      { kind: "new_tab", schema: Type.Object({
        kind: Type.Literal("new_tab"),
        url: Type.Optional(Type.String({ description: "URL to open in it; omit for a blank tab" })),
      }, { description: "Open a NEW tab of this session's own and make it the target — the current tab keeps its state, and both are listed as targets afterwards." }) },
      // The counterpart of new_tab: in extension mode the session's tabs sit in the USER'S
      // window, and every one left behind is litter in a borrowed browser. A VERB, deliberately
      // with no lifecycle behind it: our host is any MCP client and nothing announces a turn end,
      // and `extension/group.js` makes the group DURABLE so the next session adopts what is in
      // it — closing on a boundary we cannot see would break that continuity.
      { kind: "close_tab", schema: Type.Object({
        kind: Type.Literal("close_tab"),
        id: Type.Optional(Type.String({ description: "Tab id from computer.surfaces(); omit to close the one you are on" })),
        all: Type.Optional(Type.Boolean({ description: "Close every tab this session opened or claimed — the tidy-up at the end of a job. Never the user's own, whatever else is set. Refused together with id." })),
        confirmed: Type.Optional(Type.Boolean({ description: "Only for a tab marked (user's): you ASKED the user in the conversation and they said yes. Never set it because closing would be convenient — the first refusal tells you to ask, and asking is the point." })),
      }, { description: "Close a tab. This session's own always; one of the user's (marked (user's) in the listing) only after you asked them in the conversation and they agreed — then pass confirmed: true." }) },
      // The one thing a virtualized list actually responds to. See the perform branch for the
      // measurement and for why the order (set, THEN navigate) is the whole contract.
      { kind: "viewport", schema: Type.Object({
        kind: Type.Literal("viewport"),
        width: Type.Optional(Type.Number({ description: "Viewport width in CSS pixels (default 1200)" })),
        height: Type.Optional(Type.Number({ description: "Viewport height in CSS pixels — this is the one that decides how much of a long list exists (default 1700)" })),
        reset: Type.Optional(Type.Boolean({ description: "Put the tab back to the real window size" })),
      }, { description: "Give THIS tab a viewport of your own size, so a virtualized list (a feed, a search page, a long transcript) mounts more of itself per read. Set it BEFORE opening the page: rows mount against the viewport in effect at load." }) },
      // What the PAGE knows about itself (localStorage, its own variables, an API it exposes) is
      // on no screen, so no verb can be shaped for it (chromium/run-js.ts has the line it must not
      // cross). Not in the grounding text: a channel to reach for, never the route to a control.
      { kind: "run_js", readOnly: true, schema: Type.Object({
        kind: Type.Literal("run_js"),
        code: Type.String({ description: RUN_JS_CODE_DESC }),
      }, { description: "Ask the PAGE something no observation carries — read its data in bulk, its stored state, or an API it exposes. This is a stranger's site holding the user's logged-in session: read and compute here, act through the interaction verbs." }) },
      DRAG_VERB, // press-drag-release; schema lives beside its implementation in actions.ts
      DIALOG_VERB, // arms the answer for the next JS dialog; put the action in the same call's `then`
      UPLOAD_VERB, // fills a file input, or arms the next file chooser
      DOWNLOAD_VERB,
      SELECT_OPTION_VERB,
      SELECT_TEXT_VERB,
      PASTE_VERB,
    ];
    return verbs;
  }

  /** Both observation channels answer plainly while the session holds no tab. They are the only
   * paths that must not throw for it: the repl takes one observation at the end of EVERY run, so
   * a close_tab({all}) that ends a job would otherwise report itself as a failed re-observation —
   * and a run on the user's browser that only listed tabs holds none yet ({@link NO_TAB_YET_NOTE}).
   * Everything else reaches {@link page} and gets the same note from there. */
  override async observeElements(opts: { prefix?: string; forceImage?: boolean; afterAction?: string } = {}): Promise<ToolResult> {
    const none = await this.noTabNote();
    if (none) return this.noTabObservation(none, opts.prefix);
    return super.observeElements(opts);
  }

  override async observeImage(opts: Parameters<BrowserDriverVerbs["observeImage"]>[0] = {}): Promise<ToolResult> {
    const none = await this.noTabNote();
    if (none) return this.noTabObservation(none, opts.prefix);
    return super.observeImage(opts);
  }

  /** Why the session holds no tab, or null when it holds one. Connects first: before that,
   *  `active` is unset in every mode, and only a connected session can be said to hold none. */
  private async noTabNote(): Promise<string | null> {
    if (this.closedItsLastTab) return NO_TAB_OPEN_NOTE;
    if (this.unloadedSelection) return null;
    await this.ensure();
    return this.active ? null : NO_TAB_YET_NOTE;
  }

  private noTabObservation(note: string, prefix?: string): ToolResult {
    // A one-shot fact rides this too (a browser change behind the bridge leaves the session here).
    const pending = this.takePendingNote();
    return text(`${prefix ? `${prefix}\n` : ""}${pending ? `NOTE: ${pending}.\n` : ""}${note}.`, { verdict: "unknown" });
  }

  /** A page's refs live in the document, so they die with it. */
  protected override staleRefCause(): string {
    return "it predates a navigation, a reload or a tab switch";
  }

  override promptFragment(): string {
    // Both routes out of a viewport-clipped list are named, find() first: with scrolling as the
    // only one named, the model scrolled even after a query handed it the ref. This text is NOT
    // free: it is the MCP initialize `instructions` (entries/mcp.ts), resident in every session,
    // so runtime facts belong in the observation instead.
    return "Grounding: observations are text lists of interactive elements with refs, for the CURRENT viewport only. " +
      "Act by ref from the latest observation. When what you want is NOT in the list: if you can name it, " +
      "w.find('<name>') searches EVERY control on the page and hands back a handle — act on it " +
      "directly, the click scrolls it into view, so do not scroll first. Scroll only to discover what you cannot name. " +
      "Observations may show only changes since the previous one; refs stay valid across observations (until navigation). " +
      "Use w.text() to read full page text.";
  }

  // ── Primitives ──────────────────────────────────────────────────────────────

  async listTargets(): Promise<TargetInfo[]> {
    await this.ensure();
    // Refresh metadata before reading Page objects: reconciliation may retire a renderer
    // Chrome just discarded, and no title read should revive it as a side effect.
    const { unloaded, browserSession } = !this.tab && !this.attached && !this.managedProfileDir
      ? await bridgeTabs(this.browser!) : { unloaded: [], browserSession: null };
    // The listing carries the bridge's nonce for free: a session holding no tab learns of a
    // browser change here, not only one whose bound tab vanished (driver-connect.ts).
    this.noteBridgeSession(browserSession);
    // Every visible tab, each marked with whether it is THIS SESSION'S. Hiding the user's tabs
    // would protect nothing; ownership does: `own: false` cannot be closed.
    const own = new Set(await this.ownPages());
    const pages = await this.visiblePages();
    const targets: TargetInfo[] = await Promise.all(pages.map(async (p) => ({
      id: this.tabId(p), kind: "tab" as const,
      title: (await boundedTitle(p)) || p.url(), active: !this.unloadedSelection && p === this.active,
      own: own.has(p),
    })));
    // Preserve named-slot and attached-window visibility: only an unrestricted extension
    // connection can discover the user's other tabs, including unloaded ones.
    for (const tab of unloaded) {
      const id = `unloaded:${tab.tabId}:${tab.browserSession}`;
      targets.push({ id, kind: "tab", title: `${tab.title || tab.url} [unloaded — use this handle to restore in background]`,
        active: this.unloadedSelection?.id === id, own: false, unloaded: true });
    }
    return targets;
  }

  protected override noteBridgeSession(session: string | null): boolean {
    const switched = super.noteBridgeSession(session);
    // An unloaded tab was selected by the previous browser's tab id; it names nothing now.
    if (switched) this.unloadedSelection = null;
    return switched;
  }

  override async actionResources(kind: string, args: Record<string, unknown>): Promise<OwnershipResource[]> {
    if (kind !== "close_tab") return [];
    const id = typeof args.id === "string" ? args.id.replace(/^browser\//, "") : null;
    const pages = args.all ? await this.ownPages() : id
      ? (await this.visiblePages()).filter(p => this.tabId(p) === id) : [this.page()];
    return Promise.all(pages.filter(p => !p.isClosed()).map(p => this.pageOwnership(p)));
  }

  async focusTarget(id: string): Promise<ActResult> {
    await this.ensure();
    const unloaded = /^unloaded:(\d+):(.*)$/.exec(id);
    if (unloaded && !this.tab && !this.attached && !this.managedProfileDir && this.browser!.version() === "mirasim-bridge") {
      const tabId = Number(unloaded[1]);
      const browserSession = unloaded[2]!;
      const { targetId } = await bridgeRequest<{ targetId: string }>(this.browser!, "Mirasim.tabTarget", { tabId, browserSession });
      this.unloadedSelection = { id, tabId, targetId, browserSession };
      this.closedItsLastTab = false; // holds a target again — see the visible-tab branch below
      return { ok: true, note: "Selected unloaded tab; restoration follows target ownership." };
    }
    let res: ActResult = { ok: false, note: `no target with id ${id}; call computer.surfaces() for current ids` };
    // Visible, not own: switching INTO the user's tab is the point of seeing it. What stays
    // refused is closing it — see the close_tab branch.
    for (const p of await this.visiblePages()) {
      if (p.isClosed() || this.tabId(p) !== id) continue;
      this.unloadedSelection = null;
      this.active = p;
      // Binding a tab ends the dormancy close_tab left behind; left set, `page()` would refuse
      // every read and act on the tab just bound (new_tab included).
      this.closedItsLastTab = false;
      // NOTHING is raised: `bringToFront()` activates the whole application, and CDP needs no
      // frontmost tab. Raising a window is for a person (the host's preview card).
      res = { ok: true };
      break;
    }
    // Journaled: a tab switch changes what every later line's url and shot MEAN.
    this.journal?.publishAction("focus", { target: id }, null, res);
    return res;
  }

  async close(): Promise<void> {
    this.unloadedSelection = null;
    await this.downloads.close();
    // The journal's pending line screenshots through the page handle we are about to drop, so
    // it lands FIRST (bounded, never fatal: journal.drain).
    await this.journal?.drain(JOURNAL_DRAIN_MS);
    // Put every tab we resized back first: the "mirasim" group is durable, so a tab left at a
    // size the user never chose would outlive this session on their screen.
    for (const page of this.overridden) {
      if (page.isClosed()) continue;
      await withPageCapture(page, () => this.cdpFor(page).then((s) => s.send("Emulation.clearDeviceMetricsOverride"))).catch(() => {});
    }
    this.overridden.clear();
    // An endpoint we did not launch opens the session a fresh tab (tabs.ts `claimSessionTab`) and
    // keeps every tab after we disconnect, so one nobody used was left behind per session
    // (measured: 17 sessions, 17 blank tabs). Close only what is ours AND still blank — there is
    // nothing in it to lose. Named tabs are claims meant to be found again, so they stay.
    if (!this.managedProfileDir && !this.tab && this.browser) {
      for (const page of await this.ownPages().catch(() => [])) {
        if (page.url() === "about:blank") await page.close().catch(() => {});
      }
    }
    // Disconnect only — never close the browser. Attached ones belong to the user; the managed
    // one is a device that outlives the command: its profile keeps logins and its published
    // port lets the next session adopt it instead of paying a launch (acquire.ts).
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.resetObservationState();
    this.resetPageState();
    await this.disconnected();
  }

  /** Frozen verdicts go to the journal too — see `ActionJournal.publishVerdict` (journal.ts). */
  protected override journalVerdict(verdict: Verdict): void {
    this.journal?.publishVerdict(verdict);
  }

  /**
   * A blank surface says so IN the observation, not only when a locate misses: an empty list on
   * about:blank reads as a page not yet rendered, and the model spends a step observing again.
   * The line names the way out: another tab holds the page, or nothing has been opened.
   *
   * Gated on the ACTUAL surface being blank and empty, never on a knob: `COMPUTER_USE_TAB` is the
   * durable tab claim, so keying on it would fire on a named surface that re-adopted a real page.
   */
  protected override renderHeadLines(s: Snapshot, targets: TargetInfo[], targetsUnchanged = false, changes?: HeaderChanges): string[] {
    const lines = super.renderHeadLines(s, targets, targetsUnchanged, changes);
    if (s.url === "about:blank" && s.elements.length === 0 && !s.text) {
      // Titles come from `title || url`, so a blank tab reads as its url here.
      const elsewhere = targets.some((t) => t.title !== "about:blank");
      lines.push(elsewhere
        ? "NOTE: this tab is blank — your page may be in another tab; computer.surfaces() lists it — act through its handle."
        : "NOTE: this tab is blank and nothing has been opened in it — navigate (openUrl({url})) instead of observing again.");
    }
    return lines;
  }

  /** Non-empty only when the active tab is about:blank while another tab has content. */
  protected override async blankSurfaceHint(): Promise<string> {
    try {
      if (this.page().url() !== "about:blank") return "";
      const others = (await this.ownPages()).some((p) => p !== this.page() && p.url() !== "about:blank");
      return others
        ? "the active tab is a blank page — your page may be in another tab; computer.surfaces() lists it — act through its handle"
        : "";
    } catch {
      return "";
    }
  }
}
