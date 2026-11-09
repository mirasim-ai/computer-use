/**
 * The VIEWPORT WALK: the one function this platform evaluates in a page to turn its DOM into the
 * element list a model reads.
 *
 * It is ONE function source (a string the page compiles), so it cannot be cut into modules; that
 * is why it is the one computer-use source over 20 KB, a deliberate exemption. Everything with a
 * seam (roles, budgets, the name helpers it substitutes in, `pageFn`) lives in `collect.ts`.
 */

import { BROWSER_ROLES, GROUP_CAP, GROUP_UP, NAME_JS, ROW_CAP, ROW_UP, STATE_CLASS_JS } from "./collect.ts";
import { CHECKABLE_TARGET_JS } from "./checkable-target.ts";
import { SCROLL_REGION_JS } from "./scroll-regions.ts";
import { COVERER_LABEL_JS, EDITOR_PROXY_JS } from "./coverer-label.ts";
import { HEADINGS_JS } from "./headings.ts";
import { PAGE_REFS_JS } from "./page-refs.ts";

/**
 * Enumerate actionable elements in one frame: pierce shadow DOM, remember hits in a
 * page-local registry, return frame-relative rects + nextK (cross-frame continuous numbering).
 * Viewport filtering and iframe offset translation are done in TypeScript.
 *
 * Refs are STICKY: an element already in the registry keeps its number; only new elements mint
 * one (the counter start comes from the main frame's window.__mfNextK, threaded through frames by
 * TypeScript). Marks and counter die together on real navigation.
 *
 * Occlusion pre-check: an element whose click point hits an UNRELATED element (neither self,
 * descendant nor ancestor) cannot be clicked — it is dropped and counted, with the most common
 * coverer named, so the observation can say "deal with the dialog first". Shadow-DOM elements
 * skip the test: elementFromPoint reports the HOST and contains() does not pierce shadow roots,
 * so they would all falsely test as covered.
 */
