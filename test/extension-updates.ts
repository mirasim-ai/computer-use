/**
 * What the bridge says about the extension on the line — `node scripts/test.mjs extension-updates`.
 *
 * The browser runs the Web Store copy of the extension, never the files bundled beside the bridge,
 * so the two can carry the same version and different builds: extension code that changed after
 * 0.1.4 was published (rc.6) made the bundle `0.1.4 (f8c4adefbd4d6ebd)` while the store stayed
 * `0.1.4 (d37f658388c010e3)`. Judged by that fingerprint the bridge said "reload required", and a
 * reload loads the store build again, so it said so for good. Version, protocol and capabilities
 * decide; the build does not.
 *
 * Hermetic: the status logic alone, with no bridge, socket or browser.
 */

import { readFileSync } from "node:fs";
import { ExtensionUpdates, MINIMUM_EXTENSION_VERSION, compareVersions, type ExtensionRuntimeInfo } from "../src/platform/browser/bridge/extension-updates.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const bundled = { version: "0.1.4", version_name: "0.1.4 (f8c4adefbd4d6ebd)" };
const store: ExtensionRuntimeInfo = {
  id: "khflooofmndpmafhofjdcpjfgnlpikhg", version: "0.1.4", build: "0.1.4 (d37f658388c010e3)",
  protocol: 1, capabilities: ["discarded-tabs", "safe-reload"],
};

function judge(runtime: ExtensionRuntimeInfo | null, connected = true) {
  const updates = new ExtensionUpdates(bundled, () => false, async () => {});
  updates.runtime = runtime;
  return updates.status(connected);
}

const sameVersionOtherBuild = judge(store);
check("the store build of the bundled version is ready, whatever its fingerprint", sameVersionOtherBuild.compatibility === "ready",
  JSON.stringify(sameVersionOtherBuild));
check("...and needs no reload", sameVersionOtherBuild.reloadPending === false && sameVersionOtherBuild.error === null);
check("the very build that is bundled is ready", judge({ ...store, build: bundled.version_name }).compatibility === "ready");
check("a copy that reports no build is ready", judge({ ...store, build: null }).compatibility === "ready");
check("a newer store version is ready", judge({ ...store, version: "0.1.5", build: "0.1.5 (0000000000000000)" }).compatibility === "ready");

check("an older version needs updating", judge({ ...store, version: "0.1.3", build: "0.1.3 (1111111111111111)" }).compatibility === "update-required");
check("a copy without safe reload needs reloading", judge({ ...store, capabilities: ["discarded-tabs"] }).compatibility === "reload-required");
check("a copy that announced no runtime needs reloading", judge(null).compatibility === "reload-required");
check("a newer protocol than this bridge speaks needs a newer app", judge({ ...store, protocol: 2 }).compatibility === "app-update-required");
check("no extension on the line is unknown", judge(store, false).compatibility === "unknown");

// T-4050: rc.14/rc.15 bundled 0.1.5 and asked for it while the store served 0.1.4. The bridge now asks for
// MINIMUM_EXTENSION_VERSION, which a release may raise only to a version the store serves (web-store.mjs --check-minimum).
const manifestVersion = (JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")) as { version: string }).version;
check("the minimum is never ahead of the extension this package bundles", compareVersions(MINIMUM_EXTENSION_VERSION, manifestVersion) <= 0,
  `minimum ${MINIMUM_EXTENSION_VERSION}, manifest ${manifestVersion}`);
const byMinimum = new ExtensionUpdates({ version: MINIMUM_EXTENSION_VERSION }, () => false, async () => {});
byMinimum.runtime = { ...store, version: MINIMUM_EXTENSION_VERSION, build: null };
check("the store copy at the minimum is ready, whatever the bundled version", byMinimum.status(true).compatibility === "ready",
  JSON.stringify(byMinimum.status(true)));

console.log(failures ? `\n${failures} check(s) failed` : "\nall extension-updates checks passed");
process.exit(failures ? 1 : 0);
