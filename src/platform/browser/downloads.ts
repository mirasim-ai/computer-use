/** Download watches are armed before the triggering action and survive later tool calls.
 * Managed downloads use Chrome's page identity, GUID and actual completion path.
 * The extension keeps Chrome's own location; a tab-scoped CDP event proves the source,
 * and the native download ledger supplies the final path. Duplicate URL matches are ambiguous.
 */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import type { Browser, CDPSession, Page } from "playwright-core";
import { browserArtifactsDir } from "./cdp-connection.ts";
import { SAVE_PICKER_REGISTRY } from "./save-picker.ts";
import { readableFrames } from "../chromium/frames.ts";
import type { ActResult, VerbSpec } from "../types.ts";
import { computerUseHome } from "../home.ts";

type State = "armed" | "in_progress" | "complete" | "failed" | "ambiguous" | "unavailable";
interface NativeDownload {
  id: number;
  url: string;
  finalUrl: string;
  filename: string;
  state: "in_progress" | "complete" | "interrupted";
  error?: string;
  exists: boolean;
}
interface NativeSnapshot { host: string; items: NativeDownload[] }
interface DownloadFrameTree { frame: { id: string }; childFrames?: DownloadFrameTree[] }
interface Receipt {
  id: string;
  state: State;
  url: string;
  filename: string;
  path: string | null;
  host: string;
  nativeId?: number;
  error?: string;
  candidates?: Array<{ nativeId: number; path: string; state: string }>;
  /** The page asked for a native save panel (`showSaveFilePicker`); the shim saved it as this
   *  download instead (save-picker.ts). */
  source?: "save-picker";
  /** Chrome's ledger has the download in progress with no path yet: the user's "Ask where to
   *  save each file" setting has its own save panel waiting for a person (extension only). */
  awaitingLocation?: true;
}
interface Watch {
  id: string;
  page: Page;
  since: string;
  until?: string;
  before: Set<number>;
  host: string;
  receipts: Receipt[];
  native: boolean;
  session: CDPSession | null;
  lastEvent: number;
  /** In-flight `source` reads (see {@link BrowserDownloads.markSource}); a query waits for them. */
  marks: Set<Promise<void>>;
  stop(): void;
  dispose?(): void;
}

export const DOWNLOAD_VERB: VerbSpec = {
  kind: "download",
  readOnly: true,
  schema: Type.Object({
    kind: Type.Literal("download"),
    id: Type.Optional(Type.String({ description: "Watch or download ID returned by an earlier download call; omit to arm a new watch BEFORE clicking or pressing the control that downloads." })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 15000, description: "Query wait budget, 0–15000 ms (default 10000). Timeout keeps the ID and returns the current state; query again later." })),
    stop: Type.Optional(Type.Boolean({ description: "Stop collecting new downloads for this watch; existing downloads keep progressing and remain queryable." })),
  }, { description: "Return a structured browser download receipt. First call without id to watch THIS tab, then trigger the download through an interaction verb, then query with id. Results include state, downloads with IDs, final filename/path, host and failure reason; ambiguous candidates are never silently selected. Files completed on this machine remain usable after the session ends. A query that runs out of budget while a native save panel is likely waiting for a person says so in hint. On tabs this session opened, a page's own save dialog (showSaveFilePicker) never opens: the file arrives here as an ordinary download marked source \"save-picker\", in the browser's download folder rather than where the page would have asked." }),
};

