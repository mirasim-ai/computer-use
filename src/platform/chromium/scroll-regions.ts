/** Shared page-side facts for naming scroll regions in observations and choosing one to scroll. */
export const SCROLL_REGION_JS = String.raw`(el) => {
  if (el === document.body || el === document.documentElement) return null;
  const s = getComputedStyle(el), r = el.getBoundingClientRect();
  if (s.visibility === 'hidden' || s.display === 'none' || r.width < 80 || r.height < 80) return null;
  const vertical = /auto|scroll|overlay/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4;
  const horizontal = /auto|scroll|overlay/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 4;
  if (!vertical && !horizontal) return null;
  const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
  const name = (el.getAttribute('aria-label') || labelled || el.id || 'Scrollable area').trim().replace(/\s+/g, ' ').slice(0, 80);
  return { name, vertical, horizontal };
}`;
