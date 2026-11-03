/**
 * The READS of the shared Chromium page layer: the observation, the waits, the text, the picture.
 *
 * `ChromiumPageDriver` is what a Chromium PLATFORM extends (`browser/`, `electron/`), and the
 * chain under it is `ChromiumPageBase` (state and hooks) → `ChromiumPageActs` (locate and the
 * verbs) → this.
 *
 * An observation of a page still arriving reads as an empty page, so the reads are written
 * around WHEN the page is worth reading.
 */

import type { Frame } from "playwright-core";
import type { Element, Heading, ScopedShot, ShotScope, Snapshot, ToolResult } from "../types.ts";
import { MAX_REFS, ROW_CONTEXT_BUDGET, pageFn } from "./collect.ts";
import { VIEWPORT_JS } from "./collect-viewport.ts";
import { EXCERPT_JS, FULL_TEXT_JS, WAIT_TEXT_JS, type FullTextResult } from "./page-text.ts";
import { unreachedFacts } from "./unreached.ts";
import { readPage as readPageImpl } from "./read-page.ts";
import { JPEG_SHOT, scopedShot, withPageCapture } from "./shot.ts";
import { POST_NAV_QUIET_MS } from "./page-base.ts";
import { locateOnPage } from "./locate.ts";
import { readableFrames } from "./frames.ts";
import { ChromiumPageWaits } from "./page-waits.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long a post-navigation read may keep asking while the page's content is still arriving,
 *  and the step between asks. Bounded: past this, what is on screen is the page's answer, not
 *  our impatience. */
const POST_NAV_RETRY_MS = 2_400;
const POST_NAV_STEP_MS = 300;
/**
 * At or below this many listed elements, a page just navigated to is suspected of being a shell
 * whose content has not arrived (see {@link ChromiumPageDriver.snapshot}). x.com's shell renders
 * 2, plus margin; no higher, because a suspect pays {@link POST_NAV_QUIET_MS} every time.
 */
const POST_NAV_THIN = 6;


/** What shuts this frame out in its parent documents, or null. Walks up the frame chain, because
 *  a frame nested in a shut-out frame is shut out too. An unreadable host answers null: this only
 *  ever removes controls from the list, so a failed check must leave them listed. */
async function frameShutOutBy(frame: Frame): Promise<string | null> {
  for (let f: Frame | null = frame; f && f.parentFrame(); f = f.parentFrame()) {
    try {
      const why = await (await f.frameElement()).evaluate((el: any) => {
        if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return "an inert region";
        const modal = el.ownerDocument.querySelector(":modal");
        if (!modal || modal.contains(el)) return null;
        const label = modal.getAttribute("aria-label") || modal.querySelector("h1, h2, h3")?.textContent || "";
        return label.trim().slice(0, 60) || "a modal dialog";
      });
      if (why) return why;
    } catch { return null; }
  }
  return null;
}

export abstract class ChromiumPageDriver extends ChromiumPageWaits {
  /**
   * The read, plus the ONE wait the model would otherwise have to write itself.
   *
   * `open_url` resolves on the document and an SPA renders its controls after that, so the
   * observation right behind it would read as "this page has no controls". Like
   * `driver-settle.ts`, this pays only where the wrong statement is about to be made:
   *
   *   - THE TRIGGER is a thin read ({@link POST_NAV_THIN}), not an empty one: a shell is not
   *     nothing.
   *   - THE STOP is the count holding still for {@link POST_NAV_QUIET_MS}, or the budget.
   *     Passing the trigger does not end it: a count cannot tell a nav rail from content.
   *
   * A page that arrives with content never enters the loop. A heuristic: a shell rendering more
   * than POST_NAV_THIN controls slips past. The general answer is {@link waitSettled}, which
   * costs a second per call and so stays a verb the model asks for.
   */
  protected async snapshot(): Promise<Snapshot> {
    const first = await this.snapshotOnce();
    if (!this.navPending) return first;
    this.navPending = false;
    const listed = (s: Snapshot): number => s.elements.length + (s.offscreenElements?.length ?? 0);
    if (listed(first) > POST_NAV_THIN) return first;
    // Waited on a CHEAP count, not the walk: a full walk per step cost 5.2 s on x.com.
    let prev = await this.candidateCount(), quiet = 0;
    for (let waited = 0; waited < POST_NAV_RETRY_MS; waited += POST_NAV_STEP_MS) {
      await sleep(POST_NAV_STEP_MS);
      const cur = await this.candidateCount();
      quiet = cur > prev ? 0 : quiet + POST_NAV_STEP_MS;
      prev = cur;
      if (quiet >= POST_NAV_QUIET_MS) break;         // held still long enough to be believed
    }
    return await this.snapshotOnce();
  }

