/**
 * ChromiumPageBase — everything a ComputerUseDriver can do with a Chromium PAGE, and nothing
 * that assumes a browser PRODUCT. A platform slice extends this and supplies `ensure()` (be
 * connected) and `page()` (the surface).
 *
 * The split exists because an Electron renderer IS a Chromium page, while `browser/`'s tab
 * claim, managed-Chrome ladder and window placement are meaningless there (and their teardown
 * paths are dangerous against an app the user is running).
 *
 * What stays with each platform: `perform()` (browser wraps dispatch in a focus net and an
 * action journal; electron does not), `listTargets`/`focusTarget` (tabs vs windows),
 * `close()`, `extraVerbs()`, `promptFragment()` and the additive verbs.
 */

import { type Page, type Request } from "playwright-core";
import { ComputerUseDriver } from "../driver.ts";
import type { DiagType } from "../driver-diagnostics.ts";
import type { OwnershipResource } from "../types.ts";
import { type ScrollLedgerEntry } from "./scroll.ts";
import { type PageReadState } from "./read-page.ts";



/** Normalize key chords to Playwright names (Ctrl+A → Control+A, Cmd → Meta). */
export function normalizeChord(chord: string): string {
  return chord
    .split("+")
    .map((k) => {
      const t = k.trim().toLowerCase();
      if (t === "" && k !== "") return "Space"; // a literal " " IS the space bar — trim() must not eat it
      return { ctrl: "Control", cmd: "Meta", command: "Meta", alt: "Alt", opt: "Alt", shift: "Shift", esc: "Escape", space: "Space" }[t] ?? k.trim();
    })
    .join("+");
}

/** Request kinds whose answer can still change what the page SHOWS: data the page renders, a
 *  document, code. Images, fonts, media, beacons and event streams cannot change its text. */
const RENDERING_REQUESTS = new Set(["fetch", "xhr", "document", "script"]);
/** A request older than this is a long poll or a stalled call, not a render on its way: past it,
 *  it stops holding the settle wait (page-waits.ts). */
const INFLIGHT_MAX_AGE_MS = 2_000;

/**
 * How long the count must hold STILL before a thin page is taken at its word. One quiet step is
 * not enough: content arrives late (a measured fixture mounts at 900 ms).
 */
export const POST_NAV_QUIET_MS = 1_200;

export abstract class ChromiumPageBase extends ComputerUseDriver {
  private readonly ownershipIds = new WeakMap<Page, string>();

  override async ownershipResources(): Promise<OwnershipResource[]> {
    await this.ensure();
    return [await this.pageOwnership(this.page())];
  }

  protected async pageOwnership(page: Page): Promise<OwnershipResource> {
    let id = this.ownershipIds.get(page);
    if (!id) {
      const session = await page.context().newCDPSession(page);
      try { id = (await session.send("Target.getTargetInfo")).targetInfo.targetId; }
      finally { await session.detach().catch(() => {}); }
      if (!id) throw new Error("CDP did not identify the target; refusing to claim a guessed window.");
      this.ownershipIds.set(page, id);
    }
    // The same renderer can be reached through browser or Electron and endpoint aliases.
    return { key: `chromium:${id}`, mode: "exclusive" };
  }
  /** Be connected. Called at the top of every primitive — the lazy-connect contract. */
  protected abstract ensure(): Promise<void>;
  /** The page every primitive below acts on. Synchronous: `ensure()` established it. */
  protected abstract page(): Page;

  /** Center of the element the last locate() resolved, captured BEFORE the action runs —
   * the action point for ref-grounded verbs (a navigating click destroys the element). */
  protected lastPoint: { x: number; y: number } | null = null;

  /** Per-container scroll account (scroll.ts owns the shape). */
  protected scrollLedger = new Map<string, ScrollLedgerEntry>();

  /** Sticky duplicate-read state for the page channel; dies with the surface. */
  protected pageReadState: PageReadState = {};
  /** Highest ref number minted in this session, across documents — see {@link snapshot}. Survives
   *  `resetObservationState` on purpose: it is what keeps a re-minted ref from colliding. */
  protected refHighWater = 0;

  /** Chromium pages feed the diagnostics channel (console / pageerror / network). */
  override readonly supportsDiagnostics = true;
  override readonly scrollsInto = true;

  /** Rendering requests sent and not yet answered, per page, with when each was sent. */
  private inflight = new WeakMap<Page, Map<Request, number>>();

