/**
 * Finding the element a verb names, and running the verb on it — the ACT half of the shared
 * Chromium page layer.
 *
 * The chain is `ChromiumPageBase` (the page's own state and its hooks) → this →
 * `ChromiumPageDriver` (the reads). This sits in the middle because the READS call
 * {@link ChromiumPageActs.locate} too: a settle wait must resolve a name exactly as a click does.
 */

import { type Locator } from "playwright-core";
import type { ActResult } from "../types.ts";
import { locateOnPage } from "./locate.ts";
import { clickNamingCover, performDrag, refuseIfGated } from "./actions.ts";
import { performScroll, performScrollInto } from "./scroll.ts";
import { performPaste, performSelectOption, setTextWithFallbacks } from "./actions-value.ts";
import { performSelectText } from "./select-text.ts";
import { ChromiumPageBase, normalizeChord } from "./page-base.ts";
import { CHECKABLE_TARGET_JS } from "./checkable-target.ts";
import { pageFn } from "./collect.ts";

/** Why a ref from before a reload misses — every ref of that document went with it. */
const DOCUMENT_REPLACED = "the page was reloaded or navigated since the last observation, so every ref from before is gone; "
  + "re-observe (w.observe()) and use a current one";

export abstract class ChromiumPageActs extends ChromiumPageBase {
  // ── Locate: by ref with identity check, then by name (battle-tested fallback chain) ──

  protected async locate(ref: string | undefined, name: string | undefined, fill: boolean): Promise<Locator | null> {
    const found = await locateOnPage(this.page(), ref, name, fill);
    // Capture the action point BEFORE the action: a click that navigates destroys the element,
    // and a post-action boundingBox answers null.
    if (found) {
      const box = await found.boundingBox().catch(() => null);
      this.lastPoint = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
    }
    return found;
  }

  /** The locate-miss answer. A platform that can explain the miss better overrides
   *  {@link blankSurfaceHint} rather than this. */
  protected async missing(ref?: string, name?: string): Promise<ActResult> {
    const hint = await this.blankSurfaceHint();
    if (hint) return { ok: false, note: hint };
    const miss = `no element for ref ${ref ?? "(none)"}${name ? ` / "${name}"` : ""}`;
    return { ok: false, note: ref && await this.documentReplaced() ? `${miss} — ${DOCUMENT_REPLACED}` : miss };
  }

  /** Has the page's document been replaced since the last observation? The page-side ref counter
   *  dies with the old DOM (see `snapshotOnce`), so a counter below the session's high-water mark
   *  is an un-observed reload or navigation. Its refs still pass the known-ref gate, so the miss
   *  must say a whole page of refs is gone, not just this one. */
  private async documentReplaced(): Promise<boolean> {
    if (!this.refHighWater) return false;
    try {
      return (Number(await this.page().mainFrame().evaluate("Number(window.__mfNextK) || 0")) || 0) < this.refHighWater;
    } catch { return false; }
  }

  /**
   * The seven UNIVERSAL verbs, over a page and nothing else. `undefined` means "not mine" —
   * a platform slice handles its additive verbs first (or after) and owns the unknown-kind
   * answer, because what is additive differs per platform.
   */
  protected async dispatchPage(kind: string, a: Record<string, any>): Promise<ActResult | undefined> {
    this.hookDiagnostics();
    const page = this.page();
    const hasPoint = typeof a.x === "number" && typeof a.y === "number";
    switch (kind) {
      case "click": {
        if (hasPoint) { await page.mouse.click(a.x, a.y, { button: a.button ?? "left", clickCount: a.count ?? 1 }); return { ok: true }; }
        const loc = await this.locate(a.ref, a.name, false);
        if (!loc) return await this.missing(a.ref, a.name);
        // Before the 8 s actionability wait, not after it (actions.ts explains the trade).
        const gated = await refuseIfGated(loc, a.ref, a.name);
        if (gated) return gated;
        const visual = await loc.evaluateHandle(pageFn(CHECKABLE_TARGET_JS) as any);
        try {
          const target = visual.asElement() ?? loc;
          const box = await target.boundingBox();
          if (box) this.lastPoint = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          // A cover is named after 2 s, not after the whole 8 s wait (actions.ts).
          return await clickNamingCover(target, loc, { button: a.button ?? "left", clickCount: a.count ?? 1 }, a.ref, a.name);
        } finally {
          await visual.dispose();
        }
      }
      case "hover": {
        if (hasPoint) { await page.mouse.move(a.x, a.y); return { ok: true }; }
        const loc = await this.locate(a.ref, a.name, false);
        if (!loc) return await this.missing(a.ref, a.name);
        await loc.hover({ timeout: 8000 });
        // Hover-revealed menus render async: without this beat the auto-observation
        // fires before they exist and the model concludes "nothing appeared".
        await page.waitForTimeout(400);
        return { ok: true, note: "hovering — anything revealed shows in the next observation and disappears when the pointer moves; to click a revealed item, do it next" };
      }
      case "set_text": {
        if (!a.ref) { await page.keyboard.type(a.text); return { ok: true }; }
        const loc = await this.locate(a.ref, a.name, true);
        if (!loc) {
          const blank = await this.blankSurfaceHint();
          return { ok: false, note: blank || `no input for ref ${a.ref}` };
        }
        // A :disabled field would pay the ladder's actionability wait TWICE before typing into
        // nothing. readonly is not disabled, so the ladder's own cases are untouched.
        const gatedField = await refuseIfGated(loc, a.ref, a.name);
        if (gatedField) return gatedField;
        // `verified` rides to the tool layer: a VERIFIED write is not told "it likely had no
        // effect" on a frozen screen, and one rejected read-back blocks a queued submit.
        return await setTextWithFallbacks(page, loc, a, () => this.locate(a.ref, a.name, true));
      }
      case "keys": {
        const n = Math.min(Math.max(Math.trunc(Number(a.count)) || 1, 1), 20);
        for (let i = 0; i < n; i++) await page.keyboard.press(normalizeChord(a.chord));
        return { ok: true };
      }
      case "drag": {
        // Compound gesture (actions.ts); the release point becomes the action point.
        const out = await performDrag(page, a, (ref, name) => this.locate(ref, name, false));
        if (out.point) this.lastPoint = out.point;
        return out.res;
      }
      case "select_option":
        // Ref-grounded, page-level: whichever platform registers the verb dispatches here.
        return await performSelectOption(page, a, () => this.locate(a.ref, a.name, true));
      case "select_text":
        // The ref is optional here — without one the search covers the page (actions.ts).
        return await performSelectText(page, a, () => this.locate(a.ref, a.name, false));
      case "paste":
        // Also ref-optional: with none it lands at the caret, which is where select_text left it.
        return await performPaste(page, a, () => this.locate(a.ref, a.name, true));
      case "scroll": {
        // Container-aware, displacement-verified (scroll.ts); point and displacement feed the
        // journal and the frozen-verdict wording.
        const out = typeof a.into === "string"
          ? await performScrollInto(page, a.into)
          : await performScroll(page, a, this.scrollLedger, this.contentRead);
        this.lastPoint = out.point;
        this.lastScrollMoved = out.moved;
        return out.res;
      }
      default:
        return undefined;
    }
  }
}
