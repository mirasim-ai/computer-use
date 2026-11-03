/**
 * Extension-mode overlay guard: detect a FOREIGN overlay — another extension's autofill popup,
 * a password manager's panel, a high z-index floater — that has stolen the viewport or the focus
 * of the tab the agent is about to act on, and refuse the action with a note instead of letting
 * the click/keystroke land silently on the interloper.
 *
 * Only meaningful in EXTENSION mode, where the browser is the user's own and other extensions
 * (iCloud Passwords, 1Password, LastPass, …) may pop a layer over the page with no signal the
 * agent can read through observation. A managed browser runs no other extensions, so the same
 * check there would only ever fire on the page's own dialogs — which the agent already handles.
 *
 * The probe runs in the page, over its DOM: extension content scripts inject into the page
 * document, so their overlays ARE reachable from `document.elementFromPoint`. It checks two
 * signals, both conservative to keep false positives off the page's own legitimate layers:
 *
 *  - FOCUS LOSS: `document.hasFocus()` is false — a native panel or another window holds it.
 *  - EXTREME z-index fixed overlay at the viewport center: the tier extensions and autofill
 *    popups actually use (the 2147483647 region), well above any site's own stacking.
 */

import type { Page } from "playwright-core";

/** The verbs that target a point or ref on the page and can be swallowed by an overlay. */
const OVERLAY_SENSITIVE_KINDS = new Set([
  "click", "set_text", "keys", "scroll", "hover", "focus", "wait",
  "paste", "select_option", "select_text", "drag", "upload", "dialog",
]);

/** Whether a verb kind can be intercepted by a foreign overlay (read verbs and pure navigation
 *  cannot). Cheap, synchronous, no I/O — the gate the hot path checks first. */
export function overlaySensitive(kind: string): boolean {
  return OVERLAY_SENSITIVE_KINDS.has(kind);
}

/** The page-side probe. Returns a short human-readable description of the interferer, or null. */
const PROBE_JS = `(() => {
  // Focus lost to a native panel or another window — the keystroke would go there, not the page.
  if (!document.hasFocus()) return "document focus was lost (a native panel or another window holds it)";

  // Walk up from the viewport center: a foreign autofill/password overlay sits at an extreme
  // z-index that the page's own layers almost never reach.
  const cx = Math.max(1, Math.floor(window.innerWidth / 2));
  const cy = Math.max(1, Math.floor(window.innerHeight / 2));
  let el = document.elementFromPoint(cx, cy);
  for (let i = 0; i < 8 && el; i++) {
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" && cs.pointerEvents !== "none" && cs.visibility !== "hidden" && cs.display !== "none") {
      const z = cs.zIndex === "auto" ? 0 : parseInt(cs.zIndex, 10);
      // 2147483640+ is the region extensions and autofill popups reserve; sites rarely go there.
      if (z >= 2147483640) {
        const rect = el.getBoundingClientRect();
        const cover = (rect.width * rect.height) / (window.innerWidth * window.innerHeight);
        if (cover > 0.1) {
          const label = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("id") || el.getAttribute("class")) || el.tagName.toLowerCase();
          return "a fixed overlay (\\"" + String(label).slice(0, 40) + "\\") at z=" + z + " covers " + Math.round(cover * 100) + "% of the viewport over the center";
        }
      }
    }
    el = el.parentElement;
  }
  return null;
})()`;

/**
 * Run the probe on a page. Returns a description of the interferer, or null when the tab is clear.
 *
 * Best-effort and bounded: an unreadable page (cross-origin frame, torn renderer) answers null,
 * never an error — the real dispatch is the arbiter, same as `refuseIfGated`.
 */
export async function detectInterference(page: Page): Promise<string | null> {
  try {
    const result = await Promise.race([
      page.evaluate(PROBE_JS) as Promise<string | null>,
      new Promise<string | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 1500);
        t.unref?.();
      }),
    ]);
    return typeof result === "string" && result ? result : null;
  } catch {
    return null;
  }
}
