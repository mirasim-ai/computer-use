/**
 * Browser a11y collection: browser-DOM specifics that belong ONLY to the Chromium drivers —
 * never promote anything here into the platform-neutral layer.
 *
 * Each constant is a JS function source string, evaluated on a single frame; placeholders are
 * substituted below, so the exported strings are ready to evaluate. Cross-frame aggregation and
 * coordinate translation happen in TypeScript.
 *
 * The key invariant: the *display* name may include inferred icon hints, but the *identity* name
 * (used to verify a ref hasn't moved) must be only text that literally exists on the page. Never
 * let an inferred name veto a click.
 */

import { CHECKABLE_TARGET_JS } from "./checkable-target.ts";

export const BROWSER_ROLES = [
  "link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "option",
  "slider", "spinbutton",
  // `file` is ours, not an ARIA role: a file input reported as a textbox invites set_text,
  // which silently does nothing; it needs the upload verb.
  "file",
  // A resize handle (drag only); its col-resize cursor escapes the cursor:pointer fallback.
  // Named separators only (see the walk): decorative dividers carry this role too.
  "separator",
];

/** Per-viewport element cap. Dense pages hit ~130 real controls; leave headroom. */
export const MAX_REFS = 320;

/** Per-element row-context cap (chars) and how far up the walk looks for the row. */
export const ROW_CAP = 72;
export const ROW_UP = 8;
/** Per-group label cap (chars) and how far up a listed control looks for its labelled group. */
export const GROUP_CAP = 200;
export const GROUP_UP = 12;

/**
 * Total row-context budget for one observation (chars), applied by the driver AFTER the y-sort
 * and the ref cap — the only point where the listed rows are known. Past it the annotation is
 * dropped and COUNTED (`meta.rowsCut`), never silently: a missing ⟨row⟩ must not read as "this
 * control is unambiguous". (A row the walk could not find is marked `rowBlank` instead.)
 */
export const ROW_CONTEXT_BUDGET = 6000;

/**
 * The state-class fallback, shared verbatim by `VIEWPORT_JS` and the page read's `TREE_JS`,
 * because the two must agree.
 *
 * It answers `active` / `selected` for a page that marks its current item with a class instead
 * of ARIA, and NOTHING for styling that merely contains the word. Token by token, skipping a
 * variant prefix (`hover:`, `group-*:` — a conditional style is never the current state) and an
 * arbitrary value in brackets (CSS, not class names): scanning the whole className as one string
 * hits `--th-selected-bg` inside `hover:bg-[var(--th-selected-bg)]`.
 */
export const STATE_CLASS_JS = String.raw`(cls) => {
  for (const token of String(cls || '').split(/\s+/)) {
    if (!token || token.indexOf(':') >= 0 || token.indexOf('[') >= 0) continue;
    const m = token.match(/(^|[_-])(active|selected)([_-]|$)/i);
    if (m) return m[2].toLowerCase();
  }
  return '';
}`;

/**
 * Identity-caliber name (narrow): only genuinely visible text / accessible name, used to verify a
 * ref still points at the element the model named. An input's *value* is never its name: a filter
 * box holding "Alice" would otherwise share a name with the "Alice" being clicked. The value is
 * surfaced as state (filled:...).
 */
