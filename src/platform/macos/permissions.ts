/**
 * Every sentence this platform says about a MISSING GRANT, and nothing else.
 *
 * The wording IS the feature: a denied AX call answers empty rather than loudly, so "this app has
 * no controls" is exactly what an ungranted session looks like from the inside. Each text denies
 * the wrong conclusion the model is about to draw BEFORE giving the way out. They were written
 * against the measured permission matrix and are pinned in `test/macos-ui.ts`.
 *
 * Deciding, prompting and DISPLAYING permission state belong to the HOST; this driver only says
 * what is missing and points there.
 */

/**
 * Where a TCC grant is made. macOS gives it to the RESPONSIBLE app (top of the spawn chain: the
 * desktop app that launched us, or the terminal in a dev shell). Both routes are named rather
 * than guessed: this runs under a host AND as a standalone CLI, and a wrong guess sends the user
 * to a pane where their app is not listed.
 */
export const grantRoute = (pane: string): string =>
  `Grant "${pane}" to the app that launched this — on its own permissions page if it has one, `
  + `otherwise System Settings → Privacy & Security → ${pane}, tick that app (not the helper).`;

/** The two read refusals, worded like {@link MacosDriver.windowUnreadable}. */
export const noAccessibility = (pixelsAlsoDenied: boolean): string =>
  "Accessibility is not granted, so the control tree cannot be read. This is NOT an app without controls — "
  + "no app will read any better until the grant lands, and nothing about this app is wrong. "
  + `${grantRoute("Accessibility")} `
  // Offer pixels only when available: with both grants revoked the screenshot is refused too.
  + (pixelsAlsoDenied
    ? "Screen Recording is missing as well, so pixels are not a way around this one — nothing can be read until a grant lands."
    : "Pixels are a separate grant: screenshot() may still answer while this one is missing.");
export const NO_SCREEN_RECORDING =
  "Screen Recording is not granted, so this window cannot be photographed. The app is fine and the control tree is "
  + `unaffected — read it with observe() instead. ${grantRoute("Screen Recording")}`;

/** The helper ops that ACT. Their refusal differs from the read one: no read route can press
 *  anything, and the wrong conclusion here is "the app ignored me" or "my ref went stale". */
export const ACT_OPS = new Set(["press", "setvalue", "selectrange", "focus", "key", "backgroundkey", "backgroundtype", "type", "scroll", "mouse", "drag", "selectall", "closewindow", "at", "clipboardstash", "clipboardrestore"]);
export const NO_ACCESSIBILITY_ACT =
  "Accessibility is not granted, so nothing can be pressed, typed or scrolled. The action did NOT fail because the "
  + "app ignored it or because the ref was stale, and no app will answer until the grant lands — pixels are no way "
  + `around it either, since a screenshot cannot act. ${grantRoute("Accessibility")}`;
