/**
 * The browser window's posture (acquire.ts HAS the browser): park it, put it back, and the
 * user's "I am looking at it" flag that overrides both.
 *
 * Everything here is PRESENTATION: a window we could not move is still a window we can drive,
 * so every function is best-effort and none may fail an acquire or an action.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { browserConfigFromEnv, type BrowserConfig } from "./config.ts";
import { computerUseHome } from "../home.ts";

/** The parking spot: far enough left that no single-display desktop reaches it. macOS clamps it
 *  to the desktop UNION, so on a multi-display setup it lands on a real screen — which is why
 *  parking is not the default posture (see the launch flags in acquire.ts). */
export const OFFSCREEN_POSITION = "-4000,200";
/** Where a window PARKED by an older version is put back, once. Not a placement policy: after
 *  this correction the window is Chrome's to place. */
const UNPARK_POSITION = { left: 80, top: 80 };
/** A remembered position this far left is not a position a user chose — it is a parking spot. */
const PARKED_LEFT_MAX = -1000;

/** True while the user has asked to see the browser (see {@link revealFlagFor}). */
export function userWantsVisible(profileDir: string): boolean {
  return existsSync(revealFlagFor(profileDir));
}

/**
 * The user's "I want to look at it" flag, as a FILE beside the endpoint.
 *
 * The browser never takes the screen or keyboard on its own; only the user clicking the preview
 * panel — in the host's UI, a different process — overrides that. The host creates the file on
 * reveal and removes it on park; this process only reads it. While it exists the window is the
 * user's: we do not move it, and a tab switch may raise it.
 */
export function revealFlagFor(profileDir: string): string {
  // Keyed by the profile DIR, never by COMPUTER_USE_RUN_SLUG: reveal is a property of the WINDOW,
  // and every named-tab surface shares the one window — they must all read the same flag.
  const slug = basename(profileDir).replace(/[^\w.-]+/g, "-") || "default";
  return join(computerUseHome(), "run", slug, "revealed");
}


/**
 * Park a freshly-launched window off-screen, over CDP. The `--window-position` launch flag is
 * not enough: macOS clamps a NEW window onto the screen. Moving an EXISTING window works, bar a
 * ~40px sliver macOS keeps on-screen — acceptable, since the window keeps compositing.
 */
export async function parkWindowOffscreen(browser: Browser): Promise<void> {
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const session = await ctx.newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", { windowId, bounds: { left: -4000, top: 200 } });
    await session.detach();
  } catch {
    /* see header — never fail acquisition for presentation */
  }
}

/** A rectangle in global screen coordinates, as both `Browser.getWindowForTarget` and
 *  `screen.avail*` report it. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width
    && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * The display this window is on, as the PAGE sees it. `window.screen` is the window's own
 * display, so "does not intersect it" equals "does not intersect any display" — no enumeration
 * needed (`getScreenDetails()` would need a permission prompt).
 *
 * An EXPRESSION, not an arrow function: `page.evaluate(string)` evaluates it as an expression,
 * so a `() => …` form comes back as the function itself and readers silently see `undefined`.
 */
const SCREEN_JS = String.raw`({
  left: screen.availLeft || 0,
  top: screen.availTop || 0,
  width: screen.availWidth,
  height: screen.availHeight,
})`;

async function currentScreen(page: Page): Promise<Rect | null> {
  try {
    const r = (await page.evaluate(SCREEN_JS)) as Rect | null;
    return r && Number.isFinite(r.width) && Number.isFinite(r.height) ? r : null;
  } catch {
    return null; // about:blank can refuse an evaluate mid-navigation; the caller falls back
  }
}

/**
 * Undo a parking spot a previous run left in the profile — once, at launch.
 *
 * Chrome remembers window position per profile. Only a position no user would have chosen is
 * corrected; anything else is where they left the window.
 *
 * A parking spot is "off every display", not "far enough left": macOS clamps the parked
 * position onto the desktop UNION and remembers THAT (e.g. `{left: -408, top: -1050}`), which a
 * left-only threshold misses — on a single display, a window nobody can see. A threshold on
 * `top` is the mirrored bug: a negative top is legitimate when a second display sits above.
 * Only the intersection test distinguishes the two.
 */
export async function unparkWindow(browser: Browser): Promise<void> {
  try {
    const ctx = browser.contexts()[0];
    const page = ctx?.pages().find((p) => !p.isClosed());
    if (!page) return;
    const session = await ctx!.newCDPSession(page);
    try {
      const { windowId, bounds } = await session.send("Browser.getWindowForTarget");
      const view = await currentScreen(page);
      if (view && bounds.width && bounds.height) {
        const rect = { left: bounds.left ?? 0, top: bounds.top ?? 0, width: bounds.width, height: bounds.height };
        if (intersects(rect, view)) return; // on a real display — the user's position, leave it
      } else if ((bounds.left ?? 0) > PARKED_LEFT_MAX) {
        // No screen answer: fall back to the left-only threshold rather than move on a guess.
        return;
      }
      await session.send("Browser.setWindowBounds", { windowId, bounds: UNPARK_POSITION });
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    /* see parkWindowOffscreen — never fail acquisition for presentation */
  }
}


/**
 * Push the window back off-screen unless the user asked to see it. Called after every action,
 * since a tab or popup the PAGE opened raises the browser and cannot be stopped at the source.
 */
export async function keepInBackground(
  ctx: BrowserContext,
  page: Page,
  profileDir: string,
  cfg: BrowserConfig = browserConfigFromEnv(),
): Promise<void> {
  if (cfg.window !== "offscreen") return;
  if (userWantsVisible(profileDir)) return;
  try {
    const session = await ctx.newCDPSession(page);
    try {
      const { windowId, bounds } = await session.send("Browser.getWindowForTarget");
      if (bounds.windowState === "minimized") {
        // Minimised stops compositing, which freezes the host's live preview and hangs wheel
        // input — normal + off-screen is the only background posture that keeps working.
        await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      }
      if ((bounds.left ?? 0) > -200) {
        await session.send("Browser.setWindowBounds", { windowId, bounds: { left: -4000, top: 200 } });
      }
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    // Presentation upkeep is best-effort — never fail an action over a window position.
  }
}

