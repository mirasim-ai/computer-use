/**
 * shot.ts — every way pixels leave a page: the shared JPEG dialect, the journal's
 * evidence shot, and scoped captures (element / region / full page). Split from
 * driver.ts along the same seam as locate.ts: pure page-level logic, no driver state.
 */

import type { Locator, Page } from "playwright-core";
import type { ScopedShot, ShotScope } from "../types.ts";

/** The one screenshot dialect — model context and journal evidence alike — so every
 * consumer sees the same bytes. JPEG q60: screenshots are the context/byte hog of a GUI
 * session, a real page's PNG is several times the size for no model-visible gain, and
 * every vision API takes JPEG natively. Quality 60 was chosen against real pages — text
 * stays readable to the model. `scale: "css"` pins the image to CSS pixels: the space
 * element rects and mouse coordinates live in — on a HiDPI display a device-scaled shot
 * would be 2× the size AND put the model's click coordinates off by that factor. */
export const JPEG_SHOT = { type: "jpeg", quality: 60, scale: "css" } as const;

const captures = new WeakMap<Page, Promise<unknown>>();

/** Chrome restores its capture-time emulation after taking a screenshot. A viewport
 * change in the meantime would be overwritten by that restore. The journal and tool
 * captures share this queue with browser actions (including navigation), while other
 * tabs remain independent. Each capture keeps its own bounded Playwright timeout. */
export async function withPageCapture<T>(page: Page, task: () => Promise<T>): Promise<T> {
  const previous = captures.get(page) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  captures.set(page, next);
  try { return await next; }
  finally { if (captures.get(page) === next) captures.delete(page); }
}

/** Evidence-shot budget: a page that cannot produce a frame in this window (crashed,
 * navigating forever) yields a line without `shot` rather than a stalled journal. */
const SHOT_TIMEOUT_MS = 4000;

/** A shot failure was already reported. Missing shots are silent by design (the journal
 * line just carries no `shot`), so the first failure must say so — once per process. */
let shotFailureReported = false;

/** The page AFTER the action, through the driver's own page handle — never a second CDP
 * connection. Null when it cannot be taken (page closed, browser gone, frame stuck): the
 * journal line then simply carries no `shot` field. Deliberately no ensure(): the
 * observer path must never relaunch a browser or otherwise mutate driver state. */
export async function captureEvidenceShot(getPage: () => Page): Promise<Buffer | null> {
  try {
    const page = getPage();
    return await withPageCapture(page, () => page.screenshot({ ...JPEG_SHOT, timeout: SHOT_TIMEOUT_MS }));
  } catch (err) {
    // Null stays the contract, but never silently: a build that takes no screenshots at all
    // must say so once.
    if (!shotFailureReported) {
      shotFailureReported = true;
      const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
      console.error(`mirasim-cu: screenshot failed, journal lines will carry no shot — ${why}`);
    }
    return null;
  }
}

const round = (n: number) => Math.round(n);

/**
 * Scoped capture on a page — exactly one scope. An element is cropped to its bounding
 * box (scrolled into view if needed — a look with a side effect, like every peer tool's
 * element shot); a region is clipped in viewport coordinates, the space a full screenshot
 * and mouse actions share; fullPage captures the whole scrollable document. Throws with
 * the reason when the scope cannot be satisfied — the observation layer turns that into
 * an honest tool error instead of a silently-wrong frame.
 */
export async function scopedShot(
  page: Page,
  scope: ShotScope,
  locate: (ref: string) => Promise<Locator | null>,
): Promise<ScopedShot> {
  if (scope.padding !== undefined && !scope.ref) throw new Error("padding widens an element shot — pass it with ref");
  if (scope.padding !== undefined && !(scope.padding >= 0)) throw new Error("padding needs a number of px, 0 or more");

  const picked = [scope.ref && "ref", scope.region && "region", scope.fullPage && "fullPage"].filter(Boolean);
  if (picked.length !== 1) {
    throw new Error(`pick exactly one of ref / region / fullPage (got ${picked.join(" + ") || "none"})`);
  }

  if (scope.ref) {
    const loc = await locate(scope.ref);
    if (!loc) throw new Error(`no element for ref ${scope.ref} on this page — re-observe and use a current ref`);
    // Padded: the element plus its surroundings (where it sits), clipped to the viewport.
    if (scope.padding) {
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 });
      const b = await loc.boundingBox();
      if (!b) throw new Error(`ref ${scope.ref} has no box on screen — it is not rendered`);
      const vw = await page.evaluate("window.innerWidth") as number;
      const vh = await page.evaluate("window.innerHeight") as number;
      const x = Math.max(0, b.x - scope.padding), y = Math.max(0, b.y - scope.padding);
      const width = Math.min(vw, b.x + b.width + scope.padding) - x;
      const height = Math.min(vh, b.y + b.height + scope.padding) - y;
      const bytes = await page.screenshot({ ...JPEG_SHOT, clip: { x, y, width, height }, timeout: 10_000 });
      return { bytes, mimeType: "image/jpeg",
        note: `element ${scope.ref} with ${round(scope.padding)}px around it, ${round(width)}×${round(height)} at (${round(x)},${round(y)})` };
    }
    const bytes = await loc.screenshot({ ...JPEG_SHOT, timeout: 10_000 });
    const box = await loc.boundingBox().catch(() => null);
    const at = box ? `${round(box.width)}×${round(box.height)} at (${round(box.x)},${round(box.y)})` : "size unknown";
    return { bytes, mimeType: "image/jpeg", note: `element ${scope.ref}, ${at}` };
  }

  const vp = await page.evaluate(
    "({ w: window.innerWidth, h: window.innerHeight, docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight })",
  ) as { w: number; h: number; docW: number; docH: number };

  if (scope.region) {
    const r = scope.region;
    if (!(r.width > 0) || !(r.height > 0)) throw new Error("region needs a positive width and height");
    // Clamp to the viewport: playwright rejects a clip that leaves the captured surface,
    // and "you reached past the edge" should trim with a note, not fail the whole look.
    const x = Math.max(0, Math.min(r.x, vp.w - 1));
    const y = Math.max(0, Math.min(r.y, vp.h - 1));
    const width = Math.max(1, Math.min(r.x + r.width, vp.w) - x);
    const height = Math.max(1, Math.min(r.y + r.height, vp.h) - y);
    const clamped = x !== r.x || y !== r.y || width !== r.width || height !== r.height;
    const bytes = await page.screenshot({ ...JPEG_SHOT, clip: { x, y, width, height }, timeout: 10_000 });
    return {
      bytes,
      mimeType: "image/jpeg",
      note: `region ${round(width)}×${round(height)} at (${round(x)},${round(y)}) of the ${vp.w}×${vp.h} viewport`
        + (clamped ? " — trimmed to the viewport" : ""),
    };
  }

  const bytes = await page.screenshot({ ...JPEG_SHOT, fullPage: true, timeout: 12_000 });
  const tall = vp.docH > vp.h * 3;
  return {
    bytes,
    mimeType: "image/jpeg",
    note: `full page ${vp.docW}×${vp.docH}, viewport ${vp.w}×${vp.h}`
      + (tall ? " — very tall: vision APIs downscale long images, so read text via what:'text'/'page' and shoot regions for detail" : ""),
  };
}
