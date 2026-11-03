/**
 * Attached-profile mode (`COMPUTER_USE_ATTACHED=1`): the profile belongs to the USER, so the agent
 * borrows a window and touches nothing else.
 *
 * The three things this pins are the three ways the managed-browser assumptions become damage
 * once the browser is someone's daily Chrome:
 *   1. the agent gets its OWN window instead of taking a tab the user is looking at;
 *   2. the user's tabs are not listed as targets (the model must not see, or be invited to
 *      switch to, their mail);
 *   3. an unusable browser is an ERROR, never a SIGTERM to the process they are working in.
 *
 * A real Chrome is started to stand in for "the user's browser" — the same shape as
 * managed-chrome.ts, since the behaviour under test only exists against a real CDP.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  acquireManagedBrowser,
  browserPids,
  killByProfileDir,
  readDevToolsPort,
} from "../src/platform/browser/acquire.ts";
import { BrowserDriver } from "../src/platform/browser/driver.ts";
import { sleep } from "./helpers.ts";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** How many browser WINDOWS the endpoint has (distinct CDP windowIds over page targets). */
async function windowCount(cdpUrl: string): Promise<number> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const ctx = browser.contexts()[0]!;
    const ids = new Set<number>();
    for (const p of ctx.pages()) {
      if (p.isClosed()) continue;
      const cdp = await ctx.newCDPSession(p);
      try { ids.add((await cdp.send("Browser.getWindowForTarget")).windowId); }
      finally { await cdp.detach().catch(() => {}); }
    }
    return ids.size;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "computer-use-attached-"));
  const prevAttached = process.env.COMPUTER_USE_ATTACHED;
  const prevProfile = process.env.COMPUTER_USE_PROFILE_DIR;
  const prevWindow = process.env.COMPUTER_USE_WINDOW;
  process.env.COMPUTER_USE_ATTACHED = "1";
  process.env.COMPUTER_USE_PROFILE_DIR = profile;
  process.env.COMPUTER_USE_WINDOW = "offscreen";

  try {
    // "The user's browser": acquired in attached mode, so its first window stays where they
    // could see it rather than being parked off-screen.
    const user = await acquireManagedBrowser(profile);
    check("attached acquire connects", user.browser.isConnected());
    const port = readDevToolsPort(profile);
    check("the browser published a port", port !== null, String(port));

    // The user is working in a tab of their own.
    const userCtx = user.browser.contexts()[0]!;
    const userPage = userCtx.pages().find((p) => !p.isClosed()) ?? (await userCtx.newPage());
    await userPage.goto(`data:text/html,${encodeURIComponent("<title>user-own-tab</title><h1>user</h1>")}`).catch(() => {});
    const windowsBefore = await windowCount(user.cdpUrl);
    const pidsBefore = await browserPids(profile);
    check("the user's browser is running", pidsBefore.length > 0, `${pidsBefore.length} pid(s)`);

    // The agent starts working.
    const driver = new BrowserDriver();
    await driver.observeElements();

    const windowsAfter = await windowCount(user.cdpUrl);
    check(
      "the agent opened a window of its OWN",
      windowsAfter === windowsBefore + 1,
      `${windowsBefore} → ${windowsAfter} windows`,
    );

    const targets = await driver.listTargets();
    check(
      "the user's tabs are not listed as targets",
      targets.length === 1,
      `${targets.length} target(s): ${targets.map((t) => t.title).join(" | ")}`,
    );
    check(
      "the target the agent sees is its own blank page, not the user's",
      !targets.some((t) => t.title.includes("user-own-tab")),
    );

    // The user's page is untouched and still theirs.
    check("the user's tab is still open", !userPage.isClosed());
    check("the user's tab still shows their page", (await userPage.title()) === "user-own-tab");

    // A tab claim carried into attached mode is dropped, not half-applied. Before the fix the
    // isolated filter matched nothing, so EVERY call read "all tabs gone" and opened one more
    // window in the user's browser (15 in one measured run).
    const claimed = new BrowserDriver(undefined, undefined, { tab: "ctx:probe" });
    const windowsBeforeClaim = await windowCount(user.cdpUrl);
    await claimed.listTargets();
    await claimed.observeElements();
    const claimedTargets = await claimed.listTargets();
    const windowsAfterClaim = await windowCount(user.cdpUrl);
    check(
      "a ctx: claim in attached mode opens ONE own window, not one per call",
      windowsAfterClaim === windowsBeforeClaim + 1,
      `${windowsBeforeClaim} → ${windowsAfterClaim} windows over three calls`,
    );
    check("and lists its own tab as the one target", claimedTargets.length === 1, `${claimedTargets.length} target(s)`);
    await claimed.close();

    // Disconnecting must never take the user's browser with it.
    await driver.close();
    await user.browser.close().catch(() => {});
    await sleep(300);
    const pidsAfter = await browserPids(profile);
    check(
      "disconnecting left the user's browser running",
      pidsAfter.length > 0,
      `${pidsAfter.length} pid(s)`,
    );

    // An attached profile whose browser cannot be driven is a dead end with advice — the one
    // branch that must never reach for killByProfileDir.
    await killByProfileDir(profile); // tear the stand-in down ourselves, as the test's own cleanup
    await sleep(300);
    let message = "";
    try {
      // With the browser gone and the profile free, a fresh attached acquire LAUNCHES (that is
      // allowed — nobody is using it). Prove the error path instead by pointing at a profile
      // whose Chrome we cannot start.
      const bogus = mkdtempSync(join(tmpdir(), "computer-use-attached-bogus-"));
      const prevChrome = process.env.COMPUTER_USE_CHROME;
      process.env.COMPUTER_USE_CHROME = join(bogus, "no-such-chrome");
      try {
        await acquireManagedBrowser(bogus);
      } finally {
        if (prevChrome === undefined) delete process.env.COMPUTER_USE_CHROME;
        else process.env.COMPUTER_USE_CHROME = prevChrome;
        rmSync(bogus, { recursive: true, force: true });
      }
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    check("an unusable browser fails with guidance, not silently", message.length > 0, message.split("\n")[0]);
  } finally {
    await killByProfileDir(profile).catch(() => {});
    rmSync(profile, { recursive: true, force: true });
    if (prevAttached === undefined) delete process.env.COMPUTER_USE_ATTACHED;
    else process.env.COMPUTER_USE_ATTACHED = prevAttached;
    if (prevProfile === undefined) delete process.env.COMPUTER_USE_PROFILE_DIR;
    else process.env.COMPUTER_USE_PROFILE_DIR = prevProfile;
    if (prevWindow === undefined) delete process.env.COMPUTER_USE_WINDOW;
    else process.env.COMPUTER_USE_WINDOW = prevWindow;
  }

  console.log(failures ? `\n${failures} attached-profile check(s) FAILED` : "\nall attached-profile checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
