/**
 * Tab claiming on a managed or attached Chrome — the pages a surface OWNS inside a browser it
 * shares. acquire.ts answers "which browser"; this answers "which tab in it" (open without
 * raising, stamp, re-adopt, isolate). acquire.ts imports this module; nothing here may import it.
 */

import type { Browser, BrowserContext, Page } from "playwright-core";
import { browserConfigFromEnv, type BrowserConfig } from "./config.ts";
import { msgNewTabNotFound } from "./messages.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long a tab we created may take to surface as a Page — see {@link pageWithTarget}. */
const NEW_TAB_WAIT_MS = 5_000;

/**
 * Open a tab WITHOUT raising the browser. `context.newPage()` makes Chrome the frontmost
 * application even with the window off-screen, stealing the user's keyboard; CDP's
 * `Target.createTarget` with `background: true` does not, so every tab this driver opens goes
 * through here.
 */
export async function newBackgroundPage(ctx: BrowserContext): Promise<Page> {
  // Anchor on a SHARED page, never an isolated-context one: Playwright files foreign-created
  // isolated contexts' pages under this same wrapper, and a CDP session anchored on one would
  // put the new tab (and its cookies) inside that surface's private context.
  const anchor = (await sharedPages(ctx))[0];
  if (!anchor) return await ctx.newPage(); // nothing to attach a CDP session to yet
  const before = new Set(ctx.pages());
  const session = await ctx.newCDPSession(anchor);
  let targetId: string;
  try {
    // `newWindow: true` gives the tab its own window rather than placing it in the background of
    // an existing one. On Linux, Chrome throttles screenshot frames for background tabs inside an
    // existing window, causing element shots to hang; a dedicated window avoids that. macOS uses
    // the same approach for consistency: the window opens in the background either way, so it
    // never raises the user's focus regardless of platform.
    ({ targetId } = await session.send("Target.createTarget", { url: "about:blank", background: true, newWindow: true }));
  } finally {
    await session.detach().catch(() => {});
  }
  const page = await pageWithTarget(ctx, targetId, before);
  if (page) return page;
  // Never fall back to `anchor`: on an endpoint we did not launch it is the USER'S tab (often the
  // one the session has bound), and every caller claims what this returns — which would make the
  // person's tab closable by close_tab({all}) without asking. Close the tab we did open, so no
  // blank one is left behind, and fail the open instead.
  const closer = await ctx.newCDPSession(anchor).catch(() => null);
  const closed = (await closer?.send("Target.closeTarget", { targetId }).catch(() => null))?.success === true;
  await closer?.detach().catch(() => {});
  throw new Error(msgNewTabNotFound(targetId, closed));
}

/**
 * The page for a target WE created, by id. Never "the page that appeared": two concurrent
 * claims poll overlapping windows, and a set difference lets both adopt ONE tab (the loser's
 * own orphaned at about:blank). `before` only narrows the candidates; identity is the id alone.
 */
async function pageWithTarget(
  ctx: BrowserContext,
  targetId: string,
  before: ReadonlySet<Page>,
): Promise<Page | null> {
  // Playwright learns about the target asynchronously. ~30ms is usual, even through the bridge;
  // the budget is for a loaded machine, since a miss now fails the open rather than taking a
  // stand-in page.
  const deadline = Date.now() + NEW_TAB_WAIT_MS;
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      if (before.has(p) || p.isClosed()) continue;
      if ((await pageTargetInfo(p).catch(() => null))?.targetId === targetId) return p;
    }
    await sleep(25);
  }
  return null;
}

/**
 * Tab-claim mode — `COMPUTER_USE_TAB`: the driver claims ONE durable tab in a SHARED managed
 * browser instead of a browser of its own, so N surfaces = N tabs in one Chrome. The tab is
 * stamped via `window.name` (survives navigation, dies with the tab) so a respawned driver
 * re-adopts ITS tab instead of leaking one per respawn. Two forms:
 *
 *  - `name:<key>` — a tab in the DEFAULT context, cookies shared with the other named tabs.
 *  - `ctx:<key>` — a tab in its OWN isolated browser context (own cookie jar and storage):
 *    logins not visible to or seeded from anyone else, e.g. a simulated eval user.
 */
