/**
 * Regression test for the zero-tab attach failure: a browser whose windows have all
 * been closed (process alive, no page targets) rejects Playwright's connect handshake
 * with "Browser context management is not supported". The driver must recover by
 * opening a blank tab over the CDP HTTP endpoint.
 */

import { spawnChrome } from "./helpers.ts";
import { createHarness, firstText } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;

  // Close every page target so the browser has none left. `/json/close` ACKs before Chrome has
  // finished tearing the target down, so the list has to be polled rather than read once — read
  // once, the race fails this fixture on a busy machine while it passes every time on an idle
  // one, which reads as a broken driver rather than a broken test.
  const pageTargets = async (): Promise<Array<{ id: string; type: string }>> => {
    const all = await (await fetch(`${chrome.cdpUrl}/json/list`)).json() as Array<{ id: string; type: string }>;
    return all.filter((t) => t.type === "page");
  };
  for (const t of await pageTargets()) {
    await fetch(`${chrome.cdpUrl}/json/close/${t.id}`).catch(() => {});
  }
  let remaining = await pageTargets();
  for (const deadline = Date.now() + 5000; remaining.length && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 100));
    remaining = await pageTargets();
    // A target that reappears (Chrome re-opening a startup tab) gets closed again.
    for (const t of remaining) await fetch(`${chrome.cdpUrl}/json/close/${t.id}`).catch(() => {});
  }
  check("fixture has zero page targets", remaining.length === 0, `${remaining.length} left`);

  try {
    const { resolveProfile } = await import("../src/platform/profile.ts");
    const profile = resolveProfile({ driver: "browser" });
    const h = createHarness(profile.driver);
    const text = firstText(await h.observe({}));
    check("driver recovers and observes", !text.includes("could not attach"), text.slice(0, 80));
    await profile.driver.close();
  } finally {
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nATTACH RECOVERY OK" : `\nATTACH RECOVERY FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
