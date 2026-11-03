/**
 * The three page-side scripts a scroll runs: which element actually scrolls, how far it has got,
 * and the jump to either end.
 *
 * Source STRINGS evaluated in the page, sharing nothing with the TypeScript around them but
 * their arguments. A scroller is rarely the element a model names, and almost never `document`.
 */

import { SCROLL_REGION_JS } from "./scroll-regions.ts";
import { PAGE_REFS_JS } from "./page-refs.ts";

const FIND_SCROLL_MARK_JS = String.raw`function findMarked(root = document) {
  const hit = root.querySelector('[data-mfscroll]');
  if (hit) return hit;
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) { const nested = findMarked(el.shadowRoot); if (nested) return nested; }
  }
  return null;
}`;

/**
 * Pick the container to scroll and mark it. Args: [axisH, refSel].
 *
 * refSel given → nearest scrollable ancestor of that element (itself included), the
 * document as the final ancestor; none → kind:'none' (reported honestly, never a silent
 * fall back to scrolling something else).
 *
 * Without a ref, only a unique visible region is safe. Several regions return their
 * observed refs; control counts and remaining room cannot tell which region the caller meant.
 * The document remains a candidate and can be explicitly selected with ref:'window'.
 *
 * The chosen container gets a transient data-mfscroll mark (found again by the measure
 * step) and a persistent data-mfsc id (the ledger key; dies with the page).
 */
export const SCROLL_TARGET_JS = String.raw`([axisH, refSel]) => {
  const refs = (__PAGE_REFS__)();
  const nodes = [];
  const visit = root => { for (const el of root.querySelectorAll('*')) { nodes.push(el); if (el.shadowRoot) visit(el.shadowRoot); } };
  visit(document);
  for (const el of nodes) if (el.hasAttribute('data-mfscroll')) el.removeAttribute('data-mfscroll');
  const vw = innerWidth, vh = innerHeight;
  const de = document.scrollingElement || document.documentElement;
  const scrollRegion = __SCROLL_REGION__;
  const modals = nodes.filter(el => el.matches('[aria-modal="true"], dialog:modal') && el.getBoundingClientRect().width > 0);
  const modal = modals[modals.length - 1];
  const scrollable = (el) => {
    const s = getComputedStyle(el);
    if (!/auto|scroll|overlay/.test(axisH ? s.overflowX : s.overflowY)) return false;
    return axisH ? el.scrollWidth > el.clientWidth + 4 : el.scrollHeight > el.clientHeight + 4;
  };
  const docScrollable = axisH ? de.scrollWidth > (de.clientWidth || vw) + 4
                              : de.scrollHeight > (de.clientHeight || vh) + 4;
  const doc = () => ({ kind: 'doc', id: 'window', name: 'window',
    x: Math.round(vw / 2), y: Math.round(vh / 2),
    before: axisH ? (window.scrollX || 0) : (window.scrollY || 0),
    client: axisH ? (de.clientWidth || vw) : (de.clientHeight || vh),
    total: axisH ? de.scrollWidth : de.scrollHeight });
  const mark = (el) => {
    el.setAttribute('data-mfscroll', '1');
    let id = el.getAttribute('data-mfsc');
    if (!id) { id = 's' + (window.__mfNextSc = (window.__mfNextSc || 0) + 1); el.setAttribute('data-mfsc', id); }
    const r = el.getBoundingClientRect();
    const name = scrollRegion(el)?.name || el.getAttribute('aria-label') || el.id || 'Scrollable area';
    return { kind: 'el', id, name,
      x: Math.round(Math.max(r.left, 0) + (Math.min(r.right, vw) - Math.max(r.left, 0)) / 2),
      y: Math.round(Math.max(r.top, 0) + (Math.min(r.bottom, vh) - Math.max(r.top, 0)) / 2),
      before: axisH ? el.scrollLeft : el.scrollTop,
      client: axisH ? el.clientWidth : el.clientHeight,
      total: axisH ? el.scrollWidth : el.scrollHeight };
  };
  if (refSel === 'window') return modal ? {kind:'none',reason:'modal'} : doc();
  if (refSel) {
    const start = refs.elements.get(refSel)?.deref();
    if (!start?.isConnected) return { kind: 'none', reason: 'gone' };
    if (modal && !modal.contains(start)) return {kind:'none',reason:'modal'};
    for (let n = start; n && n !== document.body && n !== de; n = n.parentElement || n.getRootNode().host) {
      if (scrollable(n)) return mark(n);
    }
    return docScrollable && !modal ? doc() : { kind: 'none', reason: modal ? 'modal' : 'noscroll' };
  }
  // Only exposed regions: hidden panes and regions behind a dialog are not candidates.
  const visibleArea = (el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.min(r.right, vw) - Math.max(r.left, 0), h: Math.min(r.bottom, vh) - Math.max(r.top, 0) };
  };
  const inner = [];
  for (const el of nodes) {
    if (!scrollable(el) || !scrollRegion(el)) continue;
    if (modal && !modal.contains(el)) continue;
    const b = visibleArea(el);
    if (b.w < 80 || b.h < 80) continue;         // too small to be the main list
    const r = el.getBoundingClientRect();
    const root = el.getRootNode();
    const hit = (root.elementFromPoint ? root : document).elementFromPoint(Math.max(0, r.left) + b.w / 2, Math.max(0, r.top) + b.h / 2);
    if (!hit || (hit !== el && !el.contains(hit))) continue;
    inner.push(el);
  }
  if (inner.length + (docScrollable && !modal ? 1 : 0) > 1) {
    const candidates = inner.map(el => {
      const r = el.getBoundingClientRect();
      return {ref: refs.byElement.get(el) || null, name: scrollRegion(el).name,
        position: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + '×' + Math.round(r.height)};
    });
    if (docScrollable && !modal) candidates.push({ref:'window',name:'page'});
    return {kind:'ambiguous',candidates};
  }
  return inner.length ? mark(inner[0]) : modal ? {kind:'none',reason:'modal'} : doc();
}`.replace("__SCROLL_REGION__", SCROLL_REGION_JS).replace("__PAGE_REFS__", PAGE_REFS_JS);

