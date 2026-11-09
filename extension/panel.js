/**
 * The panel: the toolbar popup on a tab already handed over (or one Mirasim cannot use), and
 * the options page (right-click the icon → Options). Shows where the connection and this tab
 * stand, and edits the access settings — which the worker enforces (access.js); this page only
 * asks it (background.js `_onPageMessage`).
 */

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs) || key;
const $ = (id) => document.getElementById(id);

function send(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error ?? "no answer"));
      resolve(response.result);
    });
  });
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol.startsWith("http") ? u.host : url;
  } catch {
    return url ?? "";
  }
}

for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
document.documentElement.lang = chrome.i18n.getUILanguage();

let tabId = null;
let state = null;
/** The settings form is the user's while they edit it: a refresh does not overwrite it. */
let dirty = false;

async function findTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Opened as the options page, the active tab is this page: there is no "this tab" to show.
  if (!active || active.url?.startsWith(chrome.runtime.getURL(""))) {
    document.body.classList.add("page");
    return null;
  }
  return active.id ?? null;
}

function render() {
  const s = state;
  const status = $("status");
  status.textContent = s.connected ? t("statusConnected") : t("statusOffline");
  status.className = `status ${s.connected ? "on" : "off"}`;
  const pause = $("pause");
  pause.textContent = s.paused ? t("resume") : t("pause");
  pause.classList.toggle("active", s.paused);
  $("paused-note").hidden = !s.paused;

  renderTab(s);

  const using = $("using");
  using.replaceChildren();
  if (!s.using.length) using.append(item(t("agentTabsNone"), "empty"));
  for (const tab of s.using) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = tab.title || hostOf(tab.url);
    a.title = tab.url;
    a.addEventListener("click", () => void send("panel.focusTab", { tabId: tab.id }).then(() => window.close()));
    li.append(a);
    using.append(li);
  }

  if (!dirty) {
    for (const input of document.querySelectorAll('input[name="scope"]')) input.checked = input.value === s.settings.scope;
    $("blocked").value = s.settings.blocked.join("\n");
    $("allow-only").checked = s.settings.allowOnly;
    $("allowed").value = s.settings.allowed.join("\n");
    $("allowed-field").hidden = !s.settings.allowOnly;
  }

  const log = $("log");
  log.replaceChildren();
  if (!s.log.length) log.append(item(t("logNone"), "empty"));
  for (const entry of [...s.log].reverse()) {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const what = document.createElement("span");
    what.className = "what";
    const where = entry.url ? hostOf(entry.url) : entry.tabId !== undefined ? t("logTab", String(entry.tabId)) : "";
    what.textContent = [t(`reason_${entry.reason.replace(/-/g, "_")}`), where].filter(Boolean).join(" · ");
    what.title = entry.url ?? "";
    li.append(time, what);
    log.append(li);
  }

  const bridge = s.bridge ? t("footerBridge", `${s.bridge.name} ${s.bridge.version}`.trim()) : s.connected ? t("footerBridgeOld") : "";
  $("footer").textContent = [t("footerExtension", s.extension), bridge].filter(Boolean).join(" · ");
}

function renderTab(s) {
  const tab = s.tab;
  const title = $("tab-title");
  const host = $("tab-host");
  const line = $("tab-state");
  const action = $("tab-action");
  action.hidden = true;
  line.className = "tab-state";
  if (!tab) {
    title.textContent = "";
    host.textContent = "";
    line.textContent = t("tabStateNone");
    return;
  }
  title.textContent = tab.title || hostOf(tab.url);
  host.textContent = hostOf(tab.url);
  const scope = s.settings.scope;
  let text;
  if (tab.restricted) text = t("tabStateRestricted");
  else if (tab.siteVerdict) (text = t("tabStateBlocked")), (line.className = "tab-state bad");
  else if (tab.using) (text = t("tabStateUsing")), (line.className = "tab-state good");
  else if (tab.handedOver) (text = t("tabStateHanded")), (line.className = "tab-state good");
  else if (tab.granted) text = t("tabStateGranted");
  else if (scope === "all") text = t("tabStateOutsideAll");
  else if (scope === "ask") text = t("tabStateOutsideAsk");
  else text = t("tabStateOutside");
  line.textContent = text;
  if (tab.restricted || tab.siteVerdict) return;
  action.hidden = false;
  const giveBack = tab.handedOver || tab.using || tab.granted;
  action.textContent = giveBack ? t("takeBack") : t("handOver");
  action.className = giveBack ? "secondary" : "";
  action.onclick = async () => {
    action.disabled = true;
    try {
      await send(giveBack ? "panel.takeBack" : "panel.handOver", { tabId: tab.id });
      await refresh();
    } finally {
      action.disabled = false;
    }
  };
}

function item(text, cls) {
  const li = document.createElement("li");
  li.textContent = text;
  if (cls) li.className = cls;
  return li;
}

async function refresh() {
  state = await send("panel.state", { tabId });
  render();
}

function lines(id) {
  return $(id).value.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
}

async function save() {
  const scope = document.querySelector('input[name="scope"]:checked')?.value ?? "group";
  const settings = await send("panel.settings", {
    settings: { scope, blocked: lines("blocked"), allowOnly: $("allow-only").checked, allowed: lines("allowed") },
  });
  dirty = false;
  state.settings = settings;
  render();
  $("saved").hidden = false;
  setTimeout(() => ($("saved").hidden = true), 1500);
}

$("pause").addEventListener("click", async () => {
  await send("panel.pause", { paused: !state.paused });
  await refresh();
});
// The scope applies at once: one choice, nothing else to fill in.
for (const input of document.querySelectorAll('input[name="scope"]')) {
  input.addEventListener("change", () => void save());
}
for (const id of ["blocked", "allowed"]) $(id).addEventListener("input", () => (dirty = true));
$("allow-only").addEventListener("change", () => {
  dirty = true;
  $("allowed-field").hidden = !$("allow-only").checked;
});
$("save").addEventListener("click", () => void save());

tabId = await findTab();
await send("panel.seen");
await refresh();
// The agent works while the panel is open: keep the lists current.
setInterval(() => void refresh().catch(() => {}), 1500);
