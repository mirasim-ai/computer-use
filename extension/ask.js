/** The ask window (`ask` scope, group.js `_ask`): may the agent use this tab? */

const t = (key) => chrome.i18n.getMessage(key) || key;
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);

const tabId = Number(new URLSearchParams(location.search).get("tab"));
const tab = await chrome.tabs.get(tabId).catch(() => null);
if (!tab) {
  document.getElementById("tab-title").textContent = t("askGone");
  document.getElementById("allow").disabled = true;
} else {
  document.getElementById("tab-title").textContent = tab.title || tab.url;
  document.getElementById("tab-host").textContent = tab.url;
}

function answer(allow) {
  chrome.runtime.sendMessage({ type: "access.answer", tabId, allow }, () => window.close());
}
document.getElementById("allow").addEventListener("click", () => answer(true));
document.getElementById("deny").addEventListener("click", () => answer(false));