const send = <T>(s: CDPSession, method: string, params: object): Promise<T> =>
  (s as unknown as { send(m: string, p: object): Promise<T> }).send(method, params);
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class BrowserDownloads {
  private watches = new Map<string, Watch>();
  private saving = new Set<Promise<void>>();
  private root: CDPSession | null = null;
  private source: Browser | null = null;
  private bridge = false;

  private async connect(browser: Browser): Promise<void> {
    if (this.root && this.source === browser) return;
    await this.root?.detach().catch(() => {});
    this.root = null;
    const root = await browser.newBrowserCDPSession();
    try {
      const version = await root.send("Browser.getVersion");
      this.bridge = version.product === "Chrome/mirasim-bridge";
      this.root = root;
      this.source = browser;
      browser.once("disconnected", () => {
        for (const watch of this.watches.values()) if (watch.page.context().browser() === browser) watch.stop();
      });
    } catch (e) {
      await root.detach().catch(() => {});
      throw e;
    }
  }

  private async snapshot(since: string, until?: string): Promise<NativeSnapshot> {
    if (!this.root) throw new Error("The original browser connection is unavailable");
    return await send<NativeSnapshot>(this.root!, "Mirasim.downloads", { since, until });
  }

  async arm(browser: Browser, page: Page): Promise<ActResult> {
    if (this.watches.size >= 100) return { ok: false, note: "This session already has 100 download watches; start a new session before arming more." };
    await this.connect(browser);
    const since = new Date(Date.now() - 1000).toISOString();
    const snapshot = this.bridge ? await this.snapshot(since) : null;
    // One collection per tab. Re-arming ends the earlier collection, never its downloads.
    for (const old of this.watches.values()) if (old.page === page) old.stop();
    const watch: Watch = {
      id: `watch-${randomUUID()}`, page, since, before: new Set(snapshot?.items.map(i => i.id)),
      host: snapshot?.host ?? hostname(), receipts: [], native: this.bridge,
      session: null, lastEvent: Date.now(), marks: new Set(), stop: () => {},
    };
    if (this.bridge) {
      const session = await page.context().newCDPSession(page);
      watch.session = session;
      const begin = (event: { guid: string; url: string; suggestedFilename: string }) => {
        watch.lastEvent = Date.now();
        const receipt: Receipt = { id: event.guid, state: "in_progress", url: event.url,
          filename: event.suggestedFilename, path: null, host: watch.host };
        watch.receipts.push(receipt);
        this.markSource(watch, receipt);
      };
      const progress = (event: { guid: string; state: string }) => {
        const receipt = watch.receipts.find(r => r.id === event.guid);
        if (receipt && event.state === "canceled") {
          receipt.state = "failed";
          receipt.error = "Browser canceled the download";
        }
      };
      session.on("Page.downloadWillBegin", begin);
      session.on("Page.downloadProgress", progress);
      // These listeners MUST precede the action. Page events work on chrome.debugger even
      // though Browser download events (and Playwright's download object) do not.
      watch.stop = () => {
        watch.until ??= new Date().toISOString();
        session.off("Page.downloadWillBegin", begin);
        session.off("Page.downloadProgress", progress);
        page.off("close", watch.stop);
      };
      try { await session.send("Page.enable"); }
      catch (e) { watch.stop(); await session.detach().catch(() => {}); throw e; }
      page.once("close", watch.stop);
    } else {
      const session = await page.context().newCDPSession(page);
      watch.session = session;
      const root = this.root!;
      const pending = new Map<string, { receipt: Receipt; finish(): void }>();
      const frames = new Set<string>();
      const addFrames = (tree: DownloadFrameTree): void => {
        frames.add(tree.frame.id);
        for (const child of tree.childFrames ?? []) addFrames(child);
      };
      const attached = (event: { frameId: string }) => { frames.add(event.frameId); };
      const navigated = (event: { frame: { id: string } }) => { frames.add(event.frame.id); };
      const detached = (event: { frameId: string }) => { frames.delete(event.frameId); };
      const begin = (event: { guid: string; frameId: string; url: string; suggestedFilename: string }) => {
        if (!frames.has(event.frameId)) return;
        watch.lastEvent = Date.now();
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(event.guid)) {
          watch.receipts.push({ id: `download-${randomUUID()}`, state: "failed", url: event.url,
            filename: event.suggestedFilename, path: null, host: watch.host, error: "The browser supplied an invalid download identifier" });
          return;
        }
        const receipt: Receipt = { id: `download-${event.guid}`, state: "in_progress", url: event.url,
          filename: event.suggestedFilename, path: null, host: watch.host };
        watch.receipts.push(receipt);
        this.markSource(watch, receipt);
        let finish!: () => void;
        const task = new Promise<void>((resolve) => { finish = resolve; });
        pending.set(event.guid, { receipt, finish });
        this.saving.add(task);
        void task.finally(() => this.saving.delete(task));
      };
      const progress = (event: { guid: string; state: string; filePath?: string }) => {
        const entry = pending.get(event.guid);
        if (!entry || event.state === "inProgress") return;
        pending.delete(event.guid);
        if (event.state === "canceled") {
          entry.receipt.state = "failed";
          entry.receipt.error = "Browser canceled the download";
          entry.finish();
        } else if (event.state === "completed") {
          // A departing CDP client can restore Chrome's default destination. The browser's
          // final path for this exact, page-proven GUID is authoritative, not Playwright's
          // per-client artifact guess. Older Chrome falls back only to our GUID staging path.
          // A file the browser saved somewhere of its own choosing (its default folder, or a host
          // browser that keeps its own destination) is the user's download: reported where it is.
          const staging = join(browserArtifactsDir(), event.guid);
          const theirs = !!event.filePath && resolve(dirname(event.filePath)) !== resolve(browserArtifactsDir());
          void (theirs ? this.inPlace(event.filePath!, entry.receipt) : this.persist(event.filePath || staging, entry.receipt))
            .then(async () => { if (entry.receipt.state === "complete" && (!event.filePath || event.filePath === staging)) await unlink(staging).catch(() => {}); })
            .finally(entry.finish);
        } else pending.set(event.guid, entry);
      };
      session.on("Page.frameAttached", attached);
      session.on("Page.frameNavigated", navigated);
      session.on("Page.frameDetached", detached);
      root.on("Browser.downloadWillBegin", begin);
      root.on("Browser.downloadProgress", progress);
      watch.stop = () => {
        watch.until ??= new Date().toISOString();
        root.off("Browser.downloadWillBegin", begin);
        session.off("Page.frameAttached", attached);
        session.off("Page.frameNavigated", navigated);
        session.off("Page.frameDetached", detached);
        page.off("close", watch.stop);
      };
      watch.dispose = () => {
        root.off("Browser.downloadProgress", progress);
        for (const { receipt, finish } of pending.values()) {
          receipt.state = "unavailable";
          receipt.error = "The download connection closed before completion";
          finish();
        }
        pending.clear();
      };
      try {
        await session.send("Page.enable");
        addFrames((await session.send("Page.getFrameTree")).frameTree);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        const { browserContextIds } = await root.send("Target.getBrowserContexts");
        const contextId = targetInfo.browserContextId;
        await root.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: browserArtifactsDir(), eventsEnabled: true,
          ...(contextId && browserContextIds.includes(contextId) ? { browserContextId: contextId } : {}) });
      } catch (e) { watch.stop(); watch.dispose(); await session.detach().catch(() => {}); throw e; }
      page.once("close", watch.stop);
    }
    this.watches.set(watch.id, watch);
    return this.result(watch, "armed", false);
  }

  /**
   * Mark a download the save-picker shim made. Its blob URL is in the page's registry while that
   * document lives — read now, when the download has just begun, because a later navigation
   * takes the registry with it. A page that does not answer within a second leaves the receipt
   * unmarked: the mark is an annotation, never a reason to hold the receipt back.
   */
  private markSource(watch: Watch, receipt: Receipt): void {
    if (!receipt.url.startsWith("blob:")) return;
    const ask = (frame: ReturnType<Page["frames"]>[number]) => frame.evaluate(
      ([key, url]) => !!(globalThis as unknown as Record<symbol, Set<string> | undefined>)[Symbol.for(key)]?.has(url),
      [SAVE_PICKER_REGISTRY, receipt.url] as const,
    ).catch(() => false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = Promise.race([
      Promise.all(readableFrames(watch.page).map(ask)).then((hits) => { if (hits.includes(true)) receipt.source = "save-picker"; }),
      new Promise<void>((r) => { timer = setTimeout(r, 1000); }),
    ]).finally(() => { clearTimeout(timer); watch.marks.delete(task); });
    watch.marks.add(task);
  }

  /**
   * Why a query that ran out of budget may be waiting on a person: a native save panel the
   * browser driver cannot see. Two facts point at one — Chrome's ledger saying no location was
   * chosen yet, or, when nothing began, a page whose save dialog is the browser's real one
   * because it has no shim (a tab the user opened). Without either fact there is no hint: an
   * idle watch is an ordinary timeout.
   */
  private async stuckHint(watch: Watch, receipts: Receipt[], state: State): Promise<string | undefined> {
    if (receipts.some((r) => r.state === "in_progress" && r.awaitingLocation)) {
      return "Chrome is asking where to save this file (its \"Ask where to save each file\" setting): a native save "
        + "panel is open in the user's Chrome, out of the browser driver's reach. Bind Google Chrome with the macOS driver "
        + "(for a background tab the panel is a window of its own titled Save) and press Save or Cancel in that panel, or ask the user to turn the setting off; then query this ID again.";
    }
    if (state !== "armed" || watch.page.isClosed()) return undefined;
    const native = (frame: ReturnType<Page["frames"]>[number]) => frame.evaluate(
      (key) => typeof (globalThis as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function"
        && !(globalThis as unknown as Record<symbol, unknown>)[Symbol.for(key)],
      SAVE_PICKER_REGISTRY,
    ).catch(() => false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unshimmed = await Promise.race([
      Promise.all(readableFrames(watch.page).map(native)).then((hits) => hits.includes(true)),
      new Promise<false>((r) => { timer = setTimeout(() => r(false), 1000); }),
    ]).finally(() => clearTimeout(timer));
    return unshimmed
      ? "No download began. This tab keeps the browser's real save dialog (it is not one this session opened), so if the "
        + "control saves through the page's own save dialog (showSaveFilePicker), a native save panel may be waiting for a "
        + "person: bind the browser's app with the macOS driver and press Save or Cancel there. If the tab was not its "
        + "window's active tab, the browser refused the panel and the page got AbortError instead: make the tab active and "
        + "trigger the save again."
      : undefined;
  }

  private async inPlace(path: string, receipt: Receipt): Promise<void> {
    try {
      await stat(path);
      receipt.filename = basename(path.replace(/\\/g, "/")) || receipt.filename;
      receipt.path = path;
      receipt.state = "complete";
    } catch (e) {
      receipt.state = "failed";
      receipt.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async persist(source: string, receipt: Receipt): Promise<void> {
    try {
      // A unique directory prevents overwrites, including concurrent same-named downloads.
      const dir = join(computerUseHome(), "downloads", receipt.id);
      const name = basename(receipt.filename.replace(/\\/g, "/")).replace(/[\x00-\x1f:<>"|?*]/g, "_").slice(0, 180);
      receipt.filename = name && name !== "." && name !== ".." ? name : "download";
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, receipt.filename);
      await copyFile(source, path);
      await stat(path);
      receipt.path = path;
      receipt.state = "complete";
    } catch (e) {
      receipt.state = "failed";
      receipt.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async refresh(watch: Watch): Promise<void> {
    if (!watch.native || !watch.receipts.length) return;
    if (!this.bridge) throw new Error("This watch belongs to the original extension browser");
    const { items } = await this.snapshot(watch.since, watch.until);
    for (const receipt of watch.receipts) {
      if (receipt.state === "ambiguous") continue; // A later ledger deletion cannot prove which candidate was ours.
      // Inspect ALL matching new records, even after a previous successful query. Taking the
      // newest or matching the suggested filename loses same-named and concurrent downloads.
      const candidates = items.filter(i => !watch.before.has(i.id) && (i.finalUrl === receipt.url || i.url === receipt.url));
      const sameUrl = watch.receipts.filter(r => r.url === receipt.url);
      if (candidates.length > 1 || sameUrl.length > 1) {
        receipt.state = "ambiguous";
        receipt.path = null;
        delete receipt.nativeId;
        receipt.error = "Multiple downloads match this page's event; no file was selected";
        receipt.candidates = candidates.map(i => ({ nativeId: i.id, path: i.filename, state: i.state }));
        continue;
      }
      const item = candidates[0];
      if (receipt.nativeId !== undefined && item?.id !== receipt.nativeId) {
        receipt.state = "unavailable";
        receipt.path = null;
        receipt.error = "The identified download is no longer in Chrome's ledger";
        continue;
      }
      if (!item) continue; // The Chrome ledger may not have published this event yet.
      this.applyNativeReceipt(receipt, item);
      // Chrome names the file once a location is chosen; until then the ledger's path is empty.
      if (item.state === "in_progress" && !item.filename) receipt.awaitingLocation = true;
      else delete receipt.awaitingLocation;
    }
  }

  private applyNativeReceipt(receipt: Receipt, item: NativeDownload): void {
    receipt.nativeId = item.id;
    receipt.filename = basename(item.filename.replace(/\\/g, "/")) || receipt.filename;
    receipt.state = item.state === "interrupted" ? "failed" : item.state === "complete" ? "complete" : "in_progress";
    receipt.path = receipt.state === "complete" ? item.filename : null;
    delete receipt.error;
    if (item.error) receipt.error = item.error;
    if (receipt.state === "complete" && !item.exists) {
      receipt.state = "failed";
      receipt.path = null;
      receipt.error = "The browser reports that the downloaded file no longer exists";
    }
  }

  async query(id: string, timeoutMs = 10000, stop = false, browser?: Browser): Promise<ActResult> {
    const watch = this.watches.get(id) ?? [...this.watches.values()].find(w => w.receipts.some(r => r.id === id));
    if (!watch) return { ok: false, note: `Unknown download ID: ${id}. Use an ID returned by this session.` };
    if (stop) watch.stop();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (watch.native && browser?.isConnected()) await this.connect(browser);
        await this.refresh(watch);
        await Promise.all(watch.marks);
      }
      catch (e) {
        // A lost extension is not a failed download. Keep every ID and expose the inability
        // to check so a later call can resume once the bridge is back.
        return this.result(watch, "unavailable", false, id, `Download status unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
      const receipts = id === watch.id ? watch.receipts : watch.receipts.filter(r => r.id === id);
      const state: State = receipts.length > 1 ? "ambiguous"
        : receipts[0]?.state ?? (watch.page.isClosed() || watch.until ? "failed" : "armed");
      // A short quiet period lets simultaneous events arrive before reporting a sole file.
      if ((state === "complete" || state === "failed" || state === "ambiguous" || state === "unavailable") && Date.now() - watch.lastEvent >= 250) {
        return this.result(watch, state, false, id);
      }
      if (Date.now() >= deadline) return this.result(watch, state, true, id, undefined, await this.stuckHint(watch, receipts, state));
      await pause(Math.min(100, deadline - Date.now()));
    }
  }

  private result(watch: Watch, state: State, timedOut: boolean, id = watch.id, error?: string, hint?: string): ActResult {
    const downloads = id === watch.id ? watch.receipts : watch.receipts.filter(r => r.id === id);
    const facts = error ? downloads.map(r => ({ ...r, state: "unavailable", path: null, error })) : downloads;
    const picked = downloads.filter((r) => r.source === "save-picker").length;
    return { ok: true, value: { id, state, host: watch.host, timedOut, downloads: structuredClone(facts),
      ...(error ? { error } : state === "failed" && !downloads.length ? { error: "The watch stopped or its tab closed before a download began" } : {}),
      ...(hint ? { hint } : {}) },
      note: `download ${id}: ${state}${timedOut ? "; wait budget ended — query this ID again" : ""}`
        + (picked ? `; ${picked === 1 ? "this file" : `${picked} of these files`} came from the page's own save dialog, `
          + "saved as an ordinary download instead — it is at the path shown, not where the page would have asked" : "")
        + (hint ? `; ${hint}` : "") };
  }

  async close(): Promise<void> {
    for (const watch of this.watches.values()) watch.stop();
    // Completed files already live outside Playwright's artifacts. Bound teardown while
    // allowing near-complete copies to finish before the connection deletes those artifacts.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...this.saving]), new Promise<void>(r => { timer = setTimeout(r, 5000); })]);
    if (timer) clearTimeout(timer);
    for (const watch of this.watches.values()) {
      watch.dispose?.();
      await watch.session?.detach().catch(() => {});
    }
    await this.root?.detach().catch(() => {});
    this.root = null;
    this.source = null;
  }
}
