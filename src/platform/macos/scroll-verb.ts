/**
 * `scroll` on a native window — two rungs, cheapest for the USER first.
 *
 * The scroll goes where the caller's `ref` is, not to the window's centre: in a multi-pane app
 * (Finder's sidebar against the file list) the centre is a different pane.
 *
 * macOS has no jump-to-top/bottom for another app's window, so `to` is a long burst rather than a
 * seek, and the wheel rides the SESSION tap (a pid-posted wheel is a no-op), so it lands on
 * whatever is under the point — the helper refuses rather than scroll a window covered there.
 */

import { AxRequestError } from './ax-client.ts';
import { MAX_SCROLL_PAGES } from './scroll-pages.ts';
import type { ActResult } from '../types.ts';
import type { ElementActs } from './act-element.ts';
import type { AxWindow } from './elements.ts';
import type { MouseHost } from './mouse.ts';

/** Wheel lines per "screen": macOS apps scroll ~3 lines per wheel notch; 20 lines ≈ one page. */
const PAGE_LINES = 20;
const HARD_LINES = 400;

/** How many screens one call may cover. Same ceiling `keys` puts on a repeat count, and past
 *  it the burst is `to:'bottom'` in all but name. */
const MAX_SCREENS = 20;

/**
 * The pointer-free rung: ask the scrolling area itself to turn a page (`ax-scroll.swift`).
 *
 * First because it costs the user nothing — no pointer moves, no window has to be uncovered, and
 * the app stays where it is; the wheel is refused wherever another window covers the point.
 *
 * Returns null when this rung does not apply, and the caller falls through to the wheel:
 *  · left/right — the vertical inversion is measured, the horizontal one is not (@see ax-scroll.swift);
 *  · no AXScrollArea — Electron exposes none at all, which is exactly where the wheel still works.
 *
 * An area that WAS found and did not move is not a fall-through: it is the end of the list, and
 * the wheel would only turn that truth into a covered-window refusal.
 */
async function pageRung(
  host: MouseHost,
  key: string | null,
  at: { x: number; y: number },
  where: string,
  direction: string,
  screens: number,
  to: string | undefined,
): Promise<ActResult | null> {
  if (direction !== "up" && direction !== "down") return null;
  try {
    const r = await host.call<{ applied: number; moved: boolean; delta: number; unit: string; area: string }>(
      "scrollpage",
      { pid: host.pid(), ...(key ? { key } : {}), ...at, direction, pages: to ? MAX_SCROLL_PAGES : screens },
    );
    if (!r.moved) {
      return { ok: true, note: `${where} is already at the ${direction === "down" ? "end" : "start"} — it did not move. Do not repeat this scroll; read what is here, or scroll the other way` };
    }
    // `applied` is what the area actually turned: fewer than asked means it reached the end, which
    // is how a `to` request answers honestly without macOS having a seek.
    const pages = `${r.applied} page${r.applied === 1 ? "" : "s"}`;
    const short = !to && r.applied < screens ? ` (asked for ${screens}, the area ended after ${r.applied})` : "";
    return {
      ok: true,
      note: to
        ? `scrolled ${where} to the ${to} — ${pages} through the app's own scrolling area, so the pointer never moved and nothing had to come forward`
        : `scrolled ${pages} ${direction} in ${where}${short} — through the app's own scrolling area, so the pointer never moved`,
      journal: { rung: "axpage", pages: r.applied, delta: Math.round(r.delta * 100) / 100, unit: r.unit },
    };
  } catch (e) {
    // no_scroll_area / no_element / a helper too old to know the op: all mean "not this rung".
    if (e instanceof AxRequestError && ["no_scroll_area", "no_element", "unsupported"].includes(e.code)) return null;
    throw e;
  }
}

