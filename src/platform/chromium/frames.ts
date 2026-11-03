/** Which frames of a page can be read without waiting forever. */
import type { Frame, Page } from "playwright-core";

/**
 * The page's frames minus those that never committed a document. A `loading="lazy"` iframe
 * far below the viewport has none until scrolled near, and playwright's evaluate/locator on it
 * wait for an execution context that never comes: one such frame on MDN held every observation
 * to the full 15 s bound. Its URL is `""` exactly then (about:blank, srcdoc and script-written
 * frames all report one), and it holds nothing to list; once it loads, the next read sees it.
 */
export function readableFrames(page: Page): Frame[] {
  return page.frames().filter((f) => f.parentFrame() === null || f.url() !== "");
}
