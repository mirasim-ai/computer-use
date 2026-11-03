/**
 * The two TEXT reads of a Chromium page — the viewport excerpt that rides under every element
 * observation, and the whole-page read behind `text()`. collect.ts walks CONTROLS (roles,
 * names, refs, rows); this module walks TEXT NODES, and the two never share a rule. Both are JS
 * function sources for `pageFn` (collect.ts), evaluated on one frame.
 */

import { unreachedJs } from "./unreached.ts";

/**
 * Caps on what a read hands back. Every cut carries a receipt (a silent cut reads as "this is
 * all there is"), worded with the CAP, never the actual length: the excerpt lands in `s.text`,
 * part of the change signature, so a moving number would make a frozen observation look changed
 * and defeat the repeat-action escalation. Same `(cut at N chars — …)` shape as `read-page.ts`.
 */
const EXCERPT_LINE_CAP = 120;
const EXCERPT_CHAR_CAP = 4000;
const FULL_TEXT_CHAR_CAP = 40_000;

/**
 * Body-text excerpt: direct text nodes in the viewport, in document order.
 *
 * NOT deduped, deliberately: text nodes cannot nest, and a content-dedupe would collapse 20
 * "Add to cart" rows into one product. Repetition on a list IS the information. Volume is
 * bounded by the line and char caps.
 */
export const EXCERPT_JS = String.raw`() => {
  const out = [];
  let lineCut = false;
  const inView = (el) => { const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight && r.width > 0 && r.height > 0; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 1) {
      // Image alts carry meaning (badges, status marks); same img "…" vocabulary as the page
      // read, in document order, not deduped: which item an icon sits next to IS the information.
      if (n.tagName !== 'IMG') continue;
      const alt = (n.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
      if (!alt || !inView(n)) continue;
      const st = getComputedStyle(n);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      if (out.length >= __LINE_CAP__) { lineCut = true; break; }
      out.push('img "' + alt.slice(0, 60) + '"');
      continue;
    }
    const t = (n.nodeValue || '').trim().replace(/\s+/g, ' ');
    // Single letters/digits stay — they are often THE payload (a die face, a target
    // digit, a grade); only bare punctuation/symbol crumbs are dropped.
    if (t.length < 1 || (t.length < 2 && !/[\p{L}\p{N}]/u.test(t))) continue;
    const p = n.parentElement;
    if (!p || !inView(p)) continue;
    const s = getComputedStyle(p);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    // Checked before the push, so the receipt fires only when a line was really left out.
    if (out.length >= __LINE_CAP__) { lineCut = true; break; }
    out.push(t);
  }
  if (lineCut) out.push('(cut at __LINE_CAP__ lines — the viewport has more)');
  const all = out.join('\n');
  if (all.length <= __CHAR_CAP__) return all;
  // The receipt is appended AFTER the slice so the cap never eats it.
  return all.slice(0, __CHAR_CAP__) + '\n(cut at __CHAR_CAP__ chars — the page has the full text)';
}`
  .replace(/__LINE_CAP__/g, String(EXCERPT_LINE_CAP))
  .replace(/__CHAR_CAP__/g, String(EXCERPT_CHAR_CAP));

/** What the whole-page read answers with: the text, plus what it did NOT reach. The tail is
 *  assembled in TypeScript so both text channels say it in exactly the same words. */
export interface FullTextResult {
  text: string;
  /** Screens below the fold that have not been scrolled to. */
  screens: number;
  un: { canvases: number; frames: number; folded: number; viewerType: string };
  /** Sizeable embedded pages whose text IS in this read (same-origin) — not unreached after all. */
  framesRead: number;
  /** Chars of the body left outside the region this read took (0 when it read the whole body). */
  outside: number;
}

/**
 * The text of the SAME-ORIGIN embedded pages inside `root`, each under a line naming it.
 *
 * The element walk already lists their controls, and a same-origin frame is one
 * `contentDocument` away. A cross-origin frame throws on the access and stays counted as unreached.
 */
const SAME_ORIGIN_FRAMES_JS = String.raw`((root) => {
  const parts = [];
  let read = 0;
  for (const f of root.querySelectorAll('iframe')) {
    let body = null;
    try { body = f.contentDocument && f.contentDocument.body; } catch { body = null; }
    if (!body) continue;
    const r = f.getBoundingClientRect();
    if (r.width >= 100 && r.height >= 100) read++; // the same floor unreached.ts counts frames by
    const t = (body.innerText || '').trim();
    if (t) parts.push('[embedded page' + (f.title ? ' "' + f.title + '"' : '') + ']\n' + t);
  }
  return { parts, read };
})`;

