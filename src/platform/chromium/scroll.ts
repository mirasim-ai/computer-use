/**
 * Scroll for BrowserDriver: container-aware, displacement-VERIFIED.
 *
 * A bare `window.scrollBy` + an unconditional `{ok:true}` moves nothing on any app-shell
 * page whose lists live in inner overflow containers, while both the model and the action
 * journal are told it worked. This module removes that class of lie in three steps:
 *
 *   1. resolve an explicit region/element ref, or the only visible scrollable region;
 *      ambiguous regions are listed without moving any of them;
 *   2. dispatch a real wheel at the container's center (the wheel scrolls the nearest
 *      scrollable ancestor under the POINTER — that is why the pointer moves first), or
 *      set scrollTop directly for to:'top'|'bottom' jumps;
 *   3. re-measure the SAME container (found again via a temporary data-mfscroll mark)
 *      and report the measured displacement — in the note the model reads and in the
 *      journal an auditor replays.
 *
 * A per-container ledger (data-mfsc identity, driver-held counters) adds scale honesty:
 * which screen of the container this is, how many more scrolls the rest would cost,
 * whether the list grows while being scrolled (lazy loading), and whether this ground
 * was already covered. Page JS lives here next to its TS orchestration; nothing outside
 * browser/ knows any of it.
 */

import type { Frame, Locator, Page } from "playwright-core";
import type { ActResult } from "../types.ts";
import { SCROLL_JUMP_JS, SCROLL_MEASURE_JS, SCROLL_TARGET_JS } from "./scroll-scripts.ts";
import { pageFn } from "./collect.ts";
import { readableFrames } from "./frames.ts";
import { refSelector } from "./page-refs.ts";
import { coverOf } from "./coverer-label.ts";

/** One container's running account, kept across scrolls so the model can budget:
 * how far it ever got, how big the list claimed to be last time (in screens — growth
 * means lazy loading), how many scrolls were already spent, how often it grew. */
export interface ScrollLedgerEntry {
  maxScreen: number;
  lastTotal: number;
  scrollCount: number;
  growCount: number;
}

export interface ScrollOutcome {
  res: ActResult;
  /** Where the wheel was dispatched (page coordinates) — the action point for the journal. */
  point: { x: number; y: number } | null;
  /** Measured displacement in px; null when it could not be measured (container re-rendered). */
  moved: number | null;
}

/** Virtual lists re-render after the wheel; measuring before the beat under-reports. */
const SETTLE_MS = 350;

/** How long a wheel that has not moved anything yet is still waited for. The compositor animates a
 * wheel scroll; in the extension browser on Windows (a page in a window behind the user's) it was
 * measured landing 0.4–0.5 s after the wheel, so a read at {@link SETTLE_MS} said "did not scroll"
 * and the NEXT scroll reported this one's distance. A real standstill pays this once. */
const LATE_MOVE_MS = 1500;

/** How many screens one call may cover. Same ceiling `keys` puts on a repeat count. */
const MAX_SCREENS = 20;

/** Below this displacement the scroll DID NOT happen for any practical purpose
 * (rubber-banding and sub-pixel rounding land under it; a real page moves hundreds). */
const MIN_MOVE_PX = 8;

/** The standstill. It must stop a dead-scroll loop without ruling out the one repeat that works:
 * a list that loads on reaching its end is momentarily unscrollable. It NAMES its container,
 * because once a container is exhausted the auto-pick moves on (a finished feed is answered for
 * by «window»), and that is often not the one the caller was reading. */
const noMoveNote = (probe: Probe) =>
  `did not scroll — ${where(probe)} is already at the end, or is not scrollable. Do not just repeat it: `
  + "try ref-targeted scroll / to:'top'|'bottom' / a different container — or, if this is a list that "
  + "loads more on reaching its end, wait({}) once and scroll again";

interface Probe {
  kind: "el" | "doc" | "none" | "ambiguous";
  candidates?: Array<{ ref: string | null; name: string; position?: string }>;
  reason?: string;
  id: string;
  name: string;
  x: number;
  y: number;
  before: number;
  client: number;
  total: number;
}