export const VIEWPORT_JS = String.raw`(startK) => {
  const ROLES = new Set(__ROLES__);
  const refs = (__PAGE_REFS__)();
  for (const [id, entry] of refs.elements) if (!entry.deref()?.isConnected) refs.elements.delete(id);
  // Only the outermost contenteditable block is a textbox; isContentEditable is inherited.
  const editableRoot = (el) => el.isContentEditable &&
    !(el.parentElement && el.parentElement.isContentEditable);
  const roleOf = (el) => el.getAttribute('role') || (editableRoot(el) ? 'textbox' : '') || ({
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
    // A <summary> IS the button that opens its <details>; the cursor:pointer fallback misses it
    // (its cursor is the default), so without this entry collapsed sections are undiscoverable.
    SUMMARY: (el.parentElement && el.parentElement.tagName === 'DETAILS') ? 'button' : '',
    INPUT: (el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' :
            (el.type === 'button' || el.type === 'submit') ? 'button' :
            el.type === 'range' ? 'slider' : el.type === 'file' ? 'file' : 'textbox'),
  }[el.tagName] || '');
  const nameOf = __NAME_OF__;
  const checkableTarget = __CHECKABLE_TARGET__;
  const scrollRegion = __SCROLL_REGION__;
  const covererLabel = __COVERER_LABEL__;
  const editorProxy = __EDITOR_PROXY__;
  const headingsOf = __HEADINGS__;
  const NON_TEXT = new Set(['button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color']);
  const stateOf = (el) => {
    // Truncation is marked (…) and edge whitespace called out: copy-exactly tasks judge
    // by strict equality, and a summary that silently trims is a receipt that lies.
    const cut = (s) => { s = (typeof s === 'string' ? s : '').trim().replace(/\s+/g, ' ');
      return s.length > 60 ? s.slice(0, 60) + '…' : s; };
    const tag = (el.tagName || '').toUpperCase();
    const base = (() => {
      if (el.isContentEditable) { const v = cut(el.innerText); return v ? ('filled:' + v) : 'empty'; }
      const ac = el.getAttribute && el.getAttribute('aria-checked');
      if (ac === 'true' || ac === 'false') return ac === 'true' ? 'checked' : 'unchecked';
      if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio'))
        return el.checked ? 'checked' : 'unchecked';
      if (tag === 'SELECT') {
        const o = el.selectedOptions && el.selectedOptions[0];
        const t = cut(o && (o.label || o.textContent));
        return t ? 'selected:' + t : 'unselected';
      }
      // What upload() set is otherwise invisible: a file input's value reads '' either way.
      if (tag === 'INPUT' && el.type === 'file') {
        const names = Array.from(el.files || []).map((f) => f.name);
        return names.length ? 'file:' + cut(names.join(', ')) : 'no file';
      }
      if (tag === 'INPUT' && el.type === 'range') {
        return 'value:' + el.value + ' (' + (el.min || '0') + '–' + (el.max || '100') + ')';
      }
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && !NON_TEXT.has(el.type))) {
        const v = (el.value == null) ? '' : String(el.value);
        // Typed inputs accept ONE wire format, usually not the task's own wording ("enter
        // 01/04/2017"). Say it up front rather than let the rejection be the first hint.
        const FMT = { date: 'YYYY-MM-DD', 'datetime-local': 'YYYY-MM-DDThh:mm',
                      month: 'YYYY-MM', week: 'YYYY-Www', time: 'hh:mm' };
        const fmt = FMT[el.type] ? ' (' + el.type + ', needs ' + FMT[el.type] + ')' : '';
        if (!v) return 'empty' + fmt;
        const ws = v !== v.trim() ? " (value has edge whitespace — exact value via page({ref}))" : '';
        return el.type === 'password' ? ('filled:' + v.length + ' chars') : ('filled:' + cut(v) + fmt + ws);
      }
      return '';
    })();
    // Silent form validation is the top cause of click-does-nothing loops: pages mark the
    // offending field (aria-invalid or an error/invalid class) and swallow the submit.
    const cls = typeof el.className === 'string' ? el.className : '';
    const inv = (el.getAttribute && el.getAttribute('aria-invalid') === 'true')
      || (base !== '' && /(^|[\s_-])(error|invalid)([\s_-]|$)/i.test(cls));
    // Where the keyboard goes is otherwise invisible, and a click that DID move focus would
    // read as "no effect".
    const focused = (el.getRootNode ? el.getRootNode() : document).activeElement === el;
    // A switched-off control lists like a live one, and acting on it fails opaquely (Playwright
    // times out by ref; by x/y nothing moves), so name it. :disabled, not el.disabled — the
    // property ignores an ancestor <fieldset disabled>. The class must END the token
    // (btn--disabled), never merely start one (disabled-overlay): a false mark on a LIVE button
    // is costlier than a missed one.
    const disabled = (el.matches && el.matches(':disabled'))
      || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')
      || /(^|[\s_-])disabled(\s|$)/i.test(cls);
    // A collapsed disclosure's content is not in the DOM; only this mark says a click reveals it.
    const ax = el.getAttribute && el.getAttribute('aria-expanded');
    // A native <details> carries its state in its open property (the ARIA is implied); read it
    // off the parent so a summary reads like a hand-rolled disclosure button.
    const det = (el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS')
      ? (el.parentElement.open ? 'expanded' : 'collapsed') : '';
    const exp = ax === 'true' ? 'expanded' : ax === 'false' ? 'collapsed' : det;
    // ARIA selection: the selected tab, the pressed toggle, the current page.
    const cur = el.getAttribute && el.getAttribute('aria-current');
    let sel = !el.getAttribute ? '' :
      el.getAttribute('aria-selected') === 'true' ? 'selected' :
      el.getAttribute('aria-pressed') === 'true' ? 'pressed' :
      (cur && cur !== 'false') ? 'current' : '';
    // Class-name fallback for pages without ARIA (zero false marks measured on bootstrap docs,
    // MDN, HN, wikipedia). Stateless elements only: a form control's selection is its value.
    if (!sel && base === '') {
      const m = (${STATE_CLASS_JS})(cls);
      if (m) sel = m;
    }
    let out = base;
    if (exp) out = out ? exp + ', ' + out : exp;
    if (sel) out = out ? sel + ', ' + out : sel;
    if (inv) out = out ? 'invalid, ' + out : 'invalid';
    // Ahead of focused, never after it: the focus mark must stay OUTERMOST, because the
    // observation layer cancels focus-only diffs by matching the leading "[focused, ".
    if (disabled) out = out ? 'disabled, ' + out : 'disabled';
    if (focused) out = out ? 'focused, ' + out : 'focused';
    return out;
  };
  const visible = (el) => { const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') <= 0) return false;
    // Computed opacity is NOT inherited: a child of an 'opacity: 0' container reports 1 here
    // and would be counted "covered" by an overlay no person can see. checkVisibility walks the
    // ancestor chain; an engine without it keeps the per-element checks.
    // (NO BACKTICKS in comments here — they live inside the String.raw page-source literal.)
    try { if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true })) return false; }
    catch (e) { /* older engine — the per-element checks above already answered */ }
    return true; };
  // Fallback signals for role-less controls: cursor:pointer (div+onclick rows), or a place in
  // the TAB ORDER (a hover menu's "More ▾" span with tabindex=0 and the plain cursor). Short
  // labels only — a focusable scroll region or card carries tabindex=0 with its whole text.
  const ptrInteractive = (el) => {
    try {
      const name = nameOf(el);
      if (!name) return false;
      if (getComputedStyle(el).cursor === 'pointer') return true;
      return el.tabIndex >= 0 && el.hasAttribute('tabindex') && name.length <= 40
        && (el.textContent || '').trim().length <= 40;
    }
    catch (e) { return false; }
  };
  let coveredCount = 0;
  const coverers = {};
  // An open MODAL dialog, when the page declares one. Controls behind it are covered on
  // purpose, and "deal with it first" is wrong advice to a caller working inside it. The last
  // one in document order is the topmost.
  let modal = null;
  try { const all = document.querySelectorAll('[aria-modal="true"], dialog:modal'); modal = all[all.length - 1] || null; }
  catch (e) { /* an engine without :modal — no modal reading, the old wording stands */ }
  let behindModal = 0;
  // Items dropped from the list by the occlusion check, kept for the observation layer.
  const coveredItems = [];
  // Their elements, index-aligned: mintRefs needs the node, and a covered item still earns a
  // number (it is reported).
  const coveredHits = [];
  // And the node each one's cover label names, index-aligned again: when that node is itself a
  // listed control, the covered item carries its ref (byRef) — find(…, {why}) hands it on.
  const coverNodes = [];
  // Occlusion is sampled where Playwright would click: the center of the FIRST client quad in
  // the viewport (a bbox center mis-drops wrapped inline links), shrunk to the box every
  // clipping ancestor leaves visible — elementFromPoint ignores scroll-container clipping. A hit
  // on the element's own ANCESTOR is overflow clipping, NOT covered. Cached per node: one
  // observation asks the same ancestors hundreds of times.
  const clipCache = new Map();
  const clipOf = (n) => {
    if (clipCache.has(n)) return clipCache.get(n);
    const s = getComputedStyle(n);
    const info = { box: (s.overflowX !== 'visible' || s.overflowY !== 'visible') ? n.getBoundingClientRect() : null,
                   fixed: s.position === 'fixed' };
    clipCache.set(n, info);
    return info;
  };
  const clipBox = (n) => clipOf(n).box;
  // The boxes that clip el. A fixed-position node escapes every overflow above it (a menu
  // pinned inside a scrolling list is fully visible), so the walk stops there.
  const clipsOf = (el) => {
    const out = [];
    if (clipOf(el).fixed) return out;
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const c = clipOf(n);
      if (c.box) out.push(c.box);
      if (c.fixed) break;
    }
    return out;
  };
  // The nearest ancestor that actually scrolls — the region a row can be scrolled out of.
  const scrollerOf = (el) => {
    if (clipOf(el).fixed) return null;
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (clipBox(n) && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1)) return n;
      if (clipOf(n).fixed) return null;
    }
    return null;
  };
  // Pinned chrome of that same region (a sticky group heading) hides the rows scrolled under
  // it; that is a scrolling matter too, never an overlay to dismiss.
  const stickyWithin = (hit, scroller) => {
    for (let n = hit; n && n !== scroller; n = n.parentElement) {
      if (getComputedStyle(n).position === 'sticky') return true;
    }
    return false;
  };
  // true = reachable here; false = covered (counted, not listed); 'clipped' = on the viewport
  // but scrolled out of its own container — listed with the off-screen elements instead.
  // A false leaves what covers it in lastCoverer: each covered item names its OWN cover.
  let lastCoverer = '';
  const lastCover = { node: null };
  const clickable = (el) => {
    if (el.getRootNode && el.getRootNode() instanceof ShadowRoot) return true; // see header comment
    let px = -1, py = -1, inViewport = false;
    const quads = (el.getClientRects && el.getClientRects().length)
      ? Array.from(el.getClientRects()) : [el.getBoundingClientRect()];
    for (const q of quads) {
      let l = Math.max(q.left, 0), t = Math.max(q.top, 0);
      let rr = Math.min(q.right, innerWidth), bb = Math.min(q.bottom, innerHeight);
      if (!(rr - l > 0 && bb - t > 0)) continue;
      inViewport = true;
      for (const c of clipsOf(el)) {
        l = Math.max(l, c.left); t = Math.max(t, c.top); rr = Math.min(rr, c.right); bb = Math.min(bb, c.bottom);
      }
      if (rr - l > 0 && bb - t > 0) { px = (l + rr) / 2; py = (t + bb) / 2; break; }
    }
    if (px < 0) return inViewport ? 'clipped' : true;
    let hit;
    try { hit = document.elementFromPoint(px, py); } catch (e) { return true; }
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return true;
    // A code editor's own text over its input proxy is how the editor is built (see coverer-label.ts).
    if (editorProxy(el, hit)) return true;
    const scroller = scrollerOf(el);
    if (scroller && scroller.contains(hit) && stickyWithin(hit, scroller)) return 'clipped';
    lastCover.node = null;
    const label = covererLabel(hit, nameOf, el, lastCover);
    lastCoverer = label;
    coverers[label] = (coverers[label] || 0) + 1;
    coveredCount++;
    if (modal && !modal.contains(el)) behindModal++;
    return false;
  };
  const items = [];
  // items[i] and hits[i] are the same element, page-side, for the passes below.
  const hits = [];
  let k = startK;
  // Recursive walk, piercing shadow roots.
  const walk = (root) => {
    const nodes = root.querySelectorAll('*');
    for (const el of nodes) {
      if (el.shadowRoot) walk(el.shadowRoot);
      let role = roleOf(el);
      const region = !ROLES.has(role) ? scrollRegion(el) : null;
      if (region) role = 'region';
      // Only a separator that NAMES itself is a handle worth a ref; decorative rules carry the
      // same role. Checked before the cap, so they never spend one.
      if (role === 'separator' && !nameOf(el)) continue;
      if (!role && !ptrInteractive(el)) continue;
      if (role && !ROLES.has(role) && !region) { if (!ptrInteractive(el)) continue; role = role || ''; }
      const visual = checkableTarget(el);
      if (!visual && !visible(el)) continue;
      if (el.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
      const target = visual || el;
      const r = target.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // Sticky ref, READ only: minting waits for mintRefs, once the drops are known.
      const ref = refs.byElement.get(el);
      // ptrOnly: listed on the fallback signal alone, for the nesting pass below. The TS side
      // maps fields explicitly and never sees it.
      const item = { ref, role: role || 'button', name: region ? region.name : nameOf(el),
                     val: region ? 'scrollable ' + [region.vertical ? 'vertically' : '', region.horizontal ? 'horizontally' : ''].filter(Boolean).join(' and ') : stateOf(el),
                     top: r.top, left: r.left, width: r.width, height: r.height,
                     ptrOnly: region || ROLES.has(role) ? 0 : 1 };
      // Covered: NOT listed, but kept as the diff baseline (else every full-screen dialog
      // rewrites the whole list).
      const reach = clickable(target);
      if (!reach) { item.by = lastCoverer; coveredItems.push(item); coveredHits.push(el); coverNodes.push(lastCover.node); continue; }
      if (reach === 'clipped') item.clipped = 1;
      items.push(item);
      hits.push(el);
    }
  };
  walk(document);
  // ── Nesting suppression ─────────────────────────────────────────────────────
  // The cursor property is INHERITED, so one styled node hands the fallback signal to every
  // named element in its chain, each coming back as its own "button" (a TOC <li><a>Career</a>
  // listed as button "Career" + link "Career"). Same names at overlapping rects, which the
  // ⟨row⟩ pass cannot separate.
  // Dropping a live target costs more than keeping a duplicate, so real controls (a role of
  // their own) are never dropped here; only fallback-only elements are:
  // - with a collected ancestor: a fragment the ancestor captures, or a click that bubbles to it.
  //   The card survives, its <h3>/<span> do not.
  // - as a wrapper of a real control, only when its name equals that control's: it adds no
  //   second thing to click. A card with its own handler reads as its whole content and keeps
  //   its ref (which handler exists is not readable page-side).
  // Trade-off: a pointer-cursor CONTAINER of pointer-cursor rows keeps only the container.
  // One upward walk over a Map, never pairwise contains() (200 controls → 40,000 tests).
  const byEl = new Map();
  for (let i = 0; i < items.length; i++) byEl.set(hits[i], i);
  const drop = new Set();
  for (let i = 0; i < items.length; i++) {
    // A visible label is the same action as its CSS checkbox, not a second button.
    const node = hits[i];
    if (items[i].ptrOnly && node.tagName === 'LABEL') {
      const input = node.control || node.previousElementSibling;
      if (byEl.has(input) && checkableTarget(input)) drop.add(i);
    }
    for (let n = hits[i].parentElement; n; n = n.parentElement) {
      const j = byEl.get(n);
      if (j === undefined) continue;
      // A scroll region contains controls; it is not their clickable ancestor.
      if (items[j].role === 'region') continue;
      if (items[i].ptrOnly) drop.add(i);
      else if (items[j].ptrOnly && items[j].name === items[i].name) drop.add(j);
    }
  }
  // Backwards, so items and hits stay index-aligned for the row pass.
  for (let i = items.length - 1; i >= 0; i--) if (drop.has(i)) { items.splice(i, 1); hits.splice(i, 1); }
  // ── Mint ────────────────────────────────────────────────────────────────────
  // Register only the nodes that survived filtering. Re-register an existing ref too: a pruned
  // node may have been reinserted. No caller may depend on the order refs are minted in.
  const mintRefs = (list, nodes) => {
    for (let i = 0; i < list.length; i++) {
      if (!list[i].ref) {
        list[i].ref = 'e' + k++;
        refs.byElement.set(nodes[i], list[i].ref);
      }
      refs.elements.set(list[i].ref, new WeakRef(nodes[i]));
    }
  };
  mintRefs(items, hits);
  mintRefs(coveredItems, coveredHits);
  // A cover that is itself a listed control (a floating button) has a ref the caller can act on;
  // a layer that is not (a backdrop, a sticky bar) has none, and gets none.
  const listedRef = new Map();
  for (let i = 0; i < items.length; i++) listedRef.set(hits[i], items[i].ref);
  for (let i = 0; i < coveredItems.length; i++) {
    const byRef = coverNodes[i] && listedRef.get(coverNodes[i]);
    if (byRef) coveredItems[i].byRef = byRef;
  }
  // ── Row context ─────────────────────────────────────────────────────────────
  // Three identical 'button "Delete"' lines pass the identity check on the wrong row, and
  // sticky refs stop tracking row order once rows are inserted or recycled.
  // For a set of same-named elements, walk up from each while the ancestor still contains only
  // THAT member: the last such ancestor IS the row/card, whatever tag builds it. Chains are
  // counted once into 'spread' (O(ROW_UP·N)), never re-tested pairwise.
  //
  // Nameless controls get the same treatment as a one-member group; their nearest context is
  // the <label> a name lookup could not reach. A unique NAMED element gets nothing.
  // Fields, not one blob: innerText glues inline siblings ("EditDelete", "Widget 1$19.00Add to
  // cart"), so descend a few levels and take each child's text as its own segment. innerText
  // keeps it visibility-correct; a child with no client rects is not rendered at all.
  // That client-rects guard is what keeps an inline <svg>'s <title>/<desc> out. SEG_SKIP is only
  // a pre-filter and must stay HTML-only: SVG tagNames preserve case ('title'), so an entry for
  // one could never match.
  const SEG_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const segsOf = (el) => {
    const out = [];
    let total = 0;
    const push = (raw) => {
      for (const part of ((raw || '') + '').split(/[\n\t]+/)) {
        const q = part.trim().replace(/\s+/g, ' ');
        if (q) { out.push(q); total += q.length + 3; }
      }
    };
    const descend = (node, depth) => {
      for (const c of node.childNodes) {
        if (total > __ROW_CAP__ + 16) return; // already past the cap — no reason to keep measuring
        if (c.nodeType === 3) { push(c.nodeValue); continue; }
        if (c.nodeType !== 1 || SEG_SKIP.has(c.tagName)) continue;
        if (c.getClientRects && c.getClientRects().length === 0) continue;
        if (depth > 0 && c.children && c.children.length) { descend(c, depth - 1); continue; }
        push(c.innerText !== undefined ? c.innerText : c.textContent);
      }
    };
    descend(el, 3);
    return out;
  };
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const key = items[i].role + '\u0000' + items[i].name;
    const g = groups.get(key);
    if (g) g.push(i); else groups.set(key, [i]);
  }
  for (const idxs of groups.values()) {
    if (idxs.length < 2 && items[idxs[0]].name) continue;
    // A group of several has a stop built in (the ancestor that spans a sibling), so it takes
    // the WIDEST row that fits. A lone control has no stop and would widen out to its <form>
    // ("Email · Password · Nickname"), so it takes the NEAREST text instead.
    // Nameless controls of a role share one key (role + ''), so three empty textboxes are a
    // group of three and go WIDE; the narrow branch is one nameless control of its role.
    const wide = idxs.length > 1;
    const chains = idxs.map((i) => { const c = []; let n = hits[i];
      for (let up = 0; up < __ROW_UP__ && n.parentElement; up++) { n = n.parentElement; c.push(n); }
      return c; });
    const spread = new Map();
    for (const c of chains) for (const a of c) spread.set(a, (spread.get(a) || 0) + 1);
    for (let j = 0; j < idxs.length; j++) {
      const own = items[idxs[j]].name;
      let row = '';
      // The heading of an ancestor too wide to quote, kept for the prefix below.
      let head = '';
      // Same-named controls in ONE cell belong to the same record and must not stop each
      // other's walk, so it continues while the count does not GROW past the nearest
      // ancestor's. Ceiling: an ancestor holding the whole group is the list container.
      const base = spread.get(chains[j][0]) || 1;
      for (const a of chains[j]) {
        if (spread.get(a) > base || spread.get(a) >= idxs.length) break;
        // The control's own label is already on the line; repeating it wastes the budget.
        const t = segsOf(a).filter((x) => x !== own).join(' · ');
        if (!t) continue;
        // Prefer the widest ancestor that still fits. If even the narrowest overflows, cut it
        // once and stop.
        // A wider ancestor that overflows does not end the walk: a calendar's "20" otherwise
        // reports only its WEEK, while the month that separates them sits further up. Its FIRST
        // segment is the section's heading (document order puts a title before its items), so
        // remember that one segment and keep climbing until the spread ceiling stops the walk.
        if (t.length > __ROW_CAP__) {
          if (!row) { row = t.slice(0, __ROW_CAP__) + '…'; break; }
          const lead = t.split(' · ')[0] || '';
          if (lead && row.indexOf(lead) < 0) head = lead;
          continue;
        }
        row = t;
        if (!wide) break;
      }
      // After the loop: the "does it already say this" test must run against the row that ships.
      if (row && head && row.indexOf(head) < 0 && head.length + 3 + row.length <= __ROW_CAP__) {
        row = head + ' · ' + row;
      }
      if (row) items[idxs[j]].row = row;
      // The walk ran (this control needs context) and found nothing that separates it. Marked,
      // never silently dropped: a bare line means "the name is enough". A unique NAMED control
      // never enters this loop, which keeps "did not need a row" and "could not get one" apart.
      else items[idxs[j]].rowBlank = 1;
    }
  }
  // ── Labelled groups ───────────────────────────────────────────────────────
  // Which CARD a control belongs to, where the author wrote it down as an aria-label on the
  // container — routinely the only place some data exists (x.com's post button row carries the
  // bookmark count nowhere else).
  // aria-label ONLY: aria-labelledby points AT page text, so it only duplicates the read
  // (measured on x.com). NEAREST labelled ancestor only: they nest heavily, and the outer ones
  // would spend the budget. Walking UP is O(N·GROUP_UP), never O(G·N) contains() calls.
  const listed = new Set(hits);
  const byNode = new Map();
  for (let i = 0; i < hits.length; i++) {
    let node = hits[i].parentElement, up = 0;
    while (node && up < __GROUP_UP__) {
      // A listed ancestor's label is already its NAME; keep climbing past it.
      const label = !listed.has(node) && node.getAttribute ? (node.getAttribute('aria-label') || '').trim() : '';
      if (label) {
        const members = byNode.get(node);
        if (members) members.push(items[i].ref);
        else byNode.set(node, [items[i].ref]);
        break;
      }
      node = node.parentElement; up++;
    }
  }
  const labelGroups = [];
  for (const entry of byNode) {
    const label = (entry[0].getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    labelGroups.push({ label: label.slice(0, __GROUP_CAP__), members: entry[1] });
  }
  let top = '', topN = 0;
  for (const key in coverers) if (coverers[key] > topN) { topN = coverers[key]; top = key; }
  const de = document.documentElement;
  return { items, coveredItems, groups: labelGroups, headings: headingsOf(visible, modal), nextK: k, vw: window.innerWidth, vh: window.innerHeight,
           scrollY: window.scrollY, docH: de ? de.scrollHeight : 0,
           covered: coveredCount ? { count: coveredCount, top: top, topCount: topN,
             // Named only when EVERY covered control is behind it; else the overlay wording.
             ...(modal && behindModal === coveredCount ? { modal: (nameOf(modal) || 'dialog').slice(0, 40) } : {}) } : null };
}`.replace("__ROLES__", JSON.stringify(BROWSER_ROLES))
  .replace("__PAGE_REFS__", PAGE_REFS_JS)
  .replace("__NAME_OF__", NAME_JS)
  .replace("__CHECKABLE_TARGET__", CHECKABLE_TARGET_JS)
  .replace("__SCROLL_REGION__", SCROLL_REGION_JS)
  .replace("__COVERER_LABEL__", COVERER_LABEL_JS)
  .replace("__EDITOR_PROXY__", EDITOR_PROXY_JS)
  .replace("__HEADINGS__", HEADINGS_JS)
  .replace(/__ROW_CAP__/g, String(ROW_CAP))
  .replace(/__ROW_UP__/g, String(ROW_UP))
  .replace(/__GROUP_CAP__/g, String(GROUP_CAP))
  .replace(/__GROUP_UP__/g, String(GROUP_UP));