export async function scrollVerb(
  /** `call` / `pid` / `rectOf` — the same three the mouse needs, so the same host carries them. */
  host: MouseHost,
  acts: ElementActs,
  frame: AxWindow,
  a: Record<string, any>,
): Promise<ActResult> {
  // Where the wheel goes: the named element's centre, or the window's when nothing was named. A
  // stale ref is refused the way a click refuses one — the alternative is wheeling at a place
  // nothing asked for.
  let at = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
  let where = 'the window';
  /** The named element's key in the HELPER's table. The page rung starts from it, and the helper
   *  knows no refs: handed "e8" it answers `stale_key` for an element that is right there. */
  let key: string | null = null;
  if (typeof a.ref === 'string' && a.ref) {
    const target = acts.resolve(a.ref, a.name);
    if (!('key' in target)) return target;
    key = target.key;
    const r = host.rectOf(a.ref);
    if (!r) {
      return { ok: false, note: `${target.role} "${target.name}" has no frame on this walk, so there is nowhere to scroll — observe and name a listed element` };
    }
    at = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    where = `${target.role} "${target.name}"`;
  }
  const centre = { x: Math.round(at.x), y: Math.round(at.y) };
  const pid = host.pid();
  const call = host.call;
  // `count` is screens, sent as one longer BURST rather than N bursts, which would each be a
  // separate animation to settle for the same displacement.
  const screens = Math.min(Math.max(Math.trunc(Number(a.count)) || 1, 1), MAX_SCREENS);
  // Refused rather than ignored: `to` is a seek to the end, so a screen count contradicts it, and
  // honouring only one leaves the caller believing it got both.
  if (a.to && Number(a.count) > 1) {
    return { ok: false, note: `scroll takes to:'${a.to}' or count, not both — to:'${a.to}' already goes as far as the window scrolls; drop one` };
  }
  const lines = a.to ? HARD_LINES : PAGE_LINES * screens;
  const direction = a.to === 'top' ? 'up' : a.to === 'bottom' ? 'down' : String(a.direction ?? 'down');
  // Rung 1, asked after the ref has been resolved and refused if stale.
  let paged: ActResult | null;
  try {
    paged = await pageRung(host, key, centre, where, direction, screens, a.to);
  } catch (e) {
    // The element went away between the walk and this call: the refusal every ref verb gives.
    if (e instanceof AxRequestError && e.code === "stale_key") return acts.staleRef(a.ref);
    throw e;
  }
  if (paged) return paged;
  // Only the wheel is left, and a background call may not post it. Said here, with the way that
  // DOES work in the background, rather than left to the helper gate's bare refusal: a list the
  // window's centre is not in (a sidebar) pages through its own area once an element in it is named.
  if (!host.pointerAllowed()) {
    const wheel = "The wheel needs the user's permission and interaction:'desktop'";
    const sideways = direction !== "up" && direction !== "down";
    return {
      ok: false,
      note: sideways
        ? `nothing was scrolled: only up and down go through the app's own scrolling area; ${direction} is a mouse-wheel scroll, `
          + `and this call is background-only (no wheel input was posted). ${wheel}`
        : key
          ? `nothing was scrolled: ${where} sits in no accessibility scrolling area (this app exposes none there), so only the mouse `
            + "wheel could scroll it, and this call is background-only (no wheel input was posted). keys('PageDown') / keys('PageUp') "
            + `go to whatever holds the app's focus without the pointer. ${wheel}`
          : "nothing was scrolled: with no ref the scroll aims at the window's CENTRE, there is no accessibility scrolling area under it, "
            + "and the mouse wheel is not available to a background-only call (no wheel input was posted). To scroll a list or a pane in the "
            + "background, name any element inside it: scroll({direction, ref}) turns that area's own page and never touches the pointer. "
            + wheel,
    };
  }

  const dy = direction === 'down' ? lines : direction === 'up' ? -lines : 0;
  const dx = direction === 'right' ? lines : direction === 'left' ? -lines : 0;
  try {
    await call('scroll', { pid, ...centre, dy, dx });
  } catch (e) {
    if (e instanceof AxRequestError && e.code === 'no_window') {
      return {
        ok: false,
        note: `${e.message} — a wheel event lands on whatever is under the point, so scrolling ${where} needs it uncovered there: `
          + "explain the foreground and pointer effects, obtain user permission, then activate and retry",
      };
    }
    throw e;
  }
  const place = `at ${where}'s centre`;
  const far = screens > 1 ? ` ${screens} screens` : "";
  return {
    ok: true,
    note: a.to
      ? `posted a long wheel burst ${direction} ${place} (not a verified jump-to-${a.to}); used system pointer input and requested cursor restoration without app activation — observe whether the content scrolled`
      : `posted wheel input${far} ${direction} ${place}; requested cursor restoration without app activation — observe whether the content scrolled`,
  };
}
