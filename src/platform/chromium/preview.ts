/** Resolve a Chromium page's transport identity once. Works with ordinary and flattened CDP. */
import type { Page } from "playwright-core";
import type { PreviewTarget } from "../types.ts";

const identities = new WeakMap<Page, Promise<string>>();

export async function previewPage(page: Page, endpoint: string, kind: "browser" | "electron"): Promise<PreviewTarget | null> {
  if (page.isClosed()) return null;
  let identity = identities.get(page);
  if (!identity) {
    identity = (async () => {
      const session = await page.context().newCDPSession(page);
      try { return (await session.send("Target.getTargetInfo")).targetInfo.targetId; }
      finally { await session.detach().catch(() => {}); }
    })();
    identities.set(page, identity);
    void identity.catch(() => identities.delete(page));
  }
  const targetId = await identity;
  if (page.isClosed()) return null;
  return { kind, targetId, title: await page.title().catch(() => ""), url: page.url(),
    appName: kind === "browser" ? "Browser" : "Desktop app",
    capture: { type: "cdp", endpoint, targetId } };
}