  /**
   * A rough count of act-able nodes in the main frame — one evaluate, no geometry. Read only as
   * a DELTA ("did anything arrive"), so approximating the walk's criteria is fine.
   */
  private async candidateCount(): Promise<number> {
    try {
      return Number(await this.page().mainFrame().evaluate(
        "document.querySelectorAll('a[href],button,input,select,textarea,summary,[role],[contenteditable],[tabindex]').length",
      )) || 0;
    } catch {
      return 0;   // unreadable frame: treat as no growth, the quiet exit still ends the wait
    }
  }

  private async snapshotOnce(): Promise<Snapshot> {
    await this.ensure();
    this.hookDiagnostics();
    const page = this.page();
    const elements: Element[] = [];
    // Sticky refs: the counter lives on the page (window.__mfNextK), read here and written back
    // after the walk; k is threaded serially so numbering stays continuous across frames.
    let k = 0;
    try { k = Number(await page.mainFrame().evaluate("Number(window.__mfNextK) || 0")) || 0; } catch { /* fresh page */ }
    // A document replaced IN PLACE (reload, in-tab navigation, renderer restart) reads a counter
    // below the high-water mark: the page-side marks died, the driver's continuity did not, and
    // re-minting from e0 would resolve a stale ref to whatever got that number. So continuity is
    // dropped (stale refs are refused) and numbering resumes above the mark, as the
    // surface-replacement paths already do.
    if (k < this.refHighWater) {
      this.resetObservationState();
      this.resetPageState();
      k = this.refHighWater;
    }
    let meta: Snapshot["meta"] = { scrollY: 0, viewportH: 1, docH: 0 };
    const offscreenElements: Element[] = [];
    const coveredElements: Element[] = [];
    /** Page-side groups, before the viewport filter and the budget (both priced below). */
    const rawGroups: { label: string; members: string[] }[] = [];
    /** Headings of every frame, moved into top-level coordinates like the element rects. */
    const headings: Heading[] = [];
    let vw = 1280, vh = 800;
    let coveredCount = 0, coveredTop = "", coveredTopN = 0;
    /** Covered controls a frame attributed to its open modal dialog, and that dialog's name. */
    let behindModal = 0, modalName = "";

    for (const frame of readableFrames(page)) {
      let ox = 0, oy = 0;
      const isMain = frame.parentFrame() === null;
      if (!isMain) {
        try {
          const box = await (await frame.frameElement()).boundingBox();
          if (!box) continue;
          ox = box.x; oy = box.y;
        } catch { continue; }
      }
      let res: any;
      try { res = await frame.evaluate(pageFn(VIEWPORT_JS) as any, k); } catch { continue; }
      k = res.nextK ?? k;
      // A frame shut out by its parent (a modal over it, an inert region) cannot see that from
      // inside; its controls go where the main document's background controls go.
      const shutBy = isMain ? null : await frameShutOutBy(frame);
      if (shutBy && res.items?.length) {
        res.coveredItems = [...(res.coveredItems ?? []), ...res.items.map((it: any) => ({ ...it, by: shutBy }))];
        coveredCount += res.items.length;
        if (res.items.length > coveredTopN) { coveredTopN = res.items.length; coveredTop = shutBy; }
        res.items = [];
      }
      if (isMain) {
        vw = res.vw || vw; vh = res.vh || vh;
        meta = { scrollY: res.scrollY || 0, viewportH: res.vh || 1, docH: res.docH || 0 };
      }
      if (res.covered) {
        coveredCount += res.covered.count;
        if (res.covered.modal) { behindModal += res.covered.count; modalName = res.covered.modal; }
        if (res.covered.topCount > coveredTopN) { coveredTopN = res.covered.topCount; coveredTop = res.covered.top; }
      }
      // Covered items: not y-clipped like `items` — the occlusion check only runs on elements
      // with an in-viewport quad, so these are on screen by construction.
      for (const it of (res.coveredItems ?? []) as any[]) {
        if (it.width <= 0 || it.height <= 0) continue;
        coveredElements.push({
          ref: it.ref, role: it.role, name: it.name || "", state: it.val || "",
          rect: { x: it.left + ox, y: it.top + oy, w: it.width, h: it.height },
          ...(it.by ? { coveredBy: it.by as string } : {}),
        });
      }
      // Group labels are frame-local (a container cannot span frames): no offset fixing.
      for (const g of (res.groups ?? []) as { label: string; members: string[] }[]) {
        if (g.label && g.members?.length) rawGroups.push(g);
      }
      // A frame shut out by its parent (a modal over it) keeps its headings out, as its controls.
      if (!shutBy) for (const h of (res.headings ?? []) as any[]) {
        headings.push({ name: h.name, level: h.level, rect: { x: h.left + ox, y: h.top + oy, w: h.width, h: h.height } });
      }
      for (const it of res.items as any[]) {
        const top = it.top + oy, left = it.left + ox;
        if (it.width <= 0 || it.height <= 0) continue; // not rendered at all — not an omission
        const el: Element = {
          ref: it.ref, role: it.role, name: it.name || "", state: it.val || "",
          rect: { x: left, y: top, w: it.width, h: it.height },
          ...(it.row ? { row: it.row as string } : {}),
          ...(it.rowBlank ? { rowBlank: true } : {}),
        };
        // Outside the top-level viewport: KEPT in their own list with live sticky refs, so a
        // lookup by element needs no scroll hunt. `elements` is what the model is SHOWN, and the
        // caps below are priced against exactly that. The off-screen COUNT reaches the render
        // (from this list's length) so a model scrolls rather than concluding absence.
        // `clipped`: in the viewport but scrolled out of its own container — off-screen too.
        if (it.clipped || top >= vh || left >= vw || top + it.height <= 0 || left + it.width <= 0) { offscreenElements.push(el); continue; }
        elements.push(el);
      }
    }
    elements.sort((a, b) => a.rect.y - b.rect.y);
    // Same order as `elements`. Not capped: not rendered, and its readers price their own budget.
    offscreenElements.sort((a, b) => a.rect.y - b.rect.y);
    coveredElements.sort((a, b) => a.rect.y - b.rect.y);
    const capped = Math.max(0, elements.length - MAX_REFS);
    if (capped) elements.length = MAX_REFS;
    // Row context is priced HERE, after the y-sort and the ref cap, top-down. The first overflow
    // CLOSES the budget (`full`) rather than skipping one row: a later shorter row slipping in
    // would scatter the kept set, and an unannotated row above an annotated one reads as
    // unambiguous.
    let rowChars = 0, rowsCut = 0, full = false;
    for (const e of elements) {
      if (!e.row) continue;
      if (full || rowChars + e.row.length > ROW_CONTEXT_BUDGET) { delete e.row; rowsCut++; full = true; }
      else rowChars += e.row.length;
    }
    if (rowsCut) meta.rowsCut = rowsCut;
    // Groups are NOT priced here: their members span both lists, and pricing against `elements`
    // alone would leave off-viewport controls ungrouped while `readElements` hands them to the
    // script anyway. They go out whole; the render site prices what it shows (driver-narrate.ts).
    const groups = rawGroups;
    this.refHighWater = k;
    try { await page.mainFrame().evaluate(`window.__mfNextK = ${k}`); } catch { /* best-effort */ }

    let text = "";
    try { text = (await page.evaluate(pageFn(EXCERPT_JS) as any)) as string; } catch { /* excerpt is best-effort */ }
    if (offscreenElements.length) meta.offscreen = offscreenElements.length;
    if (capped) meta.capped = capped;
    return {
      url: page.url(), title: await page.title().catch(() => ""), elements, offscreenElements,
      coveredElements, text, meta,
      ...(groups.length ? { groups } : {}),
      ...(headings.length ? { headings } : {}),
      ...(coveredCount ? { covered: { count: coveredCount, top: coveredTop || "overlay",
        ...(behindModal === coveredCount ? { modal: modalName } : {}) } } : {}),
    };
  }

