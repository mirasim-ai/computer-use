/** CDP clients of the same browser must agree on its process-wide download directory. */
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { sharedHome } from "../home.ts";
import { keepUserMedia } from "../chromium/user-media.ts";
import { ensureRefSelector } from "../chromium/page-refs.ts";

export function browserArtifactsDir(): string {
  return join(sharedHome(), "downloads", ".staging");
}

/** A staged file nothing has written to for this long belongs to no download still running. */
const STAGED_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Remove what finished and abandoned downloads left in staging. A download a script watched is
 * moved out as it completes; one nobody watched stays under its GUID, and one cut short (the
 * browser closed mid-way) stays as a `.crdownload` — tens of megabytes each, for good. Staging
 * is shared by every session and browser on the machine, so the only safe test is age: no
 * process here can know another's downloads, but a file untouched for a day is nobody's.
 */
export async function clearStaleStaging(now = Date.now()): Promise<void> {
  const dir = browserArtifactsDir();
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  await Promise.all(names.map(async (name) => {
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (info.isFile() && now - info.mtimeMs > STAGED_KEEP_MS) await unlink(file);
    } catch { /* removed by another process, or not ours to remove */ }
  }));
}

export async function connectBrowserCdp(url: string, timeout?: number): Promise<Browser> {
  // Chrome uses GUID filenames here. Per-connection Playwright temp directories let a new
  // client redirect an older client's downloads, then delete them on disconnection.
  // Share persistent staging even when callers use different URLs for the same browser.
  const artifactsDir = browserArtifactsDir();
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  await clearStaleStaging();
  const browser = await chromium.connectOverCDP(url, { artifactsDir, ...(timeout === undefined ? {} : { timeout }) });
  keepUserMedia(browser);
  // Here, before anyone holding the connection reads a frame: a page's injected script takes the
  // engines registered when it is built and never learns of a later one. Registered only by the
  // endpoint ladder, the managed browser a session launched or adopted got the engine at its first
  // ref action, after the observation had built the first page's script, so every ref action on
  // that page missed (`no select for ref e5` on a select, a checkbox, a radio) until a reload.
  await ensureRefSelector(browser);
  return browser;
}
