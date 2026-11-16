/**
 * One tab that answers nothing does not cost a shared browser its life —
 * `node scripts/test.mjs managed-stalled-tab`.
 *
 * Several sessions share the managed Chrome, a tab each. Connecting waits on every open tab, so
 * with one tab stuck in a script that never returns the handshake of the NEXT session timed out,
 * the browser was taken for a frozen leftover, and it was killed and started again: every
 * session's pages reloaded, for one page that hung.
 *
 * Pinned here, on a throwaway headless Chrome adopted through its profile directory:
 *
 *   · the next session connects, the browser process is the same one, and the session already
 *     there keeps its connection and its page's state;
 *   · only the tab that answers nothing is closed, and the session that connected is told which;
 *   · a tab that is only busy for a few seconds is waited for and kept;
 *   · in the user's own browser (attached) no tab is closed: the refusal names the stuck one.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { acquireManagedBrowser } from "../src/platform/browser/acquire.ts";
import { browserConfigFromEnv } from "../src/platform/browser/config.ts";
import { sleep, spawnChrome, type ThrowawayChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const urls = (browser: Browser): string[] => browser.contexts().flatMap((c) => c.pages()).map((p) => p.url());
const WORK = "data:text/html,<title>Work</title><h1>Session A works here</h1><input id=i>";
const STUCK = "data:text/html,<title>Stuck</title><h1>This page hangs</h1>";

/** A throwaway Chrome that reads as a managed one already running: its port published in its
 *  profile, as a Chrome that picked its own port publishes it. */
async function runningBrowser(): Promise<{ chrome: ThrowawayChrome; first: Browser; work: Page; other: Page }> {
  const chrome = await spawnChrome({});
  writeFileSync(join(chrome.profileDir, "DevToolsActivePort"), `${new URL(chrome.cdpUrl).port}\n/devtools/browser/test\n`);
  // The session already there: one tab with unsaved state in it, and the tab that will hang.
  const first = await chromium.connectOverCDP(chrome.cdpUrl);
  const context = first.contexts()[0]!;
  const work = context.pages()[0] ?? await context.newPage();
  await work.goto(WORK);
  await work.fill("#i", "typed, not saved");
  const other = await context.newPage();
  await other.goto(STUCK);
  return { chrome, first, work, other };
}

/** Occupy the page's main thread: for good, or for `ms`. Started from a timer, so this returns. */
async function hang(page: Page, ms?: number): Promise<void> {
  await page.evaluate(ms === undefined
    ? "setTimeout(() => { for (;;) {} }, 100)"
    : `setTimeout(() => { const end = Date.now() + ${ms}; while (Date.now() < end) {} }, 100)`);
  await sleep(400);
}

async function main() {
  // ── A tab that never answers again ───────────────────────────────────────────────────────
  {
    const { chrome, first, work } = await runningBrowser();
    try {
      await hang(first.contexts()[0]!.pages().find((p) => p.url() === STUCK)!);
      const cfg = browserConfigFromEnv({ profileDir: chrome.profileDir });
      const started = Date.now();
      const second = await acquireManagedBrowser(chrome.profileDir, cfg).catch((e) => e as Error);
      const ms = Date.now() - started;
      check("the next session connects although one tab answers nothing", !(second instanceof Error), second instanceof Error ? second.message.split("\n")[0]! : `${ms} ms`);
      check("...to the same browser process, which was not replaced", alive(chrome.pid) && !(second instanceof Error) && second.cdpUrl === chrome.cdpUrl, `pid ${chrome.pid} alive: ${alive(chrome.pid)}`);
      check("the session already there keeps its connection", first.isConnected());
      const kept = await Promise.race([work.inputValue("#i"), sleep(3000).then(() => "no answer")]).catch((e) => `failed: ${(e as Error).message.split("\n")[0]}`);
      check("...and its page keeps what was typed into it", kept === "typed, not saved", String(kept));
      if (!(second instanceof Error)) {
        const open = urls(second.browser);
        check("only the tab that answered nothing was closed", open.includes(WORK) && !open.includes(STUCK), JSON.stringify(open.map((u) => u.slice(0, 50))));
        check("the session that connected is told which tab was closed, and that the rest was left alone",
          second.notes?.length === 1 && /«Stuck»/.test(second.notes[0]!) && /had stopped answering/.test(second.notes[0]!) && /other tabs were left as they were/.test(second.notes[0]!),
          JSON.stringify(second.notes));
        await second.browser.close().catch(() => {});
      }
      await first.close().catch(() => {});
    } finally {
      chrome.cleanup();
    }
  }

  // ── A tab that is only busy ──────────────────────────────────────────────────────────────
  {
    const { chrome, first, other } = await runningBrowser();
    try {
      // Longer than the short deadline a handshake gets, shorter than the wait for a stuck tab.
      await hang(other, 6000);
      const cfg = browserConfigFromEnv({ profileDir: chrome.profileDir });
      const second = await acquireManagedBrowser(chrome.profileDir, cfg).catch((e) => e as Error);
      check("with a tab busy for a few seconds the next session still connects, to the same browser",
        !(second instanceof Error) && alive(chrome.pid), second instanceof Error ? second.message.split("\n")[0]! : "");
      if (!(second instanceof Error)) {
        check("...and the busy tab is waited for, not closed", urls(second.browser).includes(STUCK) && !second.notes?.length,
          JSON.stringify({ open: urls(second.browser).map((u) => u.slice(0, 40)), notes: second.notes }));
        await second.browser.close().catch(() => {});
      }
      await first.close().catch(() => {});
    } finally {
      chrome.cleanup();
    }
  }

  // ── The user's own browser ───────────────────────────────────────────────────────────────
  {
    const { chrome, first, other } = await runningBrowser();
    try {
      await hang(other);
      const cfg = browserConfigFromEnv({ profileDir: chrome.profileDir, attached: true });
      const refused = await acquireManagedBrowser(chrome.profileDir, cfg).then(() => null, (e) => (e as Error).message);
      check("in the user's own browser the stuck tab is named, not closed",
        !!refused && /one of its tabs does not/.test(refused) && /«Stuck»/.test(refused) && /will not be force-closed/.test(refused), String(refused).slice(0, 300));
      const targets = await (await fetch(`${chrome.cdpUrl}/json/list`)).json() as Array<{ type: string; url: string }>;
      check("...and it is still open, in a browser that is still running",
        alive(chrome.pid) && targets.some((t) => t.type === "page" && t.url === STUCK), JSON.stringify(targets.map((t) => t.url.slice(0, 40))));
      await first.close().catch(() => {});
    } finally {
      chrome.cleanup();
    }
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall managed-stalled-tab checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
