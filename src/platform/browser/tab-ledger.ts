/**
 * WHICH TABS ARE THIS SESSION'S, in one place: the pages it opened or claimed, the Chrome targets
 * behind them, which of those it is on, what its connection has already been shown, and the ids
 * the model knows its tabs by.
 *
 * A Playwright `Page` object can be replaced under the driver (a bridged browser announces every
 * tab again when its connection returns) and a tab can be closed by the page itself; Chrome's
 * targetId is the only name that survives both. So ownership is kept by object, for the hot and
 * synchronous paths, AND by targetId, for finding a tab again. The driver decides what to do
 * with a page (driver-tabs.ts, driver-connect.ts); this only remembers.
 */

import type { Page } from "playwright-core";
import { pageTargetInfo } from "./tabs.ts";

export class TabLedger {
  /** Pages this driver opened or claimed — in named-tab mode the ownership boundary
   *  (everything else in the shared browser is another surface's work). */
  private readonly mine = new WeakSet<Page>();
  /** Chrome targetIds of the pages above — the half of ownership that outlives a playwright
   *  re-mint. Ids only, so a closed page costs nothing. */
  private readonly ownedTargetIds = new Set<string>();
  /** …and which of them the session is on, recorded while that page is still readable: once
   *  the old object is closed, the only way to tell "the same page under a new object" from
   *  "another tab of mine" (a tab the user really closed). */
  private activeTargetId: string | null = null;
  /** Chrome targetIds of every page this driver's connection has shown it, its own or not, and
   *  per page whether that was the first sight of its target ({@link saw}). A bridged browser
   *  announces every tab AGAIN when its connection returns; one seen before has not "appeared",
   *  whatever order the announcements come in. */
  private readonly seenTargetIds = new Set<string>();
  private readonly firstSight = new WeakMap<Page, Promise<boolean>>();
  /** Stable per-session tab ids (element refs are re-minted; these are not). */
  private readonly ids = new WeakMap<Page, string>();
  private nextId = 1;

  /** `active` answers which page the session is on right now: an identity read comes back later
   *  than it was asked for, and must not record a page the session has since left. */
  constructor(private readonly active: () => Page | undefined) {}

  /** Is this page object one the session opened or claimed? Synchronous: the cache only. */
  owns(p: Page): boolean {
    return this.mine.has(p);
  }

  /** Take ownership of a page: the object now, its Chrome targetId in the background. */
  claim(p: Page): void {
    this.mine.add(p);
    this.remember(p);
  }

  /** Record a page's Chrome targetId as ours, and as the ACTIVE one while it still is. Read in
   *  the background — a claim must not wait on a CDP round trip, and a page that dies before it
   *  answers was never re-findable. */
  remember(p: Page): void {
    void pageTargetInfo(p).then(({ targetId }) => {
      if (!targetId) return;
      this.ownedTargetIds.add(targetId);
      if (this.active() === p) this.activeTargetId = targetId;
    }).catch(() => {});
  }

  /**
   * What a page that is not owned by object actually is, by Chrome's identity: `same` = the very
   * page the session was on (a re-mint), `ours` = another tab this session owns, null = not ours
   * at all. Either of the first two makes the object owned again.
   */
  async recognise(p: Page): Promise<"same" | "ours" | null> {
    const { targetId } = await pageTargetInfo(p).catch(() => ({ targetId: "" }));
    if (!targetId || !this.ownedTargetIds.has(targetId)) return null;
    this.mine.add(p);
    return targetId === this.activeTargetId ? "same" : "ours";
  }

  /** Note a page's target as seen, and answer whether this was the first sight of it (true too
   *  when the target cannot be read, which proves nothing). Asked once per page. */
  saw(p: Page): Promise<boolean> {
    let first = this.firstSight.get(p);
    if (!first) {
      first = pageTargetInfo(p).then(({ targetId }) => {
        if (!targetId) return true;
        const seen = this.seenTargetIds.has(targetId);
        this.seenTargetIds.add(targetId);
        return !seen;
      }, () => true);
      this.firstSight.set(p, first);
    }
    return first;
  }

  /** What {@link saw} answered for this page; true for one it was never asked about. */
  firstSightOf(p: Page): Promise<boolean> {
    return this.firstSight.get(p) ?? Promise.resolve(true);
  }

  /** The id the model knows this tab by, minted on first ask (`t1`, `t2`, …). */
  idOf(p: Page): string {
    let id = this.ids.get(p);
    if (!id) { id = `t${this.nextId++}`; this.ids.set(p, id); }
    return id;
  }

  /** Give a page the id it is already listed under (a borrowed tab: `tab:<id>:<session>`).
   *  `keep` leaves a page that has an id as it is. */
  nameId(p: Page, id: string, keep = false): string {
    if (!keep || !this.ids.has(p)) this.ids.set(p, id);
    return this.ids.get(p)!;
  }
}
