/**
 * Where something that is not a control sits on the page — the anchor `find(…, {near})` measures
 * against when the name it was given is a card's title or a row's text.
 *
 * Two things carry such a name. A labelled container (`aria-label`, `title`) is what the author
 * called that part of the page, and an exact label wins. Otherwise the smallest visible element
 * showing the text: the walk goes down while a child still carries it, so "QA entry 85" answers
 * its own row, not the list around it. Text split across children (`<b>QA</b> entry 85`) answers
 * the element that holds all of it. The whole body is never an anchor: everything is near it.
 *
 * `want` arrives trimmed, lower-cased and with whitespace collapsed; the box is frame-relative.
 */
export const ANCHOR_BOX_JS = String.raw`(want) => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const box = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  let loose = null;
  for (const el of document.querySelectorAll('[aria-label], [title]')) {
    const label = norm(el.getAttribute('aria-label') || el.getAttribute('title'));
    if (!label.includes(want)) continue;
    const b = box(el);
    if (!b) continue;
    if (label === want) return b;
    loose = loose || b;
  }
  const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  const smallest = (el) => {
    let carried = false;
    for (const c of el.children) {
      if (skip.test(c.tagName) || !norm(c.textContent).includes(want)) continue;
      carried = true;
      const found = smallest(c);
      if (found) return found;
    }
    // A child carried it and none of them shows it: the text is there and hidden.
    return carried ? null : box(el);
  };
  const body = document.body;
  if (body && norm(body.textContent).includes(want)) {
    for (const c of body.children) {
      if (skip.test(c.tagName) || !norm(c.textContent).includes(want)) continue;
      const found = smallest(c);
      if (found) return found;
    }
  }
  return loose;
}`;