const TAB_STAMP = "__mirasim_computer_use_tab:";
/** Is this page stamped with `key`? */
async function stampedWith(p: Page, key: string): Promise<boolean> {
  return (await tabStamp(p)) === TAB_STAMP + key;
}

/** Read one page's stamp with a hard bound — `evaluate` has no timeout of its own, and one
 * wedged tab must not hang every OTHER surface's claim. */
async function tabStamp(p: Page, budgetMs = 1000): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const bounded = new Promise<string>((r) => { timer = setTimeout(() => r(""), budgetMs); timer.unref?.(); });
  try {
    return String(await Promise.race([p.evaluate("window.name"), bounded]).catch(() => ""));
  } finally {
    clearTimeout(timer);
  }
}

/** Adopt the tab stamped with this key, else open a background tab and stamp it. */
export async function claimNamedTab(ctx: BrowserContext, key: string): Promise<Page> {
  for (const p of ctx.pages()) {
    if (!p.isClosed() && (await stampedWith(p, key))) return p;
  }
  const page = await newBackgroundPage(ctx);
  await page.evaluate(`window.name = ${JSON.stringify(TAB_STAMP + key)}`).catch(() => {});
  return page;
}

/**
 * Isolated-context named tab (`COMPUTER_USE_TAB=ctx:<key>`) — the durable claim of
 * {@link claimNamedTab}, in its OWN browser context of the shared browser.
 *
 * Adoption searches EVERY open page: the stamp is the only durable name a context has (ids do
 * not survive the browser; an EMPTIED context is unreachable, so a fresh one is minted). No
 * stamp ⇒ mint a context + background tab over raw CDP, because the context must outlive this
 * process (`disposeOnDetach` defaults false) and the first tab must not activate the window.
 *
 * The returned `ctxId` (CDP browser-context id) is the OWNERSHIP boundary, not the Playwright
 * `BrowserContext`: Playwright files pages of contexts another connection created under its
 * default-context wrapper, so only the id tells an isolated page from a shared one.
 */
export async function claimIsolatedTab(browser: Browser, key: string): Promise<{ page: Page; ctxId: string }> {
  const openPages = () => browser.contexts().flatMap((c) => c.pages()).filter((p) => !p.isClosed());
  for (const p of openPages()) {
    if (await stampedWith(p, key)) return { page: p, ctxId: await pageContextId(p) };
  }
  const before = new Set(openPages());
  const session = await browser.newBrowserCDPSession();
  let browserContextId: string;
  let targetId: string;
  try {
    ({ browserContextId } = await session.send("Target.createBrowserContext"));
    ({ targetId } = await session.send("Target.createTarget", { url: "about:blank", background: true, browserContextId }));
  } catch (e) {
    // An endpoint that will not mint a browser context (the bridge answers "Not allowed") cannot
    // serve an isolated claim at all; say so with the alternative, not as a raw protocol error
    // for a command the model never issued. Names the endpoint, not a browser MODE: platform
    // code has no notion of the host's identity settings.
    throw new Error(
      `this endpoint cannot create isolated browser contexts (${e instanceof Error ? e.message.split("\n")[0] : String(e)}),`
      + ` so the tab claim "ctx:${key}" is unavailable here — use a named tab ("name:${key}") for a`
      + ` tab of your own in the same browser, which is the same isolation everywhere except cookies`
      + ` and storage`,
    );
  } finally {
    await session.detach().catch(() => {});
  }
  // By id, as in {@link pageWithTarget}: a racing claim's tab would also be the wrong context.
  for (let i = 0; i < 40; i++) {
    for (const p of openPages()) {
      if (before.has(p)) continue;
      if ((await pageTargetInfo(p).catch(() => null))?.targetId !== targetId) continue;
      await p.evaluate(`window.name = ${JSON.stringify(TAB_STAMP + key)}`).catch(() => {});
      return { page: p, ctxId: browserContextId };
    }
    await sleep(25);
  }
  throw new Error("isolated-context tab was created but never surfaced over CDP");
}

/** A page's CDP identity: its targetId and the browser context it lives in
 *  (ctxId "" when Chrome reports none — never a match). */
