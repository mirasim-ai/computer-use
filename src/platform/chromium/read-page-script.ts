/**
 * The page-side walk `read_page` runs: one function source, evaluated in the page, that turns a
 * subtree into the node shape this module renders.
 *
 * A source STRING sharing nothing with the TypeScript around it but its arguments and result
 * shape; what to keep and what to fold is commented where it happens.
 */

import { STATE_CLASS_JS } from "./collect.ts";
import { unreachedJs } from "./unreached.ts";
import { PAGE_REFS_JS } from "./page-refs.ts";

/** The unreached-node probe this walk embeds, rooted at the subtree it was given. */
const UNREACHED = unreachedJs("root");

export const TREE_JS = String.raw`(arg) => {
  const refs = (${PAGE_REFS_JS})();
  const rootSel = arg.node || arg.ref, depth = arg.depth, cap = arg.cap;
  // Resolve the root BEFORE clearing old drill handles — a drill read's own root IS one.
  const root = arg.node ? refs.nodes.get(arg.node)?.deref()
    : arg.ref ? refs.elements.get(arg.ref)?.deref() : document.body;
  if (!root?.isConnected) return { error: 'target not found on this page (it may have been re-rendered)' };
  refs.nodes.clear();
  const containsRef = new WeakSet();
  for (const entry of refs.elements.values()) {
    const el = entry.deref();
    if (el?.isConnected) for (let n = el; n; n = n.parentElement) containsRef.add(n);
  }

  const INLINE = new Set(['B','I','EM','STRONG','A','SPAN','CODE','SMALL','SUP','SUB','MARK','U','S','ABBR','TIME','BR','WBR','LABEL']);
  const MEDIA = { IMG: 'img', SVG: 'svg', VIDEO: 'video', AUDIO: 'audio', CANVAS: 'canvas', PICTURE: 'img' };
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','LINK','META']);
  const clean = (s) => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();
  const visible = (el) => { const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0; };
  const vw = window.innerWidth, vh = window.innerHeight;
  let nextNode = 0;

  const vpOf = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return 'out';
    const overlaps = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    if (!overlaps) return 'out';
    return (r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw) ? 'in' : 'part';
  };
  // Hit-test mirrors collect.ts: first viewport-intersecting rect's intersection center;
  // self/descendant hits pass, ANCESTOR hits pass too (scroll clipping — a click would
  // scrollIntoView), shadow-DOM roots are exempt (elementFromPoint retargets to the host).
  const coveredBy = (el) => {
    if (el.getRootNode() instanceof ShadowRoot) return false;
    let q = null;
    for (const r of el.getClientRects()) {
      if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width > 0 && r.height > 0) { q = r; break; }
    }
    if (!q) return false;
    const x = (Math.max(0, q.left) + Math.min(vw, q.right)) / 2;
    const y = (Math.max(0, q.top) + Math.min(vh, q.bottom)) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    return !(hit === el || el.contains(hit) || hit.contains(el));
  };

  const mediaName = (el) => {
    const alt = clean(el.getAttribute && (el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title')));
    if (alt) return alt;
    const src = el.getAttribute && (el.getAttribute('src') || el.getAttribute('href'));
    if (src) { const base = String(src).split('?')[0].split('/').pop(); if (base && base.length <= 60) return base; }
    const t = el.querySelector && el.querySelector('title');
    return clean(t && t.textContent) || '';
  };
  const stateOf = (el) => { // mirrors collect.ts stateOf, condensed for leaf controls
    const cut2 = (s) => { s = clean(s); return s.length > 60 ? s.slice(0, 60) + '…' : s; };
    const cls = typeof el.className === 'string' ? el.className : '';
    const inv = (el.getAttribute && el.getAttribute('aria-invalid') === 'true')
      || /(^|[\s_-])(error|invalid)([\s_-]|$)/i.test(cls);
    const cur = el.getAttribute && el.getAttribute('aria-current');
    const sel = !el.getAttribute ? '' :
      el.getAttribute('aria-selected') === 'true' ? 'selected' :
      el.getAttribute('aria-pressed') === 'true' ? 'pressed' :
      (cur && cur !== 'false') ? 'current' : '';
    // Class fallback (active|selected) mirrors collect.ts: stateless elements only.
    const selCls = (${STATE_CLASS_JS})(cls);
    const mark = (s) => [inv ? 'invalid' : '', sel || (!s ? selCls : ''), s].filter(Boolean).join(', ');
    const tag = el.tagName;
    if (el.isContentEditable) { const v = cut2(el.innerText); return mark(v ? 'filled:' + v : 'empty'); }
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return mark(el.checked ? 'checked' : 'unchecked');
    if (tag === 'SELECT') { const o = el.selectedOptions && el.selectedOptions[0];
      const t = cut2(o && (o.label || o.textContent)); return mark(t ? 'selected:' + t : 'unselected'); }
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const v = el.value == null ? '' : String(el.value);
      if (!v) return mark('empty');
      const ws = v !== v.trim() ? ' (value has edge whitespace — drill this ref for the exact value)' : '';
      return mark(el.type === 'password' ? 'filled:' + v.length + ' chars' : 'filled:' + cut2(v) + ws);
    }
    return mark('');
  };
  const runOf = (raw, node) => { // one text run, capped, page-clip detected
    let t = clean(raw);
    if (!t) return null;
    if (/^(…|\.\.\.)/.test(t)) node.clipped = true;
    if (t.length > cap) { t = t.slice(0, cap); node.cut = true; }
    node.text = t;
    return node;
  };
  // Prose: own text mixed ONLY with inline markup and no interactive descendants —
  // concatenate in DOM order. Anything else keeps children separate (prune, don't merge).
  const isProse = (el) => {
    let hasText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { if (clean(n.nodeValue)) hasText = true; }
      else if (n.nodeType === 1) {
        if (SKIP.has(n.tagName)) continue;
        if (!INLINE.has(n.tagName)) return false;
        if (containsRef.has(n)) return false;
      }
    }
    return hasText;
  };
  const hasContentBelow = (el) =>
    !!clean(el.textContent) || containsRef.has(el) || !!(el.querySelector && el.querySelector('img,svg,video,iframe'));

  const build = (el, level, parentVp) => {
    if (SKIP.has(el.tagName)) return null;
    if (!visible(el)) return null;
    const node = {};
    const vp = vpOf(el);
    if (vp !== parentVp) node.vp = vp;
    const ref = refs.byElement.get(el);
    const media = MEDIA[el.tagName];
    const tag = el.tagName;

    if (tag === 'IFRAME' || tag === 'FRAME') {
      node.tag = 'iframe'; node.name = 'embedded page — its content is not in this tree'; return node;
    }
    if (media) { node.tag = media; const n = mediaName(el); if (n) node.name = n; return Object.keys(node).length > 1 || node.tag ? node : null; }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      node.role = tag === 'SELECT' ? 'combobox' : 'textbox';
      if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) node.role = el.type;
      if (tag === 'INPUT' && (el.type === 'button' || el.type === 'submit')) node.role = 'button';
      if (ref) node.ref = ref;
      const nm = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value && ['button','submit','reset'].includes(el.type) && el.value || '');
      if (nm) node.name = nm;
      const st = stateOf(el); if (st) node.state = st;
      if (ref && vp !== 'out' && coveredBy(el)) node.covered = true;
      return node;
    }

    if (ref) {
      node.ref = ref;
      node.role = el.getAttribute('role') || ({ A: 'link', BUTTON: 'button' }[tag] || 'button');
      const st = stateOf(el); if (st) node.state = st;
      if (vp !== 'out' && coveredBy(el)) node.covered = true;
    }
    const label = clean(el.getAttribute && el.getAttribute('aria-label'));
    if (label && !node.name) node.name = label;

    const selfContentful = !!(node.ref || node.name);
    const myLevel = level + ((selfContentful || isProse(el)) ? 1 : 0);

    // Depth floor: this node still shows, its content folds behind a drill handle.
    if (depth > 0 && myLevel > depth) {
      if (!hasContentBelow(el) && !selfContentful) return null;
      const id = 'n' + (++nextNode);
      refs.nodes.set(id, new WeakRef(el));
      node.fold = { items: el.children.length, chars: clean(el.textContent).length, id };
      return node;
    }

    if (isProse(el)) return runOf(el.innerText, node) || (selfContentful ? node : null);

    // Ordered children: element kids interleaved with own text runs, DOM order kept.
    const kids = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { const r = runOf(n.nodeValue, {}); if (r) kids.push(r); }
      else if (n.nodeType === 1) {
        if (n.shadowRoot) { // pierce open shadow roots in place
          for (const sn of n.shadowRoot.children) { const b = build(sn, myLevel, vp); if (b) kids.push(b); }
        }
        const b = build(n, myLevel, vp);
        if (b) kids.push(b);
      }
    }
    // Collapse single-child wrappers; drop empty shells.
    if (!selfContentful && !node.vp) {
      if (kids.length === 1) return kids[0];
      if (kids.length === 0) return null;
    } else if (kids.length === 0 && !selfContentful) return null;
    if (kids.length) node.kids = kids;
    return (selfContentful || node.kids || node.text) ? node : null;
  };

  const tree = build(root, 0, vpOf(root)) || {};
  // Unscrolled content estimate: document remainder, or the subtree root's own remainder
  // when reading a subtree — "complete AS RENDERED" must not imply "complete".
  const remOf = (el) => Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
  const rem = rootSel ? remOf(root) : Math.max(remOf(document.documentElement), remOf(document.body));
  // Drilling into a text field is the model asking for ITS text — hand over the value
  // verbatim. Every summary channel trims and collapses whitespace, which reads fine
  // but silently corrupts copy-exactly workflows (a generated trailing space, a real
  // newline). Passwords keep their length-only masking.
  let exact;
  if (rootSel) {
    const tg = root.tagName;
    if ((tg === 'TEXTAREA' || tg === 'INPUT') && typeof root.value === 'string' && root.type !== 'password') exact = String(root.value);
    else if (root.isContentEditable) exact = String(root.innerText || '');
  }
  // Everything this read cannot reach, counted by the shared rule so the two text channels
  // never disagree about the same page (unreached.ts).
  const un = ${UNREACHED};
  return { tree, moreScreens: Math.round((rem / Math.max(1, vh)) * 10) / 10, exact, un };
}`;
