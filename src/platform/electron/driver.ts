/**
 * ElectronDriver — ComputerUseDriver over an Electron app's renderer, for driving a desktop shell
 * the way the browser driver drives a page.
 *
 * Small because an Electron renderer IS a Chromium page: {@link ChromiumPageDriver} owns the
 * observation pipeline, the read channels and the universal verbs, all working here unmodified.
 * What is left is connection and identity.
 *
 * ATTACH-ONLY. Electron's main process owns the windows, so Chromium's Browser and Target
 * domains are not there to serve us (probed against Electron 33.4.11 / Chrome 130):
 *
 *   Browser.getWindowForTarget   'wasn't found'   — no window bounds, no off-screen park
 *   Browser.setWindowBounds      unreachable, same reason
 *   Target.createTarget          'Not supported'  — no own window, no new tab
 *   context.newPage()            fails through Target.createTarget
 *   browser.newContext()         'Failed to create browser context' — no isolated jar
 *   a window id per page         unavailable, so windows cannot be told apart that way
 *
 * None of that is a loss: the browser driver's window machinery keeps the agent OUT of the
 * user's way, whereas here the target is self-debugging the app, in the window that misbehaves.
 * Hence also no focus net and no action journal (that journal needs a managed run dir).
 *
 * Rules: the app is the USER'S RUNNING PROCESS — `close()` disconnects and never quits it, and a
 * vanished surface is reported gone ({@link SurfaceGoneError}), never recreated. App LIFECYCLE
 * (start, stop, the debugging port) belongs to whoever runs the app.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { ChromiumPageDriver } from "../chromium/page-driver.ts";
import { previewPage } from "../chromium/preview.ts";
import { DRAG_VERB, fileInputFor, performUploadToRef, refuseMissingFiles } from "../chromium/actions.ts";
import { PASTE_VERB, SELECT_OPTION_VERB } from "../chromium/actions-value.ts";
import { SELECT_TEXT_VERB } from "../chromium/select-text.ts";
import { performRunJs } from "../chromium/run-js.ts";
import { ensureRefSelector } from "../chromium/page-refs.ts";
import { SurfaceGoneError, type ActResult, type Snapshot, type TargetIdentity, type TargetInfo, type VerbSpec } from "../types.ts";
import { closeWedgedAuxTargets, isAuxUrl, listTargets } from "./preflight.ts";

/**
 * Where the app publishes its renderer debugging port. Not a launch hint, and deliberately not
 * Chrome's conventional 9222: a stray browser there would put this driver on the wrong surface.
 *
 * A DEV port only: CDP has no token, so whoever reaches it owns the app, which is why no
 * packaged app opens one. Don't widen it with `--remote-allow-origins` (that lets a visited web
 * page drive it); we connect from Node, which sends no `Origin`, so nothing here needs it.
 */
const DEFAULT_ELECTRON_CDP_URL = "http://127.0.0.1:9333";

/** Page targets that are not the app: the DevTools window is a `page` target too, and
 *  listing it invites the model to operate the inspector instead of the product. */
function isAppSurface(p: Page): boolean {
  const url = p.url();
  return !p.isClosed() && !!url && url !== "about:blank" && !isAuxUrl(url)
    && !url.includes("#/aux/computer-use");
}

/** Attaching initialises every target; a stuck one must fail in seconds, not playwright's 30. */
const ATTACH_TIMEOUT_MS = 15_000;

/**
 * No launch fallback on purpose — app lifecycle is not ours. The message carries the fix, and
 * says an INSTALLED app has no port at all, or the caller retries forever.
 */
function noAppMessage(cdpUrl: string, detail: string): string {
  return `mirasim-cu: no Electron app is listening on ${cdpUrl}.\n(${detail})\n`
    + "This driver attaches to a running app and never starts one, and it needs that app's "
    + "renderer debugging port — a DEV-ONLY port. Start the app's dev build with that port open "
    + "(`--remote-debugging-port=9333`, or whatever its dev script uses), or point "
    + "COMPUTER_USE_ELECTRON_CDP_URL at the port yours uses.\nAn INSTALLED app opens no "
    + "such port and cannot be driven here: the port is unauthenticated, so shipping one "
    + "would hand every local process the app. To operate an installed app, use its own "
    + "authenticated route (a CLI or API it ships).";
}

import { RUN_JS_VERB, UPLOAD_TO_REF_VERB } from "./verbs.ts";