export async function pageTargetInfo(page: Page): Promise<{ targetId: string; ctxId: string }> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return { targetId: targetInfo.targetId, ctxId: targetInfo.browserContextId ?? "" };
  } finally {
    await session.detach().catch(() => {});
  }
}

/** The CDP browser-context id a page lives in — see {@link pageTargetInfo}. */
export async function pageContextId(page: Page): Promise<string> {
  return (await pageTargetInfo(page)).ctxId;
}


/**
 * The tab a fresh (non-attached) session starts on:
 *
 *  - default — a NEW tab (or an unclaimed blank one), never one left open: an adopted browser's
 *    existing pages are someone else's work in progress.
 *  - `COMPUTER_USE_TAB=reuse` — for EXCLUSIVE browsers: continue the most recent working tab,
 *    whose page state is the continuity between errands. Never the default on a shared browser.
 *  - named (`name:<key>`, pre-parsed by the caller) — the one stamped tab, never a stray blank,
 *    which may be another surface's tab being born.
 *  - an endpoint we did not launch — a new tab too; on the extension bridge NONE (null).
 */
export async function claimSessionTab(
  ctx: BrowserContext,
  namedKey: string | null,
  cfg: BrowserConfig = browserConfigFromEnv(),
): Promise<Page | null> {
  if (namedKey) return claimNamedTab(ctx, namedKey);
  // Shared pages only: a `reuse` continuation must not seize an isolated surface's page,
  // and a fresh about:blank may be an isolated tab being born.
  const pages = await sharedPages(ctx);
  // On an endpoint we did not launch, the rules below would pick one of the USER'S tabs (the
  // most recent working tab, or a blank one that is not ours), so open a fresh tab; a user's tab
  // stays reachable by NAMING it (`focus(id)`). On the extension bridge not even that: the first
  // call is usually a listing, and a tab opened for it would sit blank in the person's window for
  // the driver's life. The session holds NO tab until `new_tab` / `open_url`; other endpoints
  // keep the fresh tab, since a harness acts on the session's tab without naming one.
  // Cost: `reuse` cannot continue a page through the bridge, as CDP does not say which tabs were
  // the agent's. The bridge knows (model.ts `agentTabs`) and could expose it in /json/list.
  if (cfg.cdpUrl) return ctx.browser()?.version() === "mirasim-bridge" ? null : await newBackgroundPage(ctx);
  const reuse = cfg.tabReuse ? pages.filter((p) => p.url() !== "about:blank").at(-1) : undefined;
  return reuse ?? pages.find((p) => p.url() === "about:blank") ?? (await newBackgroundPage(ctx));
}

/**
 * The wrapper's open pages that are actually in the DEFAULT CDP context (`ctx.pages()` also holds
 * foreign-created isolated contexts' pages). `Target.getBrowserContexts` names the created
 * contexts; a page in none of them is shared. One CDP round trip when no isolated context exists.
 */
async function sharedPages(ctx: BrowserContext): Promise<Page[]> {
  const open = ctx.pages().filter((p) => !p.isClosed());
  const browser = ctx.browser();
  if (!browser || open.length === 0) return open;
  let created: Set<string>;
  const session = await browser.newBrowserCDPSession();
  try {
    created = new Set((await session.send("Target.getBrowserContexts")).browserContextIds);
  } catch {
    return open;
  } finally {
    await session.detach().catch(() => {});
  }
  if (created.size === 0) return open;
  const shared: Page[] = [];
  for (const p of open) {
    if (!created.has(await pageContextId(p).catch(() => ""))) shared.push(p);
  }
  return shared;
}

/**
 * Give a windowless browser its first page, without raising it. Only meaningful right after a
 * `--silent-launch` launch; a no-op when a page already exists.
 */
export async function ensureBackgroundTab(browser: Browser): Promise<void> {
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    if (ctx.pages().some((p) => !p.isClosed())) return;
    const session = await browser.newBrowserCDPSession();
    try {
      await session.send("Target.createTarget", { url: "about:blank", background: true });
    } finally {
      await session.detach().catch(() => {});
    }
    for (let i = 0; i < 40; i++) {
      if (ctx.pages().some((p) => !p.isClosed())) return;
      await sleep(25);
    }
  } catch {
    // A browser that will not open its first tab fails loudly on the caller's first action.
  }
}
