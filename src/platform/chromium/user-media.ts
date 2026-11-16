/** Handing a page its user's media features back, for every platform that attaches through
 *  Playwright: a browser tab and an Electron app's window alike. */
import type { Browser, BrowserContext, Page } from "playwright-core";

/** Every media feature Playwright pins on a page it attaches to, set back to "no override". */
const KEEP_USER_MEDIA = { colorScheme: null, reducedMotion: null, forcedColors: null, contrast: null } as const;

/**
 * Playwright attaches to every page with `prefers-color-scheme: light` (and no-preference for
 * reduced motion and contrast, none for forced colors) whatever the user's system says, and the
 * override lasts as long as the debugger stays attached: a dark page turns light under the agent
 * and stays light until the tab is let go. `noDefaults` would skip it, but it also turns off the
 * focus emulation that keeps `document.hasFocus()` true in a background tab
 * (browser/overlay-guard.ts), so each page gets the media features handed back instead, as soon
 * as Playwright reports it.
 * Not awaited: the call carries no timeout, and a tab that never answers must not hold up the
 * connection; a page that closes meanwhile has nothing left to restore.
 */
export function keepUserMedia(browser: Browser): void {
  const restore = (page: Page) => void page.emulateMedia(KEEP_USER_MEDIA).catch(() => {});
  const watch = (context: BrowserContext) => {
    context.on("page", restore);
    context.pages().forEach(restore);
  };
  browser.on("context", watch);
  browser.contexts().forEach(watch);
}
