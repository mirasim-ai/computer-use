/** A page keeps the user's media features under the agent (cdp-connection.ts keepUserMedia):
 * Playwright attaches with `prefers-color-scheme: light` and no-preference reduced motion, so a
 * dark page turned light for as long as the agent held it. A throwaway Chrome that prefers dark
 * and reduced motion is read before any Playwright client, then through a plain connectOverCDP
 * (the override this guards against), then through connectBrowserCdp — an open page and a new one. */

import { chromium, type Page } from "playwright-core";
import { connectBrowserCdp } from "../src/platform/browser/cdp-connection.ts";
import { sleep, spawnChrome } from "./helpers.ts";
import { RawCdp } from "./rig.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const PROBE = `JSON.stringify({ dark: matchMedia("(prefers-color-scheme: dark)").matches, reduce: matchMedia("(prefers-reduced-motion: reduce)").matches })`;
const USER = JSON.stringify({ dark: true, reduce: true });

/** What the page reports to a raw CDP session, which emulates nothing. */
async function rawProbe(cdpUrl: string): Promise<string> {
  const cdp = await RawCdp.connect(cdpUrl);
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const page = targetInfos.find((t: { type: string }) => t.type === "page");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const { result } = await cdp.send("Runtime.evaluate", { expression: PROBE }, sessionId);
    return result.value;
  } finally {
    cdp.close();
  }
}

/** The page's answer once it settles on `want`, or its last answer after two seconds. */
async function probeUntil(page: Page, want: string): Promise<string> {
  let seen = "";
  for (const deadline = Date.now() + 2000; Date.now() < deadline; await sleep(50)) {
    seen = await page.evaluate(PROBE) as string;
    if (seen === want) break;
  }
  return seen;
}

async function main() {
  const chrome = await spawnChrome({ extraArgs: ["--force-dark-mode", "--force-prefers-reduced-motion"] });
  try {
    const before = await rawProbe(chrome.cdpUrl);
    check("the throwaway Chrome prefers dark and reduced motion", before === USER, before);

    const plain = await chromium.connectOverCDP(chrome.cdpUrl);
    const plainSeen = await plain.contexts()[0]!.pages()[0]!.evaluate(PROBE) as string;
    check("premise: a plain connectOverCDP overrides both", plainSeen !== USER, plainSeen);
    await plain.close(); // a CDP-connected browser only disconnects

    const browser = await connectBrowserCdp(chrome.cdpUrl);
    const context = browser.contexts()[0]!;
    const open = context.pages()[0]!;
    check("an open page keeps the user's media features", await probeUntil(open, USER) === USER);
    const fresh = await context.newPage();
    check("a new page keeps the user's media features", await probeUntil(fresh, USER) === USER);
    await browser.close();
  } finally {
    chrome.cleanup();
  }
  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