export class ElectronDriver extends ChromiumPageDriver {
  protected override previewTarget() {
    if (!this.active || this.active.isClosed()) return Promise.resolve(null);
    return previewPage(this.active, this.cdpUrl, "electron");
  }
  readonly platform = "electron";

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private active: Page | null = null;
  /** Stable per-session window ids (element refs are re-minted; these are not). */
  private windowIds = new WeakMap<Page, string>();
  private nextWindowId = 1;
  private readonly cdpUrl: string;

  constructor(opts: { cdpUrl?: string; env?: NodeJS.ProcessEnv } = {}) {
    super();
    const env = opts.env ?? process.env;
    this.cdpUrl = opts.cdpUrl?.trim() || env.COMPUTER_USE_ELECTRON_CDP_URL?.trim() || DEFAULT_ELECTRON_CDP_URL;
  }

  // ── Declared variance ───────────────────────────────────────────────────────

  protected override async snapshot(): Promise<Snapshot> {
    const snapshot = await super.snapshot();
    // The RUNNING app's identity, read from the target, never from the caller's version, a port
    // convention or a helper path: Electron's default user agent carries `<app name>/<version>`
    // just before `Chrome/`. An app that replaced its user agent stays unidentified.
    const application = await this.page().evaluate((): TargetIdentity["application"] => {
      const m = /\(KHTML, like Gecko\) (.+?)\/(\S+) Chrome\/.* Electron\//.exec(navigator.userAgent);
      return m ? { name: m[1]!, version: m[2]! } : undefined;
    }).catch(() => undefined);
    snapshot.target = {
      transport: "cdp", endpoint: this.cdpUrl, windowId: this.windowId(this.page()),
      ...(application ? { application } : {}),
    };
    return snapshot;
  }

  /**
   * Drag and the console, plus the ref-grounded value verbs. `open_url` / `back` / `reload` are
   * meaningless in an app shell, and app-level command verbs stay out: run_js reaches any
   * command bridge as ordinary JS. Drag is shared with {@link ChromiumPageDriver}; an app shell
   * is where the gesture lives (reordering tiles, dragging a splitter).
   *
   * NOT added: `dialog` and the browser's ARMED `upload`. Both answer a NATIVE window the main
   * process owns (a JS dialog is a native modal; a chooser is usually `dialog.showOpenDialog`),
   * which no Playwright page event reaches. Upload here is ref-only (`UPLOAD_TO_REF_VERB`).
   */
  override extraVerbs(): VerbSpec[] {
    return [DRAG_VERB, PASTE_VERB, SELECT_OPTION_VERB, SELECT_TEXT_VERB, UPLOAD_TO_REF_VERB, RUN_JS_VERB];
  }

  /** An Electron window is a Chromium document: the same mechanisms end a ref's life, with
   *  the window standing in for the tab. */
  protected override staleRefCause(): string {
    return "it predates a navigation, a reload or a window switch";
  }

  override promptFragment(): string {
    const surface = "You are operating a DESKTOP APPLICATION, not a web page: there is no address bar, "
      + "no back button and no reload — reach everything through the app's own UI. computer.surfaces() lists "
      + "WINDOWS, not tabs. run_js is the app's DevTools console — a DEBUG channel for inspecting "
      + "state; operating the product goes through the interaction verbs.";
    return `${surface} Grounding: observations are text lists of interactive elements with refs, for the `
      + "CURRENT viewport only. Act by ref from the latest observation. When what you want is NOT in the list: "
      + "if you can name it, w.find('<name>') searches EVERY control in the window and hands back a "
      + "handle — act on it directly, the click scrolls it into view, so do not scroll first. Scroll only to "
      + "discover what you cannot name. Observations may show only changes since the previous one; refs stay "
      + "valid across observations. "
      + "Use text() to read the full window text.";
  }

  // ── Connection: strict endpoint, attach only ────────────────────────────────