/** Re-measure the scrolled container. Args: [axisH, isDoc]. A lost mark means the
 * container was re-rendered out from under us — reported as such, never re-measured
 * against a different element and passed off as the same one. */
export const SCROLL_MEASURE_JS = String.raw`([axisH, isDoc]) => {
  const de = document.scrollingElement || document.documentElement;
  if (isDoc) return { lost: false, pos: axisH ? (window.scrollX || 0) : (window.scrollY || 0),
    client: axisH ? (de.clientWidth || innerWidth) : (de.clientHeight || innerHeight),
    total: axisH ? de.scrollWidth : de.scrollHeight };
  const el = (__FIND_MARK__)();
  if (!el) return { lost: true, pos: 0, client: 1, total: 0 };
  return { lost: false, pos: axisH ? el.scrollLeft : el.scrollTop,
    client: axisH ? el.clientWidth : el.clientHeight,
    total: axisH ? el.scrollWidth : el.scrollHeight };
}`.replace("__FIND_MARK__", FIND_SCROLL_MARK_JS);

/** Jump to an end by setting scrollTop directly (window: scrollTo) — keyboard Home/End
 * would depend on focus and mean different things per app. Args: [toTop, isDoc]. */
export const SCROLL_JUMP_JS = String.raw`([toTop, isDoc]) => {
  const de = document.scrollingElement || document.documentElement;
  if (!isDoc) {
    const el = (__FIND_MARK__)();
    if (!el) return { lost: true, before: 0 };
    const before = el.scrollTop;
    el.scrollTop = toTop ? 0 : el.scrollHeight;
    return { lost: false, before };
  }
  const before = window.scrollY || 0;
  window.scrollTo(0, toTop ? 0 : de.scrollHeight);
  return { lost: false, before };
}`.replace("__FIND_MARK__", FIND_SCROLL_MARK_JS);
