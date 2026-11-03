/**
 * BrowserDriverCore — the connection/claim half of the browser driver: a live browser, a
 * context, and OUR tab. One slice of a single class; `driver.ts` extends it with the
 * observe/act primitives.
 *
 * Connection is lazy. A caller-provided endpoint is strict; otherwise we try the environment
 * hint, the conventional local endpoint, then the managed Chrome (adopt-or-launch on a
 * persistent profile; the ladder is in acquire.ts). Explicit sessions stay deterministic while
 * normal use recovers from stale ports, frozen leftovers and browser restarts.
 */

import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { ChromiumPageDriver } from "../chromium/page-driver.ts";
import { browserConfigFromEnv, type BrowserConfig, type BrowserConfigOptions, type TabClaim } from "./config.ts";
import { isAttachedProfile } from "./acquire.ts";
import { NO_TAB_OPEN_NOTE } from "./messages.ts";
import { ActionJournal } from "./journal.ts";
import { BrowserDownloads } from "./downloads.ts";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

/** Why the adopt paths moved: a tab this session opened reached real content. Shared by
 *  all four of them so one wording covers popups, named-tab openers and own-window tabs. */
export const ADOPTED_WHY = "a tab this session opened navigated to real content";
/** The unclaimed branch adopts a page it did NOT open (on a managed browser another client's
 *  fresh tab arrives here). "A tab this session opened" would be false exactly where the model
 *  uses it: deciding whether the move followed from its own last action. */
export const APPEARED_WHY = "a tab this session did not open appeared in the browser and reached real content";
/** The same page, back under a new Page object. `mine` is keyed on playwright's object, and a
 *  bridged browser re-announces every tab when the extension reconnects, so without this the
 *  driver's OWN tab would get {@link APPEARED_WHY}. Chrome's targetId survives the reconnect,
 *  so it is what this is decided on. */
export const REIDENTIFIED_WHY = "this session's own tab came back under a new id, because the connection to the browser dropped and returned";


export abstract class BrowserDriverCore extends ChromiumPageDriver {
  protected readonly downloads = new BrowserDownloads();
  protected browser: Browser | null = null;
  protected context!: BrowserContext;
  /** The page every verb acts on. Unset until connected, and on the extension bridge until the
   *  session opens a tab or binds one — it starts holding none there (tabs.ts `claimSessionTab`). */
  protected active: Page | undefined;
  /** Stable per-session tab ids (element refs are re-minted; target ids are not). */
  protected tabIds = new WeakMap<Page, string>();
  protected nextTabId = 1;
  /** Set only when the managed path acquired the browser: attached browsers have no run
   * dir, so there is nowhere (and no mandate) to publish action points for them. */
  protected managedProfileDir: string | null = null;
  /** A fact the NEXT result must carry (e.g. "the browser had been closed, a new one is up").
   *  Held on the driver rather than thrown, so both actions and observations can deliver it. */
  protected pendingNote: string | null = null;
  /** One-shot dialog answer armed by the `dialog` verb, consumed by the next dialog. No standing
   * policy: "accept everything" would silently accept some later, unrelated action's dialog. */
  protected armedDialog: { accept: boolean; text?: string } | null = null;
  /** The listener armed by `upload` without a ref, kept so a second arming replaces the first
   * instead of stacking two answers on one chooser. */
  protected armedChooser: ((fc: { setFiles(p: string[]): Promise<void> }) => void) | null = null;
  /** Whether this context already carries the keep-clicks-in-one-tab init script. */
  protected keepInTabInstalled = false;
  /** The profile belongs to the USER (browser takeover) — see {@link isAttachedProfile}. */
  protected attached = false;
  /** A page appeared since the last action — the focus net reads and clears it (driver.ts). */
  protected windowAppeared = false;
  /** Tab-claim mode: this driver owns ONE stamped tab in a SHARED browser — in the default
   *  context (`name:`), or in an isolated context with its own cookie jar (`ctx:`). */
  protected readonly tab: TabClaim | null;
  /** Isolated mode's ownership boundary: the CDP browser-context id of OUR context. Playwright
   *  files foreign-created contexts' pages under the default wrapper (see claimIsolatedTab), so
   *  pages are proven ours by this id instead. */
  protected ctxId: string | null = null;
  /** Per-page context ids, resolved once (one CDP round trip) then cached — the sync
   *  `page()` fallback may only trust pages already proven. */
  protected readonly pageCtxIds = new WeakMap<Page, string>();
  /** Pages this driver opened or claimed — in named-tab mode the ownership boundary
   *  (everything else in the shared browser is another surface's work). */
  protected readonly mine = new WeakSet<Page>();
  /** Owned pages that already carry the save-picker shim (save-picker.ts), so a re-claim does
   *  not register its init script twice. */
  protected readonly savePickerPages = new WeakSet<Page>();
  /** Chrome targetIds of the pages above — the half of ownership that outlives a playwright
   *  re-mint (see {@link REIDENTIFIED_WHY}). Ids only, so a closed page costs nothing. */
  protected readonly ownedTargetIds = new Set<string>();
  /** …and which of them `active` points at, recorded while that page is still readable: once
   *  the old object is closed, the only way to tell "the same page under a new object" from
   *  "another tab of mine" (a tab the user really closed). */
  protected activeTargetId: string | null = null;
  /** The action journal (observer side-channel) — built when the managed path acquires
   *  the browser; attached browsers have no run dir, so no journal. See journal.ts. */
  protected journal: ActionJournal | null = null;
  /** The session closed its own last tab: it holds none and must NOT take another
   *  (see {@link NO_TAB_OPEN_NOTE}). Cleared by the verbs that open one, and by binding a tab
   *  (`focusTarget`). */
  protected closedItsLastTab = false;
  /** The extension bridge's nonce for the browser session behind it, last seen; null until known
   *  (and always off the bridge). See {@link BrowserDriverConnect.noteBridgeSession}. */
  protected bridgeSession: string | null = null;
  /** …and a verb that opens one has just woken it. Only the WORDING needs this: the reclaim
   *  would otherwise blame the USER for a close this session did itself, which reads as the
   *  person taking the browser back mid-task (the one reading under which a model should stop). */
  protected wokeAfterSelfClose = false;
  /** CDP windowId of the window the agent opened for itself; null until it has one.
   *  While set, it is the boundary of everything this driver may see or touch. */
  protected ownWindowId: number | null = null;
  /** Which window each page lives in — one CDP round trip per page, then cached. */
  protected windowIds = new WeakMap<Page, number>();

