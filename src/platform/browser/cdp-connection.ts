/** CDP clients of the same browser must agree on its process-wide download directory. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { sharedHome } from "../home.ts";

export function browserArtifactsDir(): string {
  return join(sharedHome(), "downloads", ".staging");
}

export async function connectBrowserCdp(url: string, timeout?: number): Promise<Browser> {
  // Chrome uses GUID filenames here. Per-connection Playwright temp directories let a new
  // client redirect an older client's downloads, then delete them on disconnection.
  // Share persistent staging even when callers use different URLs for the same browser.
  const artifactsDir = browserArtifactsDir();
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  return chromium.connectOverCDP(url, { artifactsDir, ...(timeout === undefined ? {} : { timeout }) });
}