  protected async ensure(): Promise<void> {
    if (this.browser?.isConnected() && this.active && !this.active.isClosed()) return;
    if (this.browser?.isConnected()) {
      // Keep listing/rebinding possible, but never adopt another window for an in-flight verb.
      const open = this.surfaces();
      if (!open.length) throw new SurfaceGoneError(this.goneMessage());
      this.resetObservationState(); // refs died with the window they pointed into
      return;
    }
    this.browser = null;
    this.context = null;
    this.active = null;
    // Ask the port itself before playwright attaches (preflight.ts): a dead port and a stuck
    // target are different failures, and a wedged inspector can be cleared out of the way.
    const targets = await listTargets(this.cdpUrl);
    if (targets === null) throw new Error(noAppMessage(this.cdpUrl, "nothing answers at /json/list"));
    const cleared = targets ? await closeWedgedAuxTargets(this.cdpUrl, targets) : [];
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(this.cdpUrl, { timeout: ATTACH_TIMEOUT_MS });
      await ensureRefSelector(browser);
    } catch (e) {
      const detail = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
      if (!targets) throw new Error(noAppMessage(this.cdpUrl, detail)); // ws:// — playwright was the only probe
      throw new Error(
        `mirasim-cu: ${this.cdpUrl} answers — ${targets.length} target(s): ${targets.map((t) => t.url).join(", ")} — `
        + `but attaching to it failed.\n(${detail})\n`
        + "Attaching initialises every target, so one renderer that never answers hangs the whole "
        + "connection; a DevTools window is the usual one"
        + (cleared.length ? ` (${cleared.length} unresponsive one(s) were just closed: ${cleared.join(", ")})` : "")
        + ". Close the app's DevTools windows and try again.",
      );
    }
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new Error(`mirasim-cu: ${this.cdpUrl} answered but exposes no browser context.`);
    }
    this.browser = browser;
    this.context = context;
    const open = this.surfaces();
    if (!open.length) {
      throw new Error(
        `mirasim-cu: attached to ${this.cdpUrl} but the app has no renderer window to drive `
        + "(only its DevTools or an about:blank surface). Open the app's window and try again.",
      );
    }
    this.active = open[open.length - 1]!;
    this.resetObservationState();
  }

  /** Every window of the app, oldest first. Sync — `page()` may only read proven state. */
  private surfaces(): Page[] {
    return (this.context?.pages() ?? []).filter(isAppSurface);
  }

  private goneMessage(): string {
    return "The application you were driving has closed — every window is gone. This driver attaches "
      + "to a running app and never starts one, so there is nothing to reopen and nothing to re-observe. "
      + "Stop and report what you had done when it closed.";
  }

  protected page(): Page {
    if (this.active && !this.active.isClosed()) return this.active;
    throw new SurfaceGoneError("The bound Electron window closed. List surfaces and explicitly bind the intended remaining window; no input was redirected.");
  }

  // ── Targets are WINDOWS ─────────────────────────────────────────────────────

  async listTargets(): Promise<TargetInfo[]> {
    await this.ensure();
    return await Promise.all(this.surfaces().map(async (p) => ({
      id: this.windowId(p),
      kind: "window" as const,
      title: (await p.title().catch(() => "")) || p.url(),
      active: p === this.active,
    })));
  }

  async focusTarget(id: string): Promise<ActResult> {
    await this.ensure();
    for (const p of this.surfaces()) {
      if (this.windowId(p) !== id) continue;
      // Switching which window we ACT on, never raising it: that is the user's call.
      this.active = p;
      this.resetObservationState(); // refs belong to the window that minted them
      return { ok: true };
    }
    return { ok: false, note: `no window with id ${id}; call computer.surfaces() for current ids` };
  }

  /** Stable for the session, assigned on first sight — a window has no id of its own here. */
  private windowId(p: Page): string {
    let id = this.windowIds.get(p);
    if (!id) {
      id = `w${this.nextWindowId++}`;
      this.windowIds.set(p, id);
    }
    return id;
  }

  // ── Act ─────────────────────────────────────────────────────────────────────

  async perform(kind: string, a: Record<string, unknown>): Promise<ActResult> {
    await this.ensure();
    if (kind === "upload") {
      const paths: string[] = Array.isArray(a.paths) ? a.paths : [];
      const bad = refuseMissingFiles(paths);
      if (bad) return bad;
      const ref = String(a.ref);
      const name = a.name as string | undefined;
      const el = await this.locate(ref, name, false);
      if (!el) return await this.missing(ref, name);
      // The ref names the VISIBLE control; the input it triggers is hidden (fileInputFor).
      const input = await fileInputFor(el);
      if (!input) {
        return { ok: false, note: `${ref} is not a file input and the UI around it holds no single one — `
          + "pass the attach control itself; if that button opens the app's OWN file dialog, the window is native and cannot be answered" };
      }
      return await performUploadToRef(paths, ref, async () => input, () => this.missing(ref, name));
    }
    if (kind === "run_js") return await performRunJs(() => this.page(), a.code, a.ms, a.budgetMs);
    // No focus net and no journal: see the header. The universal verbs are the base class's.
    return (await this.dispatchPage(kind, a)) ?? { ok: false, note: `unknown action kind ${kind}` };
  }

  async close(): Promise<void> {
    // DISCONNECT ONLY: `browser.close()` on a connectOverCDP connection drops the connection and
    // leaves the app running. Never quit the user's application because a task ended.
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.active = null;
    this.resetObservationState();
    this.resetPageState();
    await this.disconnected();
  }
}
