/** Regression coverage for stale COMPUTER_USE_CDP_URL values, strict explicit endpoints, and an
 *  endpoint one of whose tabs answers nothing. */

import { chromium } from "playwright-core";
import { BrowserDriver } from "../src/platform/browser/driver.ts";
import { sleep, spawnChrome } from "./helpers.ts";

const STALE_CDP = "http://127.0.0.1:1";
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const previous = process.env.COMPUTER_USE_CDP_URL;
  const fallback = await spawnChrome({});

  try {
    process.env.COMPUTER_USE_CDP_URL = STALE_CDP;
    // A caller-provided URL is deterministic and must never fall through to another browser.
    const strict = new BrowserDriver(STALE_CDP, fallback.cdpUrl);
    let strictError = "";
    try { await strict.listTargets(); }
    catch (e) { strictError = (e as Error).message; }
    finally { await strict.close(); }
    check("explicit CDP endpoint stays strict", strictError.includes("explicit CDP endpoint"), strictError.slice(0, 100));

    // The same stale URL inherited from the environment is only a hint. The driver
    // must continue to the live fallback endpoint without asking the user to unset it.
    const recovering = new BrowserDriver(undefined, fallback.cdpUrl);
    const targets = await recovering.listTargets();
    check("stale environment endpoint falls back", targets.length > 0, `${targets.length} target(s)`);
    await recovering.close();
  } finally {
    fallback.cleanup();
  }

  const primary = await spawnChrome({});
  const replacement = await spawnChrome({});
  let primaryClosed = false;
  try {
    process.env.COMPUTER_USE_CDP_URL = primary.cdpUrl;
    const reconnecting = new BrowserDriver(undefined, replacement.cdpUrl);
    await reconnecting.listTargets();
    primary.cleanup();
    primaryClosed = true;
    await sleep(500);
    const targets = await reconnecting.listTargets();
    check("dead browser connection recovers", targets.length > 0, `${targets.length} target(s)`);
    await reconnecting.close();
  } finally {
    if (!primaryClosed) primary.cleanup();
    replacement.cleanup();
    if (previous === undefined) delete process.env.COMPUTER_USE_CDP_URL;
    else process.env.COMPUTER_USE_CDP_URL = previous;
  }

  // An endpoint the session was pointed at, with one tab stuck in a script that never returns:
  // connecting waits on every tab, so this used to end after 30 s in a bare timeout.
  const shared = await spawnChrome({});
  try {
    const setup = await chromium.connectOverCDP(shared.cdpUrl);
    const context = setup.contexts()[0]!;
    await (context.pages()[0] ?? await context.newPage()).goto("data:text/html,<title>Fine</title><h1>fine</h1>");
    const stuck = await context.newPage();
    await stuck.goto("data:text/html,<title>Stuck</title><h1>hangs</h1>");
    await stuck.evaluate("setTimeout(() => { for (;;) {} }, 100)");
    await setup.close();
    await sleep(500);
    const pointed = new BrowserDriver(shared.cdpUrl);
    const started = Date.now();
    let refused = "";
    try { await pointed.listTargets(); }
    catch (e) { refused = (e as Error).message; }
    finally { await pointed.close(); }
    const ms = Date.now() - started;
    check("an endpoint with a tab that answers nothing is refused in seconds, naming the tab",
      /one of its tabs does not/.test(refused) && /«Stuck»/.test(refused) && /no tab was closed/.test(refused) && ms < 12_000, `${ms} ms: ${refused.slice(0, 220)}`);
    const targets = await (await fetch(`${shared.cdpUrl}/json/list`)).json() as Array<{ type: string; title: string }>;
    check("...and that tab is left open, in someone else's browser", targets.some((t) => t.type === "page" && t.title === "Stuck"));
  } finally {
    shared.cleanup();
  }

  console.log(failures === 0 ? "\nCONNECTION RECOVERY OK" : `\nCONNECTION RECOVERY FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
