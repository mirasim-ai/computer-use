/** A background webview's frames and queued input can both outlive the first cover probe. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { clickNamingCover } from "../src/platform/chromium/actions.ts";
import { sleep, spawnChrome } from "./helpers.ts";

const chrome = await spawnChrome({});
const browser = await chromium.connectOverCDP(chrome.cdpUrl);
try {
  const page = await browser.contexts()[0]!.newPage();
  const base = "http://pagination.test";
  const next = base + "/next";
  let arrivals = 0;
  await page.route(base + "/**", async route => {
    if (route.request().url() === next) {
      arrivals++;
      await sleep(250);
    }
    return route.fulfill({ contentType: "text/html", body: '<a href="/next">Next page</a>' });
  });
  await page.goto(base);
  const link = page.getByRole("link");
  const opts = { button: "left" as const, clickCount: 1 };

  // Slow the frame ticks in this document's JS worlds before the locator samples stability.
  // Playwright still performs its real visibility, motion and hit-target checks and click.
  const cdp = await page.context().newCDPSession(page);
  const contexts: number[] = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context.id));
  await cdp.send("Runtime.enable");
  for (const contextId of contexts) {
    await cdp.send("Runtime.evaluate", { contextId,
      expression: "window.requestAnimationFrame = fn => setTimeout(() => fn(performance.now()), 1150)",
    });
  }
  await cdp.detach();
  const attempts: number[] = [];
  const clicked = await clickNamingCover({ click: async options => {
    attempts.push(options!.timeout!);
    await link.click(options);
  } }, link, opts, "e1", "Next page", true);
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1]! > attempts[0]!);
  assert.ok(clicked?.ok);
  assert.equal(page.url(), next, "the next step can use the committed document");
  assert.equal(arrivals, 1);
  console.log("PASS  a slow stability sample still dispatches one link click");

  // A release already queued by the host can arrive after the general press grace.
  const timeout = Object.assign(new Error("Timeout 2000ms exceeded.\n  - performing click action"), { name: "TimeoutError" });
  await page.goto(base);
  let sends = 0;
  const queued = { click: async () => {
    sends++;
    await page.evaluate("setTimeout(() => document.querySelector('a').click(), 900)");
    throw timeout;
  } };
  const confirmed = await clickNamingCover(queued, link, opts, "e1", "Next page", true);
  assert.ok(confirmed?.ok);
  assert.equal(page.url(), next);
  assert.equal(sends, 1);
  assert.equal(arrivals, 2);
  console.log("PASS  the delayed destination confirms a lost receipt without a second send");

  await page.goto(base);
  const otherFrame = { click: async () => {
    await page.evaluate(`new Promise(resolve => {
      const frame = document.createElement("iframe");
      frame.onload = () => resolve(true);
      frame.src = "/next";
      document.body.append(frame);
    })`);
    throw timeout;
  } };
  await assert.rejects(clickNamingCover(otherFrame, link, opts, "e1", "Next page", true), /uncertain/);
  assert.equal(page.url(), base + "/");
  console.log("PASS  the expected URL in a different frame cannot confirm a main-frame click");
} finally {
  await browser.close();
  chrome.cleanup();
}
