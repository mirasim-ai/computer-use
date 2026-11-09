/**
 * What the agent may reach in this browser: the user's own settings, enforced HERE.
 *
 * The extension is the one layer of the connection the agent does not run, so the limits live
 * in it and hold whichever bridge is on the other end (the desktop app's, an npm package's, an
 * older one). The relay asks this module before it lists a tab, attaches one, runs a command or
 * forwards an event (relay.js), and the tab group says which tabs are in scope (group.js).
 *
 *  - **scope** — `group` (the default): tabs in the mirasim group, tabs the agent opened and
 *    the popups of those; `all`: every tab, as before 0.1.3; `ask`: every tab is listed, and the
 *    first attach of one outside the group waits for the user's yes in a small window.
 *  - **site rules** — a block list, and an optional allow-only list, both of host names that
 *    also cover their subdomains. They hold in every scope: a blocked site is neither listed,
 *    opened, navigated to nor read, and its cookies and downloads are filtered out.
 *  - **pause** — every tab is let go of, and every command but the keepalive and the tab
 *    listing is refused until the user resumes (group.js `reevaluate`, relay.js).
 *
 * Settings live in `chrome.storage.sync` (they follow the user's Chrome profile); the pause,
 * the ask-mode grants and the log of refusals live in `chrome.storage.session`, gone with the
 * browser session they describe.
 */

export const SETTINGS_KEY = "mirasim-access";
export const STATE_KEY = "mirasim-access-state";
/** Set once the user has opened the panel; until then the toolbar shows "new". */
export const PANEL_SEEN_KEY = "mirasim-panel-seen";
export const SCOPES = ["group", "all", "ask"];
export const DEFAULT_SETTINGS = Object.freeze({ scope: "group", blocked: [], allowOnly: false, allowed: [] });
/** How many refusals the panel shows. */
const LOG_LIMIT = 20;
/** The same refusal again within this window is one entry, not a flood (a paused agent retries). */
const LOG_DEDUPE_MS = 2_000;

/**
 * A pattern as the user typed it, reduced to a host name: `https://www.Bank.com/login` and
 * `*.bank.com` both become what they mean (`www.bank.com`, `bank.com`). Empty for nonsense.
 */
export function normalizePattern(text) {
  let s = String(text ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^.*@/, "").replace(/:\d+$/, "");
  s = s.replace(/^(\*\.)+/, "").replace(/^\.+/, "").replace(/\.+$/, "");
  return /^[a-z0-9.-]+$/.test(s) || /^\[[0-9a-f:]+\]$/.test(s) ? s : "";
}

/** `host` is `pattern` or one of its subdomains. */
export function hostMatches(host, pattern) {
  return host === pattern || host.endsWith(`.${pattern}`);
}

/**
 * The host a URL loads from, or null for one that loads nothing from the web (about:blank,
 * data:, the browser's own pages). A blob: URL is its origin's.
 */
export function hostOf(url) {
  if (!url) return null;
  try {
    let u = new URL(url);
    if (u.protocol === "blob:") u = new URL(u.pathname);
    if (!/^(https?|wss?|ftp):$/.test(u.protocol)) return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function cleanList(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(normalizePattern).filter(Boolean))];
}

/** Settings as stored, made whole: unknown fields dropped, every list normalized. */
export function cleanSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    scope: SCOPES.includes(s.scope) ? s.scope : DEFAULT_SETTINGS.scope,
    blocked: cleanList(s.blocked),
    allowOnly: s.allowOnly === true,
    allowed: cleanList(s.allowed),
  };
}

