/**
 * Browser login-state transfer — export/import cookies + per-origin localStorage over
 * CDP, in Playwright's storage_state shape, so a login performed ONCE by hand in one
 * profile can be carried into another. The profile directory itself is never copied:
 * Chrome locks it while running, and it drags along history, caches and device ids.
 *
 * Shape (the cross-process contract, also a valid Playwright `storageState` file):
 *   { cookies: [{name, value, domain, path, expires, httpOnly, secure, sameSite}],
 *     origins: [{origin, localStorage: [{name, value}]}] }
 */

import type { Browser, BrowserContext, Page } from "playwright-core";
import { newBackgroundPage } from "./tabs.ts";

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie (Playwright convention). */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

interface StorageStateOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface BrowserStorageState {
  cookies: StorageStateCookie[];
  origins: StorageStateOrigin[];
}

/** http(s) origin of a URL, or null for anything else (about:, chrome:, data:, file:). */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The default browser context of a CDP-attached Chrome — the profile itself. */
function profileContext(browser: Browser): BrowserContext {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("mirasim-cu: the attached browser exposes no context to read state from.");
  return ctx;
}

/**
 * Export the browser's storage state.
 *
 * Cookies are the full jar (every domain, HttpOnly included). CDP cannot list every origin
 * with localStorage, so that covers only the currently OPEN top-level http(s) pages — not
 * sites without a tab, third-party iframes, or sessionStorage. Right for login seeding: the
 * user just logged in, so the site's tab is open; keep it open when exporting.
 */
export async function exportStorageState(browser: Browser): Promise<BrowserStorageState> {
  const context = profileContext(browser);
  const cookies = (await context.cookies()) as StorageStateCookie[];

  const byOrigin = new Map<string, Page>();
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const origin = originOf(page.url());
    if (origin && !byOrigin.has(origin)) byOrigin.set(origin, page);
  }

  const origins: StorageStateOrigin[] = [];
  for (const [origin, page] of byOrigin) {
    try {
      const items = await page.evaluate(() => {
        const out: Array<{ name: string; value: string }> = [];
        for (let i = 0; i < localStorage.length; i++) {
          const name = localStorage.key(i);
          if (name !== null) out.push({ name, value: localStorage.getItem(name) ?? "" });
        }
        return out;
      });
      // Empty origins are omitted, matching Playwright's own storage_state files.
      if (items.length) origins.push({ origin, localStorage: items });
    } catch {
      // A page that cannot evaluate (crashed tab, opaque origin) contributes nothing;
      // its cookies are still in the jar above.
    }
  }
  return { cookies, origins };
}

/**
 * Import a storage state into the attached browser: cookies first, then localStorage origin
 * by origin. Idempotent: a re-run overwrites the same keys with the same values.
 */
export async function importStorageState(browser: Browser, state: BrowserStorageState): Promise<void> {
  const context = profileContext(browser);
  if (state.cookies?.length) {
    try {
      await context.addCookies(state.cookies);
    } catch (e) {
      throw new Error(`mirasim-cu: cookie import failed: ${firstLine(e)}`);
    }
  }
  for (const entry of state.origins ?? []) {
    if (!entry?.origin || !entry.localStorage?.length) continue;
    await seedOriginLocalStorage(context, entry.origin, entry.localStorage);
  }
}

/**
 * Write one origin's localStorage by navigating a throwaway background page to the origin
 * with EVERY request fulfilled by an empty document (Playwright's own technique): the origin
 * is real, but nothing touches the network, so it works offline and no server code can run
 * over the values being written.
 */
async function seedOriginLocalStorage(
  context: BrowserContext,
  origin: string,
  items: Array<{ name: string; value: string }>,
): Promise<void> {
  const page = await newBackgroundPage(context);
  try {
    await page.route("**/*", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>mirasim-cu state import</title>" }));
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await page.evaluate((kv) => {
      for (const { name, value } of kv) localStorage.setItem(name, value);
    }, items);
  } catch (e) {
    throw new Error(`mirasim-cu: localStorage import failed for ${origin}: ${firstLine(e)}`);
  } finally {
    await page.unroute("**/*").catch(() => {});
    await page.close().catch(() => {});
  }
}

function firstLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split("\n")[0] ?? text;
}