interface Measure {
  lost: boolean;
  pos: number;
  client: number;
  total: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fail = (note: string): ScrollOutcome => ({ res: { ok: false, note }, point: null, moved: null });

/** Human name of the scrolled thing, for notes. */
const where = (probe: Probe): string => (probe.kind === "doc" ? "the page" : `«${probe.name}»`);

export async function performScroll(
  page: Page,
  a: Record<string, any>,
  ledger: Map<string, ScrollLedgerEntry>,
  /** Has this round READ the surface's content (text/page/screenshot) since the last scroll?
   *  Decides whether the escalating advisory below applies — see {@link ledgerNote}. */
  contentRead = false,
): Promise<ScrollOutcome> {
  const to: "top" | "bottom" | undefined = a.to === "top" || a.to === "bottom" ? a.to : undefined;
  const dir = typeof a.direction === "string" ? a.direction : "down";
  // `count` is screens of THIS container, delivered as one longer wheel; the note still reports
  // the measured displacement. Refused alongside `to` rather than silently ignored: they
  // contradict each other.
  const screens = Math.min(Math.max(Math.trunc(Number(a.count)) || 1, 1), MAX_SCREENS);
  if (to && Number(a.count) > 1) {
    return fail(`scroll takes to:'${to}' or count, not both — to:'${to}' already goes as far as the container scrolls; drop one`);
  }
  const axisH = !to && (dir === "left" || dir === "right");
  const up = to ? to === "top" : dir === "up" || dir === "left";

  // A ref names the container ("scroll the container that holds this element") — find
  // the frame it lives in; every later evaluate targets that frame.
  let frame: Frame = page.mainFrame();
  let refSel: string | null = null;
  if (typeof a.ref === "string" && a.ref) {
    if (a.ref === "window") refSel = "window";
    else {
      refSel = String(a.ref);
      const selector = await refSelector(page, refSel);
      let hit: Frame | null = null;
      for (const f of readableFrames(page)) {
        try { if (await f.locator(selector).count()) { hit = f; break; } } catch { /* unreadable frame */ }
      }
      if (!hit) return fail(`no element for ref ${a.ref} on the page any more — re-observe and use a current ref`);
      frame = hit;
    }
  }

  let probe: Probe;
  try {
    probe = (await frame.evaluate(pageFn(SCROLL_TARGET_JS) as any, [axisH, refSel])) as Probe;
  } catch (e) {
    return fail(`scroll probe failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  }
  if (probe.kind === "ambiguous") {
    // Each choice is written as the argument that picks it: «window: page» read as a label, and
    // a caller who wanted the page did not guess that ref:'window' says so.
    const choices = (probe.candidates ?? []).map((c) => c.ref === "window"
      ? "ref:'window' (the page itself)"
      : `${c.ref ? `ref:'${c.ref}'` : "(observe for its ref)"} ${c.name}${c.position ? ` (${c.position})` : ""}`).join("; ");
    return fail(`multiple scrollable regions — nothing scrolled. Pass scroll({ref, ...}) with one of them, or a control inside it: ${choices}`);
  }
  if (probe.kind === "none") {
    if (probe.reason === "modal") return fail("an open modal dialog blocks scrolling the background — choose a scrollable region inside the dialog; nothing scrolled");
    // An explicit target cannot silently fall back to scrolling something else.
    return fail(probe.reason === "gone"
      ? `no element for ref ${a.ref} on the page any more — re-observe and use a current ref`
      : `ref ${a.ref} has no scrollable ancestor — that part of the page does not scroll; pick a ref inside the list you want to scroll, or scroll without ref`);
  }

  // The wheel needs page coordinates; the probe's are frame-relative.
  let ox = 0, oy = 0;
  if (frame.parentFrame()) {
    const box = await (await frame.frameElement()).boundingBox().catch(() => null);
    if (box) { ox = box.x; oy = box.y; }
  }
  const point = { x: probe.x + ox, y: probe.y + oy };
  const isDoc = probe.kind === "doc";

  if (to) {
    let jump: { lost: boolean; before: number };
    try {
      jump = (await frame.evaluate(pageFn(SCROLL_JUMP_JS) as any, [to === "top", isDoc])) as { lost: boolean; before: number };
    } catch (e) {
      return fail(`scroll jump failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    }
    if (jump.lost) return lostOutcome(probe, point);
    await sleep(SETTLE_MS);
    const after = await measure(frame, axisH, isDoc);
    if (!after) return lostOutcome(probe, point);
    const moved = Math.abs(after.pos - probe.before);
    if (moved < MIN_MOVE_PX) {
      return {
        res: { ok: true, note: `did not scroll — ${where(probe)} is already at the ${to}; do not repeat`, journal: { moved: 0, container: probe.name } },
        point, moved,
      };
    }
    const note = `scrolled to the ${to} of ${where(probe)} (moved ${Math.round(moved)}px)`
      + ledgerNote(frame.url(), probe, after, moved, ledger, contentRead, to === "top");
    return { res: { ok: true, note, journal: { moved: Math.round(moved), container: probe.name } }, point, moved };
  }

  try {
    await page.mouse.move(point.x, point.y);
    const step = Math.max(40, Math.round(probe.client * 0.85)) * screens; // ≈ one screen of THIS container
    await page.mouse.wheel(axisH ? (up ? -step : step) : 0, axisH ? 0 : up ? -step : step);
  } catch (e) {
    return fail(`wheel failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  }
  await sleep(SETTLE_MS);
  let after = await measure(frame, axisH, isDoc);
  for (const end = Date.now() + LATE_MOVE_MS; after && Math.abs(after.pos - probe.before) < MIN_MOVE_PX && Date.now() < end;) {
    await sleep(100);
    after = await measure(frame, axisH, isDoc);
  }
  if (!after) return lostOutcome(probe, point);
  const moved = Math.abs(after.pos - probe.before);
  if (moved < MIN_MOVE_PX) {
    return { res: { ok: true, note: noMoveNote(probe), journal: { moved: Math.round(moved), container: probe.name } }, point, moved };
  }
  const note = `scrolled ${dir} ${Math.round(moved)}px in ${where(probe)}`
    + (screens > 1 ? ` (${screens} screens asked for)` : "")
    + ledgerNote(frame.url(), probe, after, moved, ledger, contentRead, up);
  return { res: { ok: true, note, journal: { moved: Math.round(moved), container: probe.name } }, point, moved };
}

async function measure(frame: Frame, axisH: boolean, isDoc: boolean): Promise<Measure | null> {
  try {
    const m = (await frame.evaluate(pageFn(SCROLL_MEASURE_JS) as any, [axisH, isDoc])) as Measure;
    return m.lost ? null : m;
  } catch {
    return null;
  }
}

/** The marked container is gone (virtual lists / SPAs swap nodes on scroll-triggered
 * re-renders). Measuring anything else and calling it "the scrolled container" would be
 * a lie; say what happened instead. */
function lostOutcome(probe: Probe, point: { x: number; y: number }): ScrollOutcome {
  return {
    res: {
      ok: true,
      note: "the scrolled container was re-rendered; effect could not be measured — check the next observation before scrolling again",
      journal: { container: probe.name, containerLost: true },
    },
    point,
    moved: null,
  };
}

/**
 * The container's account after this scroll: position in screens, remaining cost,
 * lazy-load growth, covered ground, cumulative spend. Facts only — the model does its
 * own budgeting. Skipped for containers that fit in one screen.
 */
function ledgerNote(
  frameUrl: string,
  probe: Probe,
  after: Measure,
  moved: number,
  ledger: Map<string, ScrollLedgerEntry>,
  contentRead: boolean,
  backwards: boolean,
): string {
  const client = Math.max(1, after.client || probe.client);
  const screens = Math.max(1, Math.ceil(after.total / client));
  if (screens <= 1) return "";
  const atEnd = after.pos + client >= after.total - 8;
  // Screen index by the viewport's TOP edge (floor+1) — ceil would announce the last
  // screen early; "at the end" is its own fact, reported directly.
  const screen = atEnd ? screens : Math.max(1, Math.min(screens, Math.floor(after.pos / client) + 1));
  // Keyed by URL (hash stripped) + container id: navigation naturally starts a fresh
  // account even though the driver-side map lives on.
  const key = `${frameUrl.split("#")[0]}::${probe.id}`;
  const entry = ledger.get(key) ?? { maxScreen: 0, lastTotal: 0, scrollCount: 0, growCount: 0 };
  const parts: string[] = [];
  // Remaining cost normalized by THIS scroll's real displacement — the only unit the
  // model can multiply by its step budget (a short container's own height would
  // overstate the remaining work several-fold).
  const unit = Math.max(1, moved);
  const left = Math.max(0, Math.ceil(Math.max(0, after.total - after.pos - client) / unit));
  // The distance to the END only belongs to a forward scroll; after `to:'top'` it would
  // contradict the note it rides. The POSITION is still said.
  const remaining = atEnd ? " (reached the end)" : backwards ? "" : ` (~${left} more scrolls to the end)`;
  parts.push(`screen ${screen}/${screens} of this container${remaining}`);
  if (entry.lastTotal && screens > entry.lastTotal + 1) {
    entry.growCount++;
    let g = `note: this list grows as you scroll (was ${entry.lastTotal} screens, now ${screens})`;
    if (entry.growCount >= 2) g += "; scrolling to the end may be impossible — consider reporting what you have";
    parts.push(g);
  }
  if (entry.maxScreen >= screen + 2) {
    parts.push(`you already viewed up to screen ${entry.maxScreen} of this container`);
  }
  entry.scrollCount++;
  // The advisory is for an agent HUNTING. A round that READ the surface between scrolls is
  // harvesting, where scrolling every screen IS the task (same discriminator as the "you keep
  // observing without acting" nudge in `driver-select.ts`). EXEMPT, NOT RESET: the count keeps
  // climbing, so a later pure-scroll spree in the same container still escalates.
  if (entry.scrollCount >= 5 && !contentRead) {
    parts.push(`this is scroll #${entry.scrollCount} in this container — if what you need has not appeared, `
      + `try to:'top'|'bottom', the page's own search/filter, or report what you have`);
  }
  entry.maxScreen = Math.max(entry.maxScreen, screen);
  entry.lastTotal = screens;
  ledger.set(key, entry);
  return `; ${parts.join("; ")}`;
}

/**
 * `scroll({into: ref})`: bring ONE control to the middle of the viewport, then say whether it is
 * clear. The way out from under a pinned layer: a screen of scrolling (`count`) carries a control
 * from under a bottom strip straight under a sticky header, and a click by point lands on the
 * cover. It takes a COVERED ref too, which is its point, and the note says what still covers it,
 * read live after the move.
 */
export async function performScrollInto(page: Page, ref: string): Promise<ScrollOutcome> {
  const selector = await refSelector(page, ref);
  let el: Locator | null = null;
  for (const f of readableFrames(page)) {
    try { const l = f.locator(selector); if (await l.count()) { el = l.first(); break; } } catch { /* unreadable frame */ }
  }
  if (!el) return fail(`no element for ref ${ref} on the page any more — re-observe and use a current ref`);
  let out: { moved: number; inView: boolean };
  try {
    // 'instant': a page's scroll-behavior:smooth would leave the read below mid-glide.
    out = await el.evaluate(pageFn(String.raw`(el) => {
      const y = el.getBoundingClientRect().top;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect(), win = el.ownerDocument.defaultView;
      return { moved: Math.abs(r.top - y),
               inView: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < win.innerHeight };
    }`) as any, undefined, { timeout: 2000 }) as { moved: number; inView: boolean };
  } catch (e) {
    return fail(`scroll into ${ref} failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  }
  if (!out.inView) return fail(`${ref} is not rendered (no box on screen after scrolling to it) — re-observe`);
  // A header that hides or shows on scroll answers the scroll event a frame or a transition later.
  await sleep(SETTLE_MS);
  const cover = await coverOf(el);
  const moved = Math.round(out.moved);
  const went = moved >= MIN_MOVE_PX ? `scrolled ${ref} to the middle of the viewport (moved ${moved}px)`
    : `${ref} is already as near the middle as the page scrolls`;
  const note = !cover ? `${went}; nothing covers it now — act on it`
    : cover.pseudo ? `${went}, but the ${cover.pseudo} layer of «${cover.who}» still covers it: page styling, nothing to `
      + "close or scroll past — the keyboard still reaches it (Tab to it, then Enter or Space)"
    : `${went}, but «${cover.who}» still covers it: dismiss that (find('close') reaches its close control when `
      + "the page marks one; an unmarked one shows only in a screenshot)";
  return { res: { ok: true, note, journal: { moved, into: ref, ...(cover ? { covered: cover.who } : {}) } }, point: null, moved };
}
