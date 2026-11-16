import type { Locator } from "playwright-core";
import { NAME_JS, pageFn } from "./collect.ts";

/**
 * Name the UI object intercepting a click, rather than its innermost span or changing counter.
 *
 * A fixed or sticky LAYER over the target is named as that layer, with where it sits: the link a
 * sticky header happens to put over the target ("a C#") is not the thing to deal with, and an ad
 * strip's innermost div or hashed iframe id names nothing at all. Where it sits tells the caller
 * which way out exists: a header pinned at the top is scrolled past, a strip along the bottom is
 * dismissed or scrolled away from. `target` (optional) is the covered element: a layer holding it
 * is the page it lives in, not a cover (a body pinned for scroll lock). `out` (optional) receives
 * the node the label names as `out.node`, so a caller can tell whether that cover is itself a
 * listed control without judging the cover a second way.
 */
export const COVERER_LABEL_JS = String.raw`(hit, nameOf, target, out) => {
  const named = (node, label) => { if (out) out.node = node; return label; };
  const clean = (s) => (s || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const layer = hit.closest('[role="tooltip"], [role="dialog"], [role="alertdialog"], [role="menu"], dialog, [popover]');
  if (layer) {
    const role = layer.getAttribute('role') || (layer.tagName === 'DIALOG' ? 'dialog' : 'popover');
    const name = clean(nameOf(layer));
    return named(layer, role + (name ? ' "' + name + '"' : ''));
  }
  const doc = hit.ownerDocument, win = doc.defaultView;
  let pinned = null;
  for (let n = hit; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) {
    if (target && n.contains(target)) break;
    const pos = win.getComputedStyle(n).position;
    if (pos === 'fixed' || pos === 'sticky') { pinned = n; break; }
  }
  const control = hit.closest('button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="menuitem"]');
  // A pinned control (a floating chat button) is still that control; a control INSIDE a pinned
  // layer is just where the probe landed on the layer.
  if (control && (!pinned || control.contains(pinned))) {
    const role = control.getAttribute('role') || (control.tagName === 'A' ? 'link' : control.tagName.toLowerCase());
    const name = clean(nameOf(control));
    return named(control, role + (name ? ' "' + name + '"' : ''));
  }
  if (pinned) {
    // By the viewport third its middle sits in: a sub-nav stacked under the main header is
    // still at the top, and a strip pushed partly off the bottom edge still along it.
    const r = pinned.getBoundingClientRect(), mid = (r.top + r.bottom) / 2, vh = win.innerHeight;
    const where = r.height >= vh * 0.9 && r.width >= win.innerWidth * 0.9 ? ' over the whole viewport'
      : mid < vh / 3 ? ' at the top of the viewport' : mid > vh * 2 / 3 ? ' along the bottom of the viewport' : '';
    const kind = win.getComputedStyle(pinned).position + (r.width >= r.height * 2 ? ' bar' : ' layer');
    // Who it is, only from what an author chose: an aria-label, a landmark, a readable id. A
    // generated id (hex runs, long digit runs) says nothing.
    const tag = pinned.tagName.toLowerCase();
    const id = pinned.id && !/[0-9a-f]{8}|\d{4}/i.test(pinned.id) ? '#' + pinned.id : '';
    const who = clean(pinned.getAttribute('aria-label'))
      || (['header', 'nav', 'footer', 'aside'].includes(tag) ? tag + (id ? ' ' + id : '') : id);
    return named(pinned, kind + where + (who ? ' (' + who + ')' : ''));
  }
  const labelled = hit.closest('[aria-label]');
  if (labelled) return named(labelled, 'element "' + nameOf(labelled).slice(0, 80) + '"');
  return named(hit, hit.id ? 'element #' + hit.id : 'another element');
}`;

/**
 * Is `hit`, which sits over the text entry `el`, part of how that entry is BUILT rather than a
 * cover? Two shapes, and in both a click at that point is the one a person makes there:
 *
 *  · An editor's input proxy. A code editor keeps the text entry it types through BEHIND its own
 *    rendered text (Monaco's `.inputarea` and `.native-edit-context` in VS Code: z-index -10) and
 *    moves it to the caret. The point a click aims at lands on that text, inside the same editor,
 *    and the editor puts the caret there and focuses the proxy. Only a negative z-index
 *    qualifies, and only a hit inside the proxy's own parent.
 *
 *  · An empty entry's placeholder. A rich-text editor draws "Write something…" as an element of
 *    its own laid over the empty entry (Draft.js: a positioned sibling of the editable's wrapper),
 *    and an empty body is one line high, so the placeholder holds the entry's whole click point.
 *    Taken for a cover, the body of a new document was listed nowhere, find() answered "covered",
 *    and the advice (dismiss it, scroll clear of it) named nothing that can be done: there is no
 *    layer to close. It qualifies only while the entry is EMPTY, when it sits in the entry's own
 *    container (its parent, or that one's parent) and inside that container's box, and when it is
 *    plain text: nothing in or around it takes a click of its own.
 *
 * Anything else on top (a notification over the editor, a modal's backdrop) is still a cover.
 */