const TEXT_NAME_JS = String.raw`(el) => {
  const clean = (s) => (typeof s === 'string' ? s : '').trim().replace(/\s+/g, ' ').slice(0, 80);
  // Only submit/button/reset expose their value as a visible label; every other input's
  // value is user content and must not become the name (this also keeps passwords out).
  const LABEL_VALUE = new Set(['submit', 'button', 'reset']);
  const tg = (el.tagName || '').toUpperCase();
  const vraw = (tg === 'INPUT' && LABEL_VALUE.has(el.type)) ? el.value : '';
  // contenteditable innerText is freshly-typed content: excluded, placeholder is the fallback.
  // SVG elements have no innerText (it lives on HTMLElement), so textContent is the fallback.
  // A <select>'s subtree is its OPTIONS, never a name: combobox is not name-from-content, so
  // accname takes the <label> (and getByRole({ name }) must agree, see below).
  const own = (el.isContentEditable || tg === 'SELECT') ? '' : (el.innerText !== undefined ? el.innerText : el.textContent);
  // A form control's name usually lives OUTSIDE it (<label for>, aria-labelledby); both are
  // text on the page, so identity-caliber. Ids resolve in the element's OWN root (a shadow root
  // has getElementById too); el.labels covers every LABELABLE element, <button> included.
  //
  // The chain's order is the accessible-name computation: aria-labelledby, aria-label, own
  // content; forTxt only fills a name that was going to be empty. So aria-labelledby OVERRIDES
  // visible text, deliberately: on a stale ref locate.ts falls back to Playwright's
  // getByRole({ name }), which computes the SAME accname.
  //
  // Labels are read with innerText: this name promises VISIBLE text (accname skips hidden nodes
  // too), and textContent would pull in a display:none hint span.
  const root = (el.getRootNode && el.getRootNode()) || document;
  const byId = (id) => { try { return (root.getElementById ? root : document).getElementById(id); } catch (e) { return null; } };
  const txtOf = (n) => !n ? '' : ((n.innerText !== undefined ? n.innerText : n.textContent) || '');
  const lb = (el.getAttribute('aria-labelledby') || '').trim();
  const lbTxt = !lb ? '' : lb.split(/\s+/).map((id) => txtOf(byId(id))).join(' ');
  // A WRAPPING <label> contains the control, whose own text (a select's options) must be left
  // out, as accname does; a <label for=> beside the control takes the plain read.
  const labelTxt = (lab) => {
    if (!lab) return '';
    if (!(lab.contains && lab.contains(el))) return txtOf(lab);
    let out = '';
    for (const n of lab.childNodes) {
      if (n === el || (n.contains && n.contains(el))) continue;
      out += ' ' + txtOf(n);
    }
    return out;
  };
  const forTxt = (el.labels && el.labels.length) ? labelTxt(el.labels[0]) : '';
  for (const c of [lbTxt, el.getAttribute('aria-label'), own, forTxt, vraw, el.title,
                   el.getAttribute('alt'), el.getAttribute('placeholder'),
                   el.getAttribute('data-placeholder'), el.getAttribute('aria-placeholder')]) {
    const t = clean(c);
    if (t) return t;
  }
  // A CSS checkbox may overlay an unassociated sibling label. Use that visible text only
  // when the shared hit-target check proves the relationship (never any nearby text).
  if ((__CHECKABLE_TARGET__)(el)) {
    const label = el.nextElementSibling;
    if (label && label.tagName === 'LABEL' && !label.control) return clean(txtOf(label));
  }
  return '';
}`.replace("__CHECKABLE_TARGET__", CHECKABLE_TARGET_JS);

/**
 * Display-caliber name (wide): narrow name, plus icon hints (svg <title>, <use href="#icon-x">,
 * a close/dismiss class of its own, class fragments containing "icon") for icon-only buttons with
 * neither aria-label nor text. These are INFERRED and must never be used for the identity check.
 *
 * The close class is what makes an overlay's own way out listable: an ad strip's close control is
 * a div holding one svg, and without a name the walk's pointer fallback drops it, so the cover
 * note could only point at a screenshot. A WHOLE word of the element's own class only, split on
 * - _ and camelCase: "close--rounded", "btn-close", "CloseButton" count; "is-closed" and
 * "disclosure" do not.
 */
export const NAME_JS = String.raw`(el) => {
  const clean = (s) => (typeof s === 'string' ? s : '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const text = (__TEXT_NAME__)(el);
  if (text) return text;
  if (!el.querySelector) return '';
  const svgEl = (el.tagName || '').toLowerCase() === 'svg' ? el : el.querySelector('svg');
  const t0 = svgEl && svgEl.querySelector('title');
  const st = clean(t0 && t0.textContent);
  if (st) return st;
  const iconish = (s) => clean(String(s == null ? '' : s).replace(/^#/, '')
    .replace(/^(icon|ico|svg|sprite)[-_]/i, '').replace(/[-_]+/g, ' '));
  const use = el.querySelector('use');
  const href = use && (use.getAttribute('href') || use.getAttribute('xlink:href'));
  if (href) { const t = iconish(String(href).split('#').pop()); if (t) return t; }
  const clsOf = (e) => (e && e.getAttribute) ? (e.getAttribute('class') || '') : '';
  const words = clsOf(el).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/);
  if (words.some((w) => w === 'close' || w === 'closebtn' || w === 'dismiss')) return 'close';
  const cls = clsOf(el) + ' ' + clsOf(el.querySelector('i,[class*=icon]'));
  const cands = cls.match(/[\w-]*icon[\w-]*/gi) || [];
  const best = cands.sort((x, y) => y.length - x.length)[0];
  if (best) { const t = iconish(best); if (t) return t; }
  return '';
}`.replace("__TEXT_NAME__", TEXT_NAME_JS);

/** Identity-caliber name, standalone — used by the locator to verify a ref hasn't moved. */
export const ELEM_NAME_JS = TEXT_NAME_JS;

/**
 * Wrap a JS function-source string into a real function so Node Playwright can inject it: the
 * Node API treats a string as an *expression* and ignores arguments (`evaluate(src, arg)` returns
 * the function object). Playwright serializes via toString(), so `new Function` round-trips.
 */
export function pageFn(src: string): (arg?: unknown) => unknown {
  return new Function("__arg", `return (${src})(__arg);`) as (arg?: unknown) => unknown;
}
