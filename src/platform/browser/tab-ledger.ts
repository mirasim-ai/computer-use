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

/** How long a listing waits to learn which Chrome target each of its pages is: the budget of
 *  the other "does this tab answer" questions. A page that has not said by then is listed under
 *  an id of its own, as before. */
const IDENTIFY_BUDGET_MS = 1_500;

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
  /** Stable per-session tab ids (element refs are re-minted; these are not), by page object and
   *  by Chrome target: a tab that comes back under a new object keeps the id the model holds. */
  private readonly ids = new WeakMap<Page, string>();
  private readonly idsByTarget = new Map<string, string>();
  private nextId = 1;
  /** Each page's Chrome targetId once read (it is fixed for the life of the object), and the
   *  read while it is in flight, so one page is asked once however many callers want it. */
  private readonly targets = new WeakMap<Page, string>();
  private readonly reads = new WeakMap<Page, Promise<string>>();

  /** `active` answers which page the session is on right now: an identity read comes back later
   *  than it was asked for, and must not record a page the session has since left. */
  constructor(private readonly active: () => Page | undefined) {}

  /** A page's Chrome targetId; "" when it cannot be read, which is asked again next time. */
  private targetOf(p: Page): Promise<string> {
    const known = this.targets.get(p);
    if (known) return Promise.resolve(known);
    let read = this.reads.get(p);
    if (!read) {
      read = pageTargetInfo(p).then(({ targetId }) => {
        if (!targetId) return "";
        this.targets.set(p, targetId);
        // An id handed out before the target was known is the tab's id from here on.
        const id = this.ids.get(p);
        if (id) this.idsByTarget.set(targetId, id);
        return targetId;
      }, () => "").finally(() => this.reads.delete(p));
      this.reads.set(p, read);
    }
    return read;
  }

  /** Learn which target each of these pages is, before they are listed: {@link idOf} can only
   *  give a tab its earlier id once that is known. Bounded, for a tab that answers nothing. */
  async identify(pages: Page[], budgetMs = IDENTIFY_BUDGET_MS): Promise<void> {
    const unread = pages.filter((p) => !this.targets.has(p) && !p.isClosed());
    if (!unread.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(unread.map((p) => this.targetOf(p))),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
  }

  /** Has this page said which target it is ({@link identify})? */
  identified(p: Page): boolean {
    return this.targets.has(p);
  }

  /** Has this session ever owned a tab? False on a first connection: nothing to find again. */
  ownsAny(): boolean {
    return this.ownedTargetIds.size > 0;
  }

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
    void this.targetOf(p).then((targetId) => {
      if (!targetId) return;
      this.ownedTargetIds.add(targetId);
      if (this.active() === p) this.activeTargetId = targetId;
    });
  }

  /** The session is on this page now, whoever's it is and however it got there (the driver moved
   *  it, the script chose it with focus(), close_tab left it there). Recorded at once for a page
   *  whose target is known: a tab that is closed a moment later must still be the one it was on. */
  noteActive(p: Page): void {
    const known = this.targets.get(p);
    if (known) { this.activeTargetId = known; return; }
    void this.targetOf(p).then((targetId) => {
      if (targetId && this.active() === p) this.activeTargetId = targetId;
    });
  }

  /**
   * What a page that is not known by object actually is, by Chrome's identity: `same` = the very
   * page the session was on (a re-mint), `ours` = another tab this session owns, null = neither.
   *
   * Being on a tab and owning it are two facts. A tab the session owns is owned again under its
   * new object; one it was only ON (the user's, bound by the script, or one that appeared and was
   * adopted) is `same` and still not its own to close.
   */
  async recognise(p: Page): Promise<"same" | "ours" | null> {
    const targetId = await this.targetOf(p);
    if (!targetId) return null;
    const owned = this.ownedTargetIds.has(targetId);
    if (owned) this.mine.add(p);
    return targetId === this.activeTargetId ? "same" : owned ? "ours" : null;
  }

  /** Note a page's target as seen, and answer whether this was the first sight of it (true too
   *  when the target cannot be read, which proves nothing). Asked once per page. */
  saw(p: Page): Promise<boolean> {
    let first = this.firstSight.get(p);
    if (!first) {
      first = this.targetOf(p).then((targetId) => {
        if (!targetId) return true;
        const seen = this.seenTargetIds.has(targetId);
        this.seenTargetIds.add(targetId);
        return !seen;
      });
      this.firstSight.set(p, first);
    }
    return first;
  }

  /** What {@link saw} answered for this page; true for one it was never asked about. */
  firstSightOf(p: Page): Promise<boolean> {
    return this.firstSight.get(p) ?? Promise.resolve(true);
  }

  /** The id this page's tab already has: the object's own, else the one its target was given
   *  under an earlier object. */
  private idHeld(p: Page): string | undefined {
    let id = this.ids.get(p);
    if (!id) {
      const target = this.targets.get(p);
      id = target ? this.idsByTarget.get(target) : undefined;
      if (id) this.ids.set(p, id);
    }
    return id;
  }

  /** The id the model knows this tab by, minted on first ask (`t1`, `t2`, …). */
  idOf(p: Page): string {
    return this.idHeld(p) ?? this.nameId(p, `t${this.nextId++}`);
  }

  /** Give a page the id it is already listed under (a borrowed tab: `tab:<id>:<session>`).
   *  `keep` leaves a tab that has an id as it is. */
  nameId(p: Page, id: string, keep = false): string {
    const held = keep ? this.idHeld(p) : undefined;
    if (held) return held;
    this.ids.set(p, id);
    const target = this.targets.get(p);
    if (target) this.idsByTarget.set(target, id);
    return id;
  }
}
