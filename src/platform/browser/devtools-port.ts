/**
 * The DevTools PORT of a managed Chrome: reading the one it wrote, waiting for it to appear, and
 * asking whether anything is still answering there.
 *
 * Every rung of `acquire.ts`'s ladder branches on these answers: a port file left by a browser
 * that is gone reads exactly like a live one until something pings it.
 */


import { readFileSync } from "node:fs";
import { join } from "node:path";


/** The port an already-running Chrome published into its profile, or null. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function readDevToolsPort(profileDir: string): number | null {
  try {
    const first = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0]?.trim();
    const port = first ? Number.parseInt(first, 10) : Number.NaN;
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
}

/** Cheap liveness probe for a port we did not spawn ourselves. */
export async function pingDevTools(port: number, timeoutMs = 700): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Polls for the port file, backing off 20ms → ×1.6 → 150ms cap. `gaveUp` is checked AFTER the
 * read on purpose: a browser can write the file and exit, and the file is what we came for. */
export async function waitForDevToolsPort(profileDir: string, timeoutMs: number, gaveUp: () => boolean): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let waitMs = 20;
  for (;;) {
    const port = readDevToolsPort(profileDir);
    if (port !== null) return port;
    if (gaveUp() || Date.now() >= deadline) return null;
    await sleep(waitMs);
    waitMs = Math.min(150, Math.round(waitMs * 1.6));
  }
}
