/**
 * The page's headings with their boxes — data for a script, never a rendered line.
 *
 * A layout question ("did this toggle move?") needs a reference point that does not move, and a
 * control list offers none: a click can scroll a whole card. Its heading is that reference.
 *
 * Kept out of the element list: a heading is nothing to act on, and listing them would add many
 * lines to every observation for a field only layout scripts read.
 *
 * Same visibility rules and modal scope as the walk.
 */
const HEADINGS_CAP = 60;

export const HEADINGS_JS = String.raw`(visible, modal) => {
  const out = [];
  for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
    if (out.length >= __HEADINGS_CAP__) break;
    if (modal && !modal.contains(h)) continue;
    if (!visible(h) || h.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
    const r = h.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const name = (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) continue;
    const level = Number(h.getAttribute('aria-level')) || Number(h.tagName.slice(1)) || 0;
    out.push({ name, level, top: r.top, left: r.left, width: r.width, height: r.height });
  }
  return out;
}`.replace("__HEADINGS_CAP__", String(HEADINGS_CAP));
