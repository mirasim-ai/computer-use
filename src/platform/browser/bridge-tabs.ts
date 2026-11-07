/**
 * The user's tabs on the extension bridge that this client holds no page for: ones Chrome unloaded,
 * and every one nobody bound (the bridge attaches only the agent's tabs and those a client asked
 * for). Each has an identity but no Playwright Page until it is bound and restored.
 */
import type { Browser, Page } from "playwright-core";
import { pageTargetInfo } from "./tabs.ts";

interface BridgeTabInfo {
  tabId: number;
  title: string;
  url: string;
  unloaded: boolean;
  /** Whether the asking client has this tab as a page; absent from a bridge that attached every tab. */
  held?: boolean;
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

/** The bridge's tabs this client holds no page for (see the header), and the nonce of the browser
 *  session they belong to (null off the bridge, or from a bridge too old to name one). */
export async function bridgeTabs(browser: Browser): Promise<{ dormant: BridgeTabInfo[]; browserSession: string | null }> {
  if (browser.version() !== "mirasim-bridge") return { dormant: [], browserSession: null };
  try {
    const result = await bridgeRequest<{ tabs: BridgeTabInfo[]; browserSession?: string }>(browser, "Mirasim.tabs");
    // An older bridge says nothing of `held`: it attached every loaded tab, so only unloaded ones lack a page.
    const dormant = result.tabs.filter((t) => t.unloaded || t.held === false).map((t) => ({ ...t, browserSession: result.browserSession ?? "" }));
    return { dormant, browserSession: result.browserSession || null };
  } catch (e) {
    // A previous bridge did not expose metadata separately. Preserve its existing behavior;
    // connection failures and other errors still need to reach the caller.
    if (/wasn't found|not found|not allowed|unknown method/i.test(String(e))) return { dormant: [], browserSession: null };
    throw e;
  }
}

/** {@link bridgeTabs}' nonce alone, for the paths that are not listing; any failure reads as unknown. */
export async function bridgeBrowserSession(browser: Browser): Promise<string | null> {
  return (await bridgeTabs(browser).catch(() => null))?.browserSession ?? null;
}

/** Attach a bound tab (reloading it first if Chrome had unloaded it) and wait for its page. A bridge
 *  too old to say whether it reloaded only ever restored unloaded tabs, hence the default. */
export async function restoreBridgeTab(browser: Browser, tabId: number, targetId: string, browserSession: string): Promise<{ page: Page; reloaded: boolean; viewport?: { width: number; height: number } }> {
  const restored = await bridgeRequest<{ reloaded?: boolean; viewport?: { width: number; height: number } }>(browser, "Mirasim.restoreTab", { tabId, targetId, browserSession });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const page of browser.contexts().flatMap((c) => c.pages())) {
      if (page.isClosed()) continue;
      if ((await pageTargetInfo(page).catch(() => null))?.targetId === targetId) return { page, reloaded: restored.reloaded ?? true, viewport: restored.viewport };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Restored tab ${tabId} did not become readable; no action was sent to a replacement page.`);
}

/**
 * Tell the bridge which tab this client is on (none: `undefined`); it lets go of every other tab of
 * the user's that the client borrowed. Answers whether this one is such a borrowed tab, and which.
 */
export async function holdOnlyBridgeTab(browser: Browser, targetId: string | undefined): Promise<{ held: boolean; tabId?: number; browserSession?: string }> {
  return await bridgeRequest(browser, "Mirasim.holdOnly", targetId ? { targetId } : {});
}

/** Close a listed tab this client holds no page for, without attaching to it first. */
export async function closeBridgeTab(browser: Browser, tabId: number, browserSession: string): Promise<void> {
  await bridgeRequest(browser, "Mirasim.closeTab", { tabId, browserSession });
}
