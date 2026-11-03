/**
 * Connect page: carries the relay URL from the local bridge to the service
 * worker. The bridge opens this page through the browser binary (reusing the
 * running Chrome); on success the service worker closes the tab, so the page
 * is on screen for well under a second.
 */

const status = document.getElementById("status");
const relayUrl = new URLSearchParams(location.search).get("relay");

if (!relayUrl) {
  status.textContent = "Missing relay URL — this page is meant to be opened by Mirasim.";
  status.className = "err";
} else {
  chrome.runtime.sendMessage({ type: "bridge.connect", relayUrl }, (response) => {
    if (chrome.runtime.lastError) {
      status.textContent = `Bridge error: ${chrome.runtime.lastError.message}`;
      status.className = "err";
      return;
    }
    if (response?.success) {
      status.textContent = "Connected — handing this tab back.";
    } else {
      status.textContent = `Could not connect: ${response?.error ?? "unknown error"}`;
      status.className = "err";
    }
  });
}