  /** An endpoint was NAMED (`--cdp`, `COMPUTER_USE_CDP_URL`, `COMPUTER_USE_CDP_STRICT`): the browser is
   *  someone else's, not one we launched — read by the focus posture in `driver.ts`. */
  protected readonly explicit: boolean;
  protected readonly fallbackCdpUrl: string;

  /** The per-session surface knobs (profile dir, tab claim, window posture, attachment).
   *  Resolved ONCE, at construction rather than module load (so hosts can set the env after
   *  import), and nothing below reads `process.env` — see config.ts. */
  protected readonly cfg: BrowserConfig;

  constructor(
    cdpUrl?: string,
    fallbackCdpUrl = DEFAULT_CDP_URL,
    cfgOpts: BrowserConfigOptions = {},
    env: NodeJS.ProcessEnv = process.env,
  ) {
    super();
    // Explicit constructor values are strict; environment values are hints, because shell state
    // outlives an ephemeral browser port. `cdpStrict` makes the config's URL strict too (no :9222
    // fallback, no managed launch): a host that picked the user's own browser means THAT browser,
    // so when it is down the answer is the endpoint error, never a separate managed Chrome.
    this.cfg = browserConfigFromEnv({ ...cfgOpts, ...(cdpUrl !== undefined ? { cdpUrl } : {}) }, env);
    // Extension mode is strict too: the user picked their own browser, never a managed one.
    this.explicit = this.cfg.cdpStrict || (this.cfg.extension && !this.cfg.cdpUrl);
    // Attached mode has NO claim: it opens a window of its own instead of stamping a tab, so the
    // claim's filters would match nothing and every `ensure()` would read "all tabs gone" and
    // open yet another window in the USER'S browser. Dropping the claim here keeps them honest.
    this.tab = this.cfg.attached ? null : this.cfg.tab;
    this.fallbackCdpUrl = fallbackCdpUrl;
    this.cdpUrl = this.cfg.cdpUrl ?? fallbackCdpUrl;
  }
  protected cdpUrl: string;

  /** Hand over (and clear) the pending fact, so it is delivered exactly once. Read by
   *  `perform` here and by the base class's observation path. */
  protected override takePendingNote(): string | null {
    const note = this.pendingNote;
    this.pendingNote = null;
    return note;
  }

  /**
   * Add a fact to the pending note, unless that exact sentence is already in it.
   *
   * Two DIFFERENT facts from one round must both survive (a dialog note beside a surface move),
   * but only a `perform` or an observation drains the note, so a read-only round can repeat the
   * same sentence (an `ensure()` moving the active tab three times). Repetition carries nothing.
   */
  protected appendNote(note: string): void {
    if (!this.pendingNote) this.pendingNote = note;
    else if (!this.pendingNote.includes(note)) this.pendingNote = `${this.pendingNote}; ${note}`;
  }

  /**
   * Move the active surface and SAY so — the adopt paths, the attached ownership check, and the
   * closed-tab fallbacks. Reassigned silently, the next observation shows a different page that
   * the model reads as the effect of its own last action.
   *
   * Not one of the reopened notes: the browser did not close, so that wording would send the
   * model looking for a page that never died. Model-requested moves do not come here:
   * `focusTarget` assigns `active` and journals its own line.
   */
  protected makeActive(p: Page, why: string): void {
    if (this.active === p) return;
    this.active = p;
    this.rememberIdentity(p);
    // Observation continuity does not survive a surface move (see resetObservationState). Stale
    // refs are caught by the per-page identity mark in locate(), not the ref table: ref NUMBERS
    // are minted per page and COLLIDE across tabs. The reset is for the delta base and rect
    // table, keyed by those same refs, which would otherwise invent geometry changes.
    this.resetObservationState();
    const note = `the active tab changed (${why}) — nothing was lost, but refs from earlier `
      + `observations belong to the previous tab, so re-observe before acting on them`;
    this.appendNote(note);
    // Observers need it too: later lines' url and shot refer to the new tab. `auto` separates it
    // from the model's own focus switches.
    this.journal?.publishAction("focus", { auto: true }, null, { ok: true });
  }

  /** Implemented in {@link BrowserDriverTabs}: the one ownership call this slice makes, when a
   *  tab it did not choose becomes the active one. */
  protected abstract rememberIdentity(p: Page): void;
}
