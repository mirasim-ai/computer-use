/** Captured from the loaded manifest, never fetched from files that an app update can replace. */
const manifest = chrome.runtime.getManifest();
export const RUNTIME_INFO = Object.freeze({
  id: chrome.runtime.id,
  version: manifest.version,
  build: manifest.version_name ?? null,
  protocol: 1,
  capabilities: ["discarded-tabs", "safe-reload"],
});