  async readText(): Promise<string> {
    await this.ensure();
    this.hookDiagnostics();
    const res = (await this.page().evaluate(pageFn(FULL_TEXT_JS) as any).catch(() => null)) as FullTextResult | null;
    if (!res) return "";
    // The same sentences page() puts in its receipt (unreached.ts).
    const facts = unreachedFacts({ ...res.un, frames: Math.max(0, res.un.frames - res.framesRead) }, res.text.length > 0);
    if (res.outside > 0) {
      facts.push(`this read is the region the page marks as its main content — ${res.outside} chars outside it`
        + " (header, navigation, footer) are left out; page() has them, and wait({text}) searches them");
    }
    if (res.screens > 0.5) {
      facts.unshift(`~${res.screens} more screens below have not been scrolled into view`
        + " — content there may not have loaded yet, so do not conclude something is absent");
    }
    return facts.length ? `${res.text}\n(${facts.join("; ")})` : res.text;
  }

  /** One element's whole value (`value(ref)`): what a field holds, or an element's whole text —
   *  the listing clips both to a line. One evaluate, no walk; same verb as macOS. */
  override async readValue(ref: string): Promise<string> {
    if (!this.knownRef(ref)) throw new Error(this.staleRefNote(ref));
    const loc = await locateOnPage(this.page(), ref, undefined, false);
    if (!loc) throw new Error((await this.missing(ref)).note ?? `no element for ref ${ref}`);
    return String(await loc.evaluate((el: any) => {
      if ("value" in el && typeof el.value === "string" && !/^(button|submit|reset)$/i.test(el.type || "")) return el.value;
      return el.innerText || el.textContent || "";
    }));
  }

