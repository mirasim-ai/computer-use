/** CDP clients of the same browser must agree on its process-wide download directory. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { sharedHome } from "../home.ts";

export function browserArtifactsDir(): string {
  return join(sharedHome(), "downloads", ".staging");
}

/** Every media feature Playwright pins on a page it attaches to, set back to "no override". */
const KEEP_USER_MEDIA = { colorScheme: null, reducedMotion: null, forcedColors: null, contrast: null } as const;

/**
 * Playwright attaches to every page with `prefers-color-scheme: light` (and no-preference for
 * reduced motion and contrast, none for forced colors) whatever the user's system says, and the
 * override lasts as long as the debugger stays attached: a dark page turns light under the agent
 * and stays light until the tab is let go. `noDefaults` would skip it, but it also turns off the
 * focus emulation that keeps `document.hasFocus()` true in a background tab (overlay-guard.ts),
 * so each page gets the media features handed back instead, as soon as Playwright reports it.
 * Not awaited: the call carries no timeout, and a tab that never answers must not hold up the
 * connection; a page that closes meanwhile has nothing left to restore.
 */
function keepUserMedia(browser: Browser): void {
  const restore = (page: Page) => void page.emulateMedia(KEEP_USER_MEDIA).catch(() => {});
  const watch = (context: BrowserContext) => {
    context.on("page", restore);
    context.pages().forEach(restore);
  };
  browser.on("context", watch);
  browser.contexts().forEach(watch);
}

export async function connectBrowserCdp(url: string, timeout?: number): Promise<Browser> {
  // Chrome uses GUID filenames here. Per-connection Playwright temp directories let a new
  // client redirect an older client's downloads, then delete them on disconnection.
  // Share persistent staging even when callers use different URLs for the same browser.
  const artifactsDir = browserArtifactsDir();
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  const browser = await chromium.connectOverCDP(url, { artifactsDir, ...(timeout === undefined ? {} : { timeout }) });
  keepUserMedia(browser);
  return browser;
}
