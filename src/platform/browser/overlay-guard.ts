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

import type { ElementHandle, Frame, Locator, Page } from "playwright-core";
import { pageFn } from "../chromium/collect.ts";

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

/**
 * The page-side probe. Returns a short human-readable description of the interferer, or null.
 *
 * `target` is the element the verb names, when it names one in this document (for one inside a
 * frame, that frame's element here). A layer that HOLDS the target is not in its way: it is what
 * the verb is acting on. A site's own consent dialog sits at this z-index as often as an
 * extension's panel does, and refused like one it could not be answered at all — the refusal said
 * to close it first, which is what the refused click was for. A verb that names a point is aimed at
 * what is under that point; one that goes to the caret (keys, text with no ref) at the element
 * holding the focus.
 */
const PROBE_JS = String.raw`({ target, point, caret }) => {
  // Focus lost to a native panel or another window — the keystroke would go there, not the page.
  if (!document.hasFocus()) return "document focus was lost (a native panel or another window holds it)";

  const aim = target || (point ? document.elementFromPoint(point.x, point.y) : null)
    || (caret && document.activeElement !== document.body ? document.activeElement : null);
  // Up through shadow roots too: contains() stops at them.
  const holds = (layer) => { for (let n = aim; n; n = n.parentNode || n.host) if (n === layer) return true; return false; };

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
        if (cover > 0.1 && !holds(el)) {
          const label = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("id") || el.getAttribute("class")) || el.tagName.toLowerCase();
          return "a fixed overlay (\"" + String(label).slice(0, 40) + "\") at z=" + z + " covers " + Math.round(cover * 100) + "% of the viewport over the center";
        }
      }
    }
    el = el.parentElement;
  }
  return null;
}`;

/**
 * Run the probe on a page. Returns a description of the interferer, or null when the tab is clear
 * or what is over it holds what the verb is aimed at (see the probe).
 *
 * Best-effort and bounded: an unreadable page (cross-origin frame, torn renderer) answers null,
 * never an error — the real dispatch is the arbiter, same as `refuseIfGated`.
 */
export async function detectInterference(page: Page, aim: { target?: Locator | null; point?: { x: number; y: number }; caret?: boolean } = {}): Promise<string | null> {
  const { target, point, caret } = aim;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        const inTop = target ? await topDocumentElement(page, target).catch(() => null) : null;
        try { return await page.mainFrame().evaluate(pageFn(PROBE_JS) as any, { target: inTop, point: point ?? null, caret: caret === true }) as string | null; }
        finally { await inTop?.dispose().catch(() => {}); }
      })(),
      new Promise<string | null>((resolve) => { timer = setTimeout(() => resolve(null), 1500); timer.unref?.(); }),
    ]);
    return typeof result === "string" && result ? result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The element of the page's TOP document that stands for `target`: itself there, and for an
 *  element inside a frame the outermost frame element that holds it. */
async function topDocumentElement(page: Page, target: Locator): Promise<ElementHandle | null> {
  const handle = await target.elementHandle({ timeout: 1000 });
  if (!handle) return null;
  let frame: Frame | null = await handle.ownerFrame();
  if (!frame || frame === page.mainFrame()) return handle;
  await handle.dispose().catch(() => {});
  while (frame.parentFrame() && frame.parentFrame() !== page.mainFrame()) frame = frame.parentFrame()!;
  return frame.parentFrame() ? await frame.frameElement() : null;
}