  /**
   * Count the page's rendering requests in flight, from before the action that starts them: every
   * act and wait passes through {@link hookDiagnostics}, which calls this whether or not the
   * diagnostics channel is on. A Page survives navigations, so one attach covers the tab.
   */
  private hookInflight(): void {
    let page: Page;
    try { page = this.page(); } catch { return; }
    if (this.inflight.has(page)) return;
    const open = new Map<Request, number>();
    this.inflight.set(page, open);
    page.on("request", (req) => { if (RENDERING_REQUESTS.has(req.resourceType())) open.set(req, Date.now()); });
    const done = (req: Request) => { open.delete(req); };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  }

  /** How many rendering requests of the current page are still on their way (stale ones dropped). */
  protected pendingRenders(): number {
    let page: Page;
    try { page = this.page(); } catch { return 0; }
    const open = this.inflight.get(page);
    if (!open) return 0;
    const now = Date.now();
    for (const [req, sent] of open) if (now - sent > INFLIGHT_MAX_AGE_MS) open.delete(req);
    return open.size;
  }

  /** Pages already carrying diagnostics listeners. A Page object survives navigations,
   * so one attach covers every later load of that tab/window; a replaced page (relaunch,
   * tab switch) re-attaches on its first primitive. */
  private diagHooked = new WeakSet<Page>();

  /** Attach the diagnostics listeners to the CURRENT page once (no-op while the channel is
   * disabled). Called after ensure(), so collection starts at the session's first touch of a
   * surface — the render's header says exactly that. */
  protected hookDiagnostics(): void {
    this.hookNavigation();
    this.hookInflight();
    const sink = this.diagnosticsSink;
    if (!sink) return;
    let page: Page;
    try { page = this.page(); } catch { return; }
    if (this.diagHooked.has(page)) return;
    this.diagHooked.add(page);
    page.on("console", (msg) => {
      const t = msg.type();
      // The browser logs its own error line for every failed subresource (a missing favicon).
      // The request listeners below already record it; as console.error it would also raise
      // "the page's own code may have failed", which is about page CODE.
      if (t === "error" && msg.text().startsWith("Failed to load resource:")) return;
      const type: DiagType = t === "error" ? "console.error" : t === "warning" ? "console.warn"
        : t === "info" ? "console.info" : t === "debug" ? "console.debug" : "console.log";
      const loc = msg.location();
      const where = loc.url ? ` (${loc.url.split("/").pop()}:${loc.lineNumber + 1})` : "";
      sink.push(type, `${msg.text()}${where}`, { url: page.url() });
    });
    page.on("pageerror", (err) => {
      sink.push("pageerror", String(err.message || err), { ...(err.stack ? { detail: err.stack } : {}), url: page.url() });
    });
    page.on("requestfailed", (req) => {
      const why = req.failure()?.errorText ?? "failed";
      // Pages cancel their own requests routinely (navigation, typeahead) — noise, not failure.
      if (why === "net::ERR_ABORTED") return;
      sink.push("network", `${req.method()} ${req.url()} — ${why}`, { url: page.url() });
    });
    page.on("response", (res) => {
      if (res.status() >= 400) sink.push("network", `${res.request().method()} ${res.url()} — HTTP ${res.status()}`, { url: page.url() });
    });
  }

  /** Drop the page-level continuity a surface replacement invalidates. Platforms call it
   *  from their own `close()` / reconnect paths alongside `resetObservationState()`. */
  protected resetPageState(): void {
    this.scrollLedger.clear();
    this.pageReadState = {};
  }

  /**
   * A surface-level hint that explains an empty page better than the ref does — the browser
   * fills it in for "the active tab is blank but another tab has your page". Empty by
   * default: a platform with one window has no such alternative to point at.
   */
  protected async blankSurfaceHint(): Promise<string> {
    return "";
  }
  /**
   * The document changed and nothing has been read since — see {@link snapshot}.
   *
   * Set by the NAVIGATION ITSELF ({@link hookNavigation}), not by `open_url`/`back`/`reload`:
   * most real navigation is a click or an Enter.
   */
  protected navPending = false;

  /** Pages already carrying the navigation listener (see {@link diagHooked} for the shape). */
  private navHooked = new WeakSet<Page>();

  /** Flag every main-frame navigation, whoever caused it — a verb, a click, an Enter, a redirect,
   *  or an SPA route change (playwright fires this for same-document navigation too). */
  protected hookNavigation(): void {
    let page: Page;
    try { page = this.page(); } catch { return; }
    if (this.navHooked.has(page)) return;
    this.navHooked.add(page);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.navPending = true;
    });
  }
}
