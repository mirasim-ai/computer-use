/** Unloaded Chrome tabs have identities but no Playwright Page until explicitly restored. */
import type { Browser, Page } from "playwright-core";
import { pageTargetInfo } from "./tabs.ts";

interface BridgeTabInfo {
  tabId: number;
  title: string;
  url: string;
  unloaded: boolean;
  browserSession: string;
}

export async function bridgeRequest<T>(browser: Browser, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const session = await browser.newBrowserCDPSession();
  try {
    return await (session as unknown as { send(method: string, params: Record<string, unknown>): Promise<T> }).send(method, params);
  } finally {
    await session.detach().catch(() => {});
  }
}

/** The bridge's unloaded tabs, and the nonce of the browser session they belong to (null off the
 *  bridge, or from a bridge too old to name one). */
export async function bridgeTabs(browser: Browser): Promise<{ unloaded: BridgeTabInfo[]; browserSession: string | null }> {
  if (browser.version() !== "mirasim-bridge") return { unloaded: [], browserSession: null };
  try {
    const result = await bridgeRequest<{ tabs: BridgeTabInfo[]; browserSession?: string }>(browser, "Mirasim.tabs");
    const unloaded = result.tabs.filter((t) => t.unloaded).map((t) => ({ ...t, browserSession: result.browserSession ?? "" }));
    return { unloaded, browserSession: result.browserSession || null };
  } catch (e) {
    // A previous bridge did not expose metadata separately. Preserve its existing behavior;
    // connection failures and other errors still need to reach the caller.
    if (/wasn't found|not found|not allowed|unknown method/i.test(String(e))) return { unloaded: [], browserSession: null };
    throw e;
  }
}

/** {@link bridgeTabs}' nonce alone, for the paths that are not listing; any failure reads as unknown. */
export async function bridgeBrowserSession(browser: Browser): Promise<string | null> {
  return (await bridgeTabs(browser).catch(() => null))?.browserSession ?? null;
}

export async function restoreBridgeTab(browser: Browser, tabId: number, targetId: string, browserSession: string): Promise<{ page: Page; viewport?: { width: number; height: number } }> {
  const restored = await bridgeRequest<{ viewport?: { width: number; height: number } }>(browser, "Mirasim.restoreTab", { tabId, targetId, browserSession });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const page of browser.contexts().flatMap((c) => c.pages())) {
      if (page.isClosed()) continue;
      if ((await pageTargetInfo(page).catch(() => null))?.targetId === targetId) return { page, viewport: restored.viewport };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Restored tab ${tabId} did not become readable; no action was sent to a replacement page.`);
}