/** Full readable page text, for the page read (`w.text()`). */
export const FULL_TEXT_JS = String.raw`() => {
  // An open dialog is usually a PORTAL beside <main>, not inside it. Rendered dialogs outside the
  // main region come first — they are what covers the page right now.
  const visible = Array.from(document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]'))
    .filter((d) => d.getClientRects().length > 0);
  const outer = visible.filter((d) => !visible.some((o) => o !== d && o.contains(d)));
  // Which container is "the page": <main>/[role=main] is trusted. SEVERAL <article>s mean a
  // LIST, whose first one is a row, not the page; a lone <article> is the usual blog-post shape,
  // and the length check below catches it when it is not.
  const main = document.querySelector('main, [role=main]');
  const articles = document.querySelectorAll('article');
  let el = main || (articles.length === 1 ? articles[0] : null);
  let note = '';
  if (el) {
    const len = (el.innerText || '').length;
    // Dialogs are read separately, so they count on neither side; else every page with one open
    // would look like a shell.
    const dialogChars = outer.reduce((n, d) => n + (d.innerText || '').length, 0);
    const bodyLen = (document.body.innerText || '').length - dialogChars;
    // Safety net for a wrong pick: a container holding under HALF the page is not trusted over
    // the body. That high because widening wrongly costs a note plus nav and footer, while
    // staying narrow loses content in SILENCE. Real mains cover 92-98% (dev.to, lowest, 60%).
    if (len * 2 < bodyLen) {
      note = '(the <' + el.tagName.toLowerCase() + '> this page marks as its main content holds only '
        + len + ' of the page\'s ' + bodyLen + ' chars, so this read is the WHOLE page instead)';
      el = null;
    }
  }
  el = el || document.body;
  // What the region pick left out, counted so the read can SAY it; in silence the page's own
  // title and nav labels read as absent.
  const outside = el === document.body ? 0 : Math.max(0, (document.body.innerText || '').length
    - (el.innerText || '').length - outer.reduce((n, d) => n + (el.contains(d) ? 0 : (d.innerText || '').length), 0));
  const frames = __FRAMES__(el);
  const parts = outer.filter((d) => !el.contains(d)).map((d) => d.innerText || '')
    .concat(el.innerText || '').concat(frames.parts).filter(Boolean);
  // The note leads, like every page() receipt, so a caller keeping only the head still learns
  // the read was widened.
  // What is below the fold: innerText carries only what is RENDERED, so on a feed that mounts on
  // scroll this read is a prefix and nothing else says so. "Not scrolled to", because on a
  // static long page that text IS in this read.
  const below = Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight
    - document.documentElement.scrollTop);
  const screens = Math.round((below / Math.max(1, window.innerHeight)) * 10) / 10;
  const un = __UNREACHED__;
  const all = (note ? note + '\n' : '') + parts.join('\n\n').replace(/\n{3,}/g, '\n\n');
  // This IS the whole-page read, so a cut receipt cannot point at a narrower scope: it says the
  // page continues, which is what stops the model treating this as the end.
  const body = all.length <= __CAP__ ? all
    : all.slice(0, __CAP__) + '\n(cut at __CAP__ chars — the page continues past this)';
  return { text: body, screens, un, framesRead: frames.read, outside };
}`.replace(/__CAP__/g, String(FULL_TEXT_CHAR_CAP)).replace("__UNREACHED__", unreachedJs("document.body"))
  .replace("__FRAMES__", SAME_ORIGIN_FRAMES_JS);

/**
 * The text a WAIT searches: the whole document, not the region `text()` narrows to.
 *
 * "Is it on the page yet" cannot depend on which container the page marked as main — a header
 * title or a nav badge is exactly what one waits for. Same-origin frames ride along. No
 * receipts: the wait reports found / not found, never the text.
 */
export const WAIT_TEXT_JS = String.raw`() => {
  const frames = __FRAMES__(document.body);
  return [document.body.innerText || ''].concat(frames.parts).join('\n\n');
}`.replace("__FRAMES__", SAME_ORIGIN_FRAMES_JS);
