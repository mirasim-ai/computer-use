/**
 * The toolbar icon, per tab: what a click does, and what the badge and tooltip say.
 *
 *  - On a tab the agent could use but has not been handed, a click hands it over (the tab joins
 *    the mirasim group of its window, group.js `addToMirasimGroup`). Chrome only fires
 *    `action.onClicked` for a tab with no popup, so those tabs get an empty popup.
 *  - Everywhere else — a tab already handed over, a browser page, a blocked site — a click opens
 *    the panel (panel.html), where the user can take a tab back. One click never takes a tab
 *    away from the agent mid-task.
 *
 * The icon says whether the agent may use the tab at all, as Playwriter's does: in colour on a
 * tab handed over (in the mirasim group, or one the agent opened), greyed out everywhere else —
 * so a tab in the group reads differently from one outside it even while the agent is idle.
 * Badges add what the colour cannot: ✓ the agent holds this tab right now; × a site rule blocks
 * it; II the agent is paused; "new" until the panel has been opened once (0.1.3 changed what
 * the agent may reach by default). Chrome resets tab-specific action state on navigation, so
 * every tab update re-applies it.
 */

import { PANEL_SEEN_KEY } from "./access.js";
import { GROUP_TITLE, addToMirasimGroup, isNonDebuggableUrl } from "./group.js";
import { debugLog } from "./relay.js";

const PANEL = "panel.html";
const BADGES = {
  paused: { text: "II", color: "#b45309" },
  using: { text: "✓", color: "#2a58c0" },
  blocked: { text: "×", color: "#6b7280" },
  fresh: { text: "new", color: "#2a58c0" },
  none: { text: "", color: "#2a58c0" },
};

const t = (key) => chrome.i18n.getMessage(key) || key;

const ICON_SIZES = [16, 32];
/** The toolbar icon greyed out, drawn once from the shipped PNGs: no second set of files to keep
 *  in step with the brand mark (mirasim scripts/make-app-icons.mjs writes only the colour one). */
let greyIcon = null;
async function greyedIcon() {
  greyIcon ??= (async () => {
    const out = {};
    for (const size of ICON_SIZES) {
      const blob = await (await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`))).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, size, size);
      const img = ctx.getImageData(0, 0, size, size);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const grey = Math.round(0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]);
        d[i] = d[i + 1] = d[i + 2] = grey;
        d[i + 3] = Math.round(d[i + 3] * 0.55);
      }
      out[size] = img;
    }
    return out;
  })().catch((e) => {
    greyIcon = null;
    throw e;
  });
  return await greyIcon;
}
const COLOUR_ICON = Object.fromEntries(ICON_SIZES.map((size) => [size, `icons/icon-${size}.png`]));

export class Toolbar {
  /**
   * @param {import("./access.js").AccessPolicy} policy
   * @param {() => import("./group.js").MirasimTabGroup | null} activeGroup
   */
  constructor(policy, activeGroup) {
    this._policy = policy;
    this._activeGroup = activeGroup;
    this._seen = true;
    this._ready = chrome.storage.local
      .get(PANEL_SEEN_KEY)
      .then((v) => {
        this._seen = v?.[PANEL_SEEN_KEY] === true;
      })
      .catch(() => {});

    chrome.action.onClicked.addListener((tab) => void this._onClicked(tab));
    chrome.tabs.onUpdated.addListener((tabId) => void this.refresh(tabId));
    chrome.tabs.onCreated.addListener((tab) => tab.id !== undefined && void this.refresh(tab.id));
    chrome.tabGroups.onUpdated.addListener(() => void this.refreshAll());
    chrome.tabGroups.onRemoved.addListener(() => void this.refreshAll());
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[PANEL_SEEN_KEY]) {
        this._seen = changes[PANEL_SEEN_KEY].newValue === true;
        void this.refreshAll();
      }
    });
    policy.onChange(() => void this.refreshAll());
    void policy.ready.then(() => this.refreshAll());
  }

  /** A click on a tab with no popup: hand it to the agent. */
  async _onClicked(tab) {
    if (tab?.id === undefined) return;
    try {
      await addToMirasimGroup(tab.id);
    } catch (e) {
      debugLog("hand-over failed:", e);
      await chrome.action.setTitle({ tabId: tab.id, title: `${t("handOverFailed")} ${e?.message ?? e}` }).catch(() => {});
      return;
    }
    await this.refresh(tab.id);
  }

  async refreshAll() {
    await this._ready;
    const tabs = await chrome.tabs.query({}).catch(() => []);
    await Promise.all(tabs.map((tab) => this._apply(tab)));
  }

  async refresh(tabId) {
    await this._ready;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) await this._apply(tab);
  }

  /** Where a tab stands, for the toolbar and the panel alike. */
  async stateOf(tab) {
    const group = this._activeGroup();
    const handedOver = tab.groupId !== undefined && tab.groupId >= 0
      && (await chrome.tabGroups.get(tab.groupId).catch(() => null))?.title === GROUP_TITLE;
    return {
      connected: !!group,
      agents: !!group?.isAgentTab(tab.id),
      restricted: isNonDebuggableUrl(tab.url) || isNonDebuggableUrl(tab.pendingUrl),
      siteVerdict: this._policy.siteVerdict(tab.url) ?? this._policy.siteVerdict(tab.pendingUrl),
      handedOver,
      using: !!group?.isAttached(tab.id),
      granted: this._policy.grants.has(tab.id),
    };
  }

  async _apply(tab) {
    if (tab.id === undefined) return;
    const s = await this.stateOf(tab);
    const joinable = !s.handedOver && !s.agents && !s.restricted && !s.siteVerdict;
    const reachable = (s.handedOver || s.agents || s.using) && !s.restricted && !s.siteVerdict;
    let badge = BADGES.none;
    let tip;
    if (s.using) (badge = BADGES.using), (tip = t("tipUsing"));
    else if (s.siteVerdict) (badge = BADGES.blocked), (tip = t("tipBlocked"));
    else if (s.restricted) tip = t("tipRestricted");
    else if (s.handedOver || s.agents) tip = t("tipHandedOver");
    else tip = t("tipJoin");
    if (this._policy.paused) badge = BADGES.paused;
    else if (badge === BADGES.none && !this._seen) badge = BADGES.fresh;
    const prefix = this._policy.paused ? t("tipPausedPrefix") : !s.connected ? t("tipOfflinePrefix") : "";
    const tabId = tab.id;
    let icon;
    try {
      icon = reachable ? { path: COLOUR_ICON } : { imageData: await greyedIcon() };
    } catch (e) {
      debugLog("grey icon failed:", e);
    }
    try {
      await Promise.all([
        icon ? chrome.action.setIcon({ tabId, ...icon }) : Promise.resolve(),
        chrome.action.setPopup({ tabId, popup: joinable ? "" : PANEL }),
        chrome.action.setBadgeText({ tabId, text: badge.text }),
        chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }),
        chrome.action.setTitle({ tabId, title: `${prefix}${tip}` }),
      ]);
    } catch {
      /* tab already closed */
    }
  }
}