  /** A wait searches the whole document (page-text.ts WAIT_TEXT_JS), not the region text() reads. */
  override async readTextForWait(): Promise<string> {
    await this.ensure();
    return ((await this.page().evaluate(pageFn(WAIT_TEXT_JS) as any).catch(() => null)) as string | null) ?? "";
  }

  /** JPEG (see JPEG_SHOT), declared by screenshotMimeType, which callers must honor when
   * naming files. */
  async screenshot(): Promise<Buffer> {
    await this.ensure();
    this.hookDiagnostics();
    const page = this.page();
    return await withPageCapture(page, () => page.screenshot({ ...JPEG_SHOT, timeout: 10_000 }));
  }

  /** Scoped capture — element / region / full page. shot.ts owns the logic; the locate
   * closure reuses the same identity-checked ref resolution every act verb grounds on. */
  override async screenshotScoped(scope: ShotScope): Promise<ScopedShot> {
    await this.ensure();
    this.hookDiagnostics();
    const page = this.page();
    return await withPageCapture(page, () => scopedShot(page, scope, (ref) => this.locate(ref, undefined, false)));
  }

  /** URL of the active tab — where the agent ended up. */
  override async currentUrl(): Promise<string> {
    try {
      await this.ensure();
      return this.page().url();
    } catch {
      return "";
    }
  }

  /** Deep content read — `page()`. The sticky-ref labeling pass runs first so the tree carries
   * act-able refs; the read itself never mints refs nor advances the change-verdict ring. */
  override async readPage(opts: { ref?: string; depth?: number; node?: string }): Promise<ToolResult> {
    await this.ensure();
    return this.bounded("read page", readPageImpl(this.page(), opts, this.pageReadState, async () => { await this.snapshot(); }));
  }

}
