/** A page's title for a LISTING, shared by the browser's tabs and an Electron app's windows. */

/** A LISTING's budget for one tab's title — see {@link boundedTitle}. */
const TITLE_BUDGET_MS = 1_500;

/**
 * One tab's title, or "" (callers fall back to the url) — never a wait worth noticing.
 *
 * `page.title()` runs in the page, and a listing asks every tab (or window) at once, so an
 * unbounded read makes the LISTING as slow as the sickest tab: one playwright held without a url
 * took 78 s to fail. A listing is a READ and must not block on a page mid-navigation, hung in JS or waiting on
 * a beforeunload dialog.
 */
export async function boundedTitle(page: { title(): Promise<string>; url(): string }): Promise<string> {
  // No url = playwright never saw this page navigate; asking it anything is the 78s case above.
  if (!page.url()) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.title().catch(() => ""),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), TITLE_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
