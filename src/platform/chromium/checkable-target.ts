/**
 * CSS checkboxes/radios keep their state in an input and draw elsewhere. Shared by observation
 * and click: the input keeps its ref and checked state; only its visible hit area is substituted.
 * No forced clicks, guessed container handlers, or programmatic changes to checked.
 */
export const CHECKABLE_TARGET_JS = String.raw`(el) => {
  if (!el || el.tagName !== 'INPUT' || !['checkbox', 'radio'].includes(el.type)) return null;
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return null;
  const visible = (node) => {
    if (node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = node.getBoundingClientRect(), s = getComputedStyle(node);
    if (r.width <= 1 || r.height <= 1 || s.display === 'none' || s.visibility !== 'visible') return false;
    for (let n = node; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) === 0) return false;
    return true;
  };
  const style = getComputedStyle(el), box = el.getBoundingClientRect();
  if (visible(el) && style.clipPath === 'none' && style.clip === 'auto') return null;
  const labels = Array.from(el.labels || []).filter(visible);
  if (labels.length) {
    // An invisible input over its label is still the real hit target (TodoMVC and many toggles).
    // A clipped/tiny/display:none input instead needs its associated label's native activation.
    const label = labels[0], r = label.getBoundingClientRect();
    const overlaps = box.width > 1 && box.height > 1 && box.left < r.right && box.right > r.left
      && box.top < r.bottom && box.bottom > r.top;
    if (overlaps && style.display !== 'none' && style.visibility === 'visible'
        && style.clipPath === 'none' && style.clip === 'auto') return el;
    return label;
  }
  // Some pages draw the checkbox in a sibling label without for=. It cannot activate the input
  // itself, so accept this shape ONLY when the actual input overlays that visible label.
  const label = el.nextElementSibling;
  if (!label || label.tagName !== 'LABEL' || label.control || !visible(label)) return null;
  if (style.display === 'none' || style.visibility !== 'visible' || style.clipPath !== 'none'
      || style.clip !== 'auto' || box.width <= 1 || box.height <= 1) return null;
  const r = label.getBoundingClientRect();
  return box.left < r.right && box.right > r.left && box.top < r.bottom && box.bottom > r.top ? el : null;
}`;