export const EDITOR_PROXY_JS = String.raw`(el, hit) => {
  const tag = el.tagName;
  const entry = tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable || el.getAttribute('role') === 'textbox';
  if (!entry || !hit || !el.parentElement) return false;
  const win = el.ownerDocument.defaultView;
  if (el.parentElement.contains(hit) && parseInt(win.getComputedStyle(el).zIndex, 10) < 0) return true;
  // The placeholder of an empty entry.
  if (hit === el || el.contains(hit) || hit.contains(el)) return false;
  const held = typeof el.value === 'string' ? el.value : (el.innerText || '');
  if (held.trim()) return false;
  const body = el.ownerDocument.body;
  let box = el.parentElement;
  if (!box.contains(hit)) box = box.parentElement;
  if (!box || box === body || box === el.ownerDocument.documentElement || !box.contains(hit)) return false;
  // Plain text: nothing between it and the container takes a click of its own, nor inside it.
  const TAKES_CLICKS = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [tabindex], [onclick], [contenteditable=""], [contenteditable="true"]';
  const LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="tooltip"], dialog, [popover]';
  for (let n = hit; n && n !== box; n = n.parentElement) if (n.matches(TAKES_CLICKS) || n.matches(LAYER)) return false;
  if (hit.querySelector(TAKES_CLICKS) || !(hit.textContent || '').trim()) return false;
  const h = hit.getBoundingClientRect(), b = box.getBoundingClientRect();
  return h.left >= b.left - 2 && h.top >= b.top - 2 && h.right <= b.right + 2 && h.bottom <= b.bottom + 2;
}`;

/** {@link EDITOR_PROXY_JS} for one element, probed at its click point now. */
export async function isEditorProxy(loc: Locator): Promise<boolean> {
  try {
    return await loc.evaluate(pageFn(String.raw`(el) => {
      const proxy = __EDITOR_PROXY__;
      const r = el.getBoundingClientRect();
      return proxy(el, el.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }`.replace("__EDITOR_PROXY__", EDITOR_PROXY_JS)) as any, undefined, { timeout: 2000 }) as boolean;
  } catch {
    return false;
  }
}

/**
 * What covers this element's click point RIGHT NOW, or null when nothing does (or nothing of it
 * is in the viewport, a scrolling matter). Live, not from the snapshot: the page has had time to
 * change, and a stale culprit is worse than none. Same probe as `collect-viewport.ts` — the click
 * point, then `elementFromPoint`.
 *
 * An element AROUND the target can be the culprit too: a `::before`/`::after` layer hit-tests as
 * its host, so a decorative pseudo-element of an ancestor that sits over the control reads as the
 * ancestor (measured: a header's `::after` over its own Add button). `pseudo` names that layer.
 */
export async function coverOf(loc: Locator): Promise<{ who: string; pseudo: string | null } | null> {
  try {
    return await loc.evaluate(pageFn(String.raw`(el) => {
      const label = __COVERER_LABEL__, nameOf = __NAME_OF__, proxy = __EDITOR_PROXY__;
      const doc = el.ownerDocument, win = doc.defaultView;
      const quads = (el.getClientRects && el.getClientRects().length)
        ? Array.from(el.getClientRects()) : [el.getBoundingClientRect()];
      let px = -1, py = -1;
      for (const q of quads) {
        const l = Math.max(q.left, 0), t = Math.max(q.top, 0);
        const rr = Math.min(q.right, win.innerWidth), bb = Math.min(q.bottom, win.innerHeight);
        if (rr - l > 0 && bb - t > 0) { px = (l + rr) / 2; py = (t + bb) / 2; break; }
      }
      if (px < 0) return null;   // nothing of it is in the viewport: a scrolling matter
      const hit = doc.elementFromPoint(px, py);
      if (!hit || hit === el || el.contains(hit) || proxy(el, hit)) return null;
      if (!hit.contains(el)) return { who: label(hit, nameOf, el), pseudo: null };
      // The point reached an ancestor, not the target. Only a pseudo-element layer of that
      // ancestor makes it a cover; a target that lets clicks through is not covered.
      if (win.getComputedStyle(el).pointerEvents === 'none') return null;
      const pseudo = ['::after', '::before'].find((p) => {
        const st = win.getComputedStyle(hit, p);
        return st.content !== 'none' && st.content !== 'normal' && st.display !== 'none';
      });
      if (!pseudo) return null;
      const named = label(hit, nameOf, el);
      const tag = hit.tagName.toLowerCase() + (hit.classList.length ? '.' + hit.classList[0] : '');
      return { who: named === 'another element' ? tag : named, pseudo };
    }`.replace("__COVERER_LABEL__", COVERER_LABEL_JS).replace("__NAME_OF__", NAME_JS).replace("__EDITOR_PROXY__", EDITOR_PROXY_JS)) as any,
      undefined, { timeout: 2000 }) as { who: string; pseudo: string | null } | null;
  } catch {
    return null; // unreadable now — the caller's own failure is the honest answer
  }
}
