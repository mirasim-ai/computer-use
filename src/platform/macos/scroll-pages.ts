/** Pages one `scroll` may turn through the accessibility rung, mirroring `MAX_SCROLL_PAGES` in
 *  ax-scroll.swift. `to:'top'|'bottom'` asks for all of them and the helper stops as soon as a
 *  page moves nothing — which is what makes a real jump possible where macOS offers no seek. */
export const MAX_SCROLL_PAGES = 60;
