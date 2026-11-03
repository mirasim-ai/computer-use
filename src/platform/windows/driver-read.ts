/**
 * What the driver READS: the walk, and the channels built on it (observation, screenshot,
 * scoped screenshot, text, one element's value). Second slice of {@link WindowsDriver}'s chain,
 * after {@link WindowsDriverTargets}; nothing here acts.
 */

import type { ScopedShot, ShotScope, Snapshot } from "../types.ts";
import { SurfaceUnreadableError } from "../types.ts";
import { WindowsDriverTargets, type WindowRow } from "./driver-targets.ts";
import { buildElements, windowText, type UiaTree } from "./elements.ts";
import { UiaRequestError } from "./uia-client.ts";

/**
 * Windows editors expose CRLF or CR line breaks. Normalize their representation without
 * dropping a real trailing newline (Notepad's ValuePattern uses a trailing CR for that newline).
 */
export function fieldText(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

export abstract class WindowsDriverRead extends WindowsDriverTargets {
  private async walk(): Promise<{ row: WindowRow; tree: UiaTree }> {
    const row = await this.authorized();
    const tree = await this.call<UiaTree>("tree", { hwnd: row.hwnd, max: 3000 });
    this.frame = tree.frame;
    return { row, tree };
  }

  protected async snapshot(): Promise<Snapshot> {
    const { row, tree } = await this.walk();
    const { elements, offscreen, refs, capped } = buildElements(tree);
    this.refTargets = refs;
    if (row.minimized) this.pendingNote = `"${row.title}" is minimized — desktop actions restore it; background actions never do. Some apps (UWP/XAML) expose no usable controls while minimized`;
    else if (tree.dialogs?.length) {
      this.pendingNote = `a dialog is open over "${row.title}" (${tree.dialogs.map((t) => `"${t}"`).join(", ")}) — the window waits on it; its controls are listed last`;
    } else if (tree.popups) {
      this.pendingNote = `a menu or popup of "${row.title}" is open — its items are listed last; it closes on a pick, on escape or on a click elsewhere`;
    }
    const text = elements.filter((e) => e.role === "text").map((e) => e.name).join(" · ");
    return {
      url: `windows:${row.process}:${row.hwnd}`,
      title: tree.title || row.title,
      elements,
      offscreenElements: offscreen,
      text: text.slice(0, 2000),
      meta: {
        scrollY: 0, viewportH: tree.frame.h, docH: tree.frame.h,
        offscreen: offscreen.length, ...(capped ? { capped } : {}), ...(tree.partial ? { partial: tree.partial } : {}),
      },
    };
  }

  async screenshot(): Promise<Buffer> {
    const row = await this.authorized();
    try {
      const shot = await this.call<{ png: string; x: number; y: number; width: number; height: number }>("shot", { hwnd: row.hwnd });
      this.frame = { x: shot.x, y: shot.y, w: shot.width, h: shot.height };
      this.fullShotFrame = this.frame;
      return Buffer.from(shot.png, "base64");
    } catch (e) {
      if (e instanceof UiaRequestError && e.code === "minimized") throw new SurfaceUnreadableError(`"${row.title}" is minimized, so it has no pixels to capture until it is restored (activate)`);
      throw e;
    }
  }

  override async screenshotScoped(scope: ShotScope): Promise<ScopedShot> {
    if (scope.fullPage) throw new Error("fullPage screenshots are not supported on Windows; use ref or region for window detail");
    if (!!scope.ref === !!scope.region) throw new Error("pick exactly one of ref or region for a Windows scoped screenshot");
    if (scope.padding !== undefined && (!scope.ref || !Number.isFinite(scope.padding) || scope.padding < 0)) {
      throw new Error("padding needs a finite number of pixels, 0 or more, with ref");
    }
    if (scope.region && (![scope.region.x, scope.region.y, scope.region.width, scope.region.height].every(Number.isFinite)
      || !(scope.region.width > 0) || !(scope.region.height > 0))) {
      throw new Error("region needs finite x/y and positive width/height");
    }
    if (scope.region && !this.fullShotFrame) {
      throw new Error("region coordinates use the full screenshot; take w.screenshot() or w.observe({screenshot:true}) first");
    }
    const row = await this.authorized();
    const key = scope.ref ? this.target(scope.ref).key : undefined;
    let shot: {
      png: string; x: number; y: number; width: number; height: number;
      region: { x: number; y: number; width: number; height: number };
      pixelWidth: number; pixelHeight: number; trimmed: boolean; method: string;
    };
    try {
      shot = await this.call("shotscoped", { hwnd: row.hwnd,
        ...(key ? { key, padding: scope.padding ?? 0 } : { region: scope.region, frame: this.fullShotFrame }),
      });
    } catch (e) {
      if (e instanceof UiaRequestError && e.code === "minimized") throw new SurfaceUnreadableError(`"${row.title}" is minimized, so it has no pixels to capture until it is restored (activate)`);
      throw e;
    }
    // Crops never replace the full-window frame used by point actions. UIA and PNG both use
    // physical pixels at every Windows display scale; no logical-pixel conversion is needed.
    const full = this.fullShotFrame;
    const canMap = !!full && full.x === shot.x && full.y === shot.y && full.w === shot.width && full.h === shot.height;
    return {
      bytes: Buffer.from(shot.png, "base64"), mimeType: "image/png",
      note: `${scope.ref ? `element ${scope.ref}` : "region"}, ${shot.pixelWidth}×${shot.pixelHeight} pixels`
        + ` at (${shot.region.x},${shot.region.y}) in window ${row.hwnd}${shot.trimmed ? " — trimmed to the window" : ""}`
        + (full && !canMap ? " — window geometry changed since the full screenshot; take a new full screenshot before point actions" : ""),
      capture: {
        target: { pid: row.pid, windowId: row.hwnd },
        window: { x: shot.x, y: shot.y, width: shot.width, height: shot.height },
        region: shot.region, units: "window-pixels", pointsPerPixel: { x: 1, y: 1 },
        toFullScreenshot: canMap ? { origin: { x: shot.region.x, y: shot.region.y }, scale: { x: 1, y: 1 } } : null,
        captureBackend: shot.method,
      },
    };
  }

  async readText(): Promise<string> {
    return windowText((await this.walk()).tree);
  }

  override async readValue(ref: string): Promise<string> {
    return fieldText((await this.call<{ value: string }>("value", { key: this.target(ref).key })).value);
  }

  override valueMatches(actual: string, expected: string): boolean {
    return actual === expected.replace(/\r\n?/g, "\n");
  }
}