export class AccessPolicy {
  constructor() {
    this.settings = cleanSettings(DEFAULT_SETTINGS);
    this.paused = false;
    /** Ask mode: tabs the user said yes to, until they close. */
    this.grants = new Set();
    /** @type {Array<{at: number, reason: string, tabId?: number, url?: string, detail?: string}>} */
    this.log = [];
    /** @type {Set<() => void>} */
    this._listeners = new Set();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes[SETTINGS_KEY]) {
        this.settings = cleanSettings(changes[SETTINGS_KEY].newValue);
        this._emit();
      } else if (area === "session" && changes[STATE_KEY]) {
        const before = this.paused;
        this._adoptState(changes[STATE_KEY].newValue);
        if (before !== this.paused) this._emit();
      }
    });
    this.ready = this._load();
  }

  async _load() {
    const [sync, session] = await Promise.all([
      chrome.storage.sync.get(SETTINGS_KEY).catch(() => ({})),
      chrome.storage.session.get(STATE_KEY).catch(() => ({})),
    ]);
    this.settings = cleanSettings(sync?.[SETTINGS_KEY]);
    this._adoptState(session?.[STATE_KEY]);
  }

  _adoptState(state) {
    this.paused = state?.paused === true;
    this.grants = new Set(Array.isArray(state?.grants) ? state.grants.filter(Number.isInteger) : []);
    this.log = Array.isArray(state?.log) ? state.log.slice(-LOG_LIMIT) : [];
  }

  _saveState() {
    return chrome.storage.session
      .set({ [STATE_KEY]: { paused: this.paused, grants: [...this.grants], log: this.log } })
      .catch(() => {});
  }

  /** Called whenever what is reachable may have changed: settings, or the pause. */
  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        /* one listener's failure is not the others' */
      }
    }
  }

  async saveSettings(next) {
    this.settings = cleanSettings(next);
    await chrome.storage.sync.set({ [SETTINGS_KEY]: this.settings });
    this._emit();
    return this.settings;
  }

  async setPaused(paused) {
    this.paused = paused === true;
    await this._saveState();
    this._emit();
  }

  grant(tabId) {
    this.grants.add(tabId);
    void this._saveState();
  }

  forget(tabId) {
    if (this.grants.delete(tabId)) void this._saveState();
  }

  /** Anything stricter than "every tab, every site"? */
  restrictive() {
    const s = this.settings;
    return s.scope !== "all" || s.blocked.length > 0 || s.allowOnly;
  }

  /**
   * Why a URL is off limits, or null when it is not: `site-blocked` for the block list,
   * `site-not-allowed` for a host outside the allow-only list. A URL that loads nothing from
   * the web (about:blank, data:) is never refused here.
   */
  siteVerdict(url) {
    const host = hostOf(url);
    if (host === null) return null;
    const { blocked, allowOnly, allowed } = this.settings;
    if (blocked.some((p) => hostMatches(host, p))) return "site-blocked";
    if (allowOnly && !allowed.some((p) => hostMatches(host, p))) return "site-not-allowed";
    return null;
  }

  /**
   * May the agent see this cookie? A cookie set for a parent domain is sent to the blocked
   * subdomain too, so `.bank.com` is withheld when `online.bank.com` is blocked; on an allow list,
   * a cookie counts when it is sent to some allowed host.
   */
  cookieAllowed(domain) {
    const d = String(domain ?? "").replace(/^\./, "").toLowerCase();
    if (!d) return true;
    const related = (p) => hostMatches(d, p) || hostMatches(p, d);
    const { blocked, allowOnly, allowed } = this.settings;
    if (blocked.some(related)) return false;
    if (allowOnly && !allowed.some(related)) return false;
    return true;
  }

  record(entry) {
    const last = this.log[this.log.length - 1];
    const now = Date.now();
    if (last && last.reason === entry.reason && last.tabId === entry.tabId && last.url === entry.url && now - last.at < LOG_DEDUPE_MS) return;
    this.log.push({ at: now, ...entry });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    void this._saveState();
  }
}

/**
 * A refusal the bridge passes on to the agent as the command's error: what was refused and
 * what the agent can do about it, in words a model relays to the person.
 */
export function refusal(reason, { tabId, url } = {}) {
  const host = hostOf(url) ?? url ?? "this site";
  switch (reason) {
    case "site-blocked":
      return `${host} is blocked by the user's Mirasim site rules; the agent cannot open or read it.`;
    case "site-not-allowed":
      return `${host} is not on the user's Mirasim allow list; the agent can only use the sites on it.`;
    case "out-of-scope":
      return `Tab ${tabId} is not one the user handed to the agent. Ask them to click the Mirasim toolbar icon on that tab to hand it over, or open a tab of your own.`;
    case "ask-pending":
      return `Waiting for the user to allow tab ${tabId} in the Mirasim prompt; try again once they answer.`;
    case "declined":
      return `The user declined to let the agent use tab ${tabId}.`;
    case "paused":
      return "The user paused the agent from the Mirasim extension; wait until they resume it.";
    case "clear-cookies":
      return "Clearing every browser cookie is refused while the user limits what the agent can reach.";
    case "cookie-site":
      return `Cookies of ${host} are off limits under the user's Mirasim site rules.`;
    default:
      return "Refused by the user's Mirasim access settings.";
  }
}

export class AccessError extends Error {
  constructor(reason, details = {}) {
    super(refusal(reason, details));
    this.reason = reason;
    this.details = details;
  }
}
