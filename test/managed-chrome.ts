/** Regression coverage for the managed-Chrome acquisition ladder (acquire.ts):
 * cold launch publishes a port + endpoint file, a second acquire ADOPTS instead of
 * relaunching, a stale port file does not derail a launch, disconnecting never
 * kills the browser (it is a device that outlives the command), and driving the
 * managed browser publishes an action journal for observers — one semantic JSON
 * line per action in actions.jsonl plus a post-action evidence shot in shots/
 * (rolling, COMPUTER_USE_SHOTS_KEEP; sequence numbers continue across sessions). */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { rmSync as rmFile } from "node:fs";
import {
  acquireManagedBrowser,
  actionsFileFor,
  browserPids,
  endpointFileFor,
  killByProfileDir,
  pingDevTools,
  readDevToolsPort,
  revealFlagFor,
  userWantsVisible,
} from "../src/platform/browser/acquire.ts";
import { BrowserDriver } from "../src/platform/browser/driver.ts";
import { chromium } from "playwright-core";
import { sleep } from "./helpers.ts";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "computer-use-managed-"));
  const endpointFile = endpointFileFor(profile);
  const previousWindow = process.env.COMPUTER_USE_WINDOW;
  const previousShotsKeep = process.env.COMPUTER_USE_SHOTS_KEEP;
  process.env.COMPUTER_USE_WINDOW = "offscreen";
  delete process.env.COMPUTER_USE_SHOTS_KEEP; // journal shots under test run on the default cap

  try {
    // A stale port file from a "previous" browser must not send the launch to a dead endpoint.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(profile, "DevToolsActivePort"), "1\n/devtools/browser/dead");

    const t0 = Date.now();
    const first = await acquireManagedBrowser(profile);
    const coldMs = Date.now() - t0;
    const port = readDevToolsPort(profile);
    check("cold launch connects", first.browser.isConnected(), `${coldMs}ms`);
    check("port file published by the NEW launch", port !== null && port !== 1, `port ${port}`);
    check("endpoint file written", existsSync(endpointFile), endpointFile);
    if (existsSync(endpointFile)) {
      const ep = JSON.parse(readFileSync(endpointFile, "utf8")) as { port: number; profileDir: string };
      check("endpoint names this browser", ep.port === port && ep.profileDir === profile);
    }

    // Disconnecting is not closing: the browser outlives the caller so the next one can adopt.
    await first.browser.close();
    check("browser survives disconnect", port !== null && (await pingDevTools(port!)));

    const t1 = Date.now();
    const second = await acquireManagedBrowser(profile);
    const adoptMs = Date.now() - t1;
    check("second acquire ADOPTS the same browser", readDevToolsPort(profile) === port, `${adoptMs}ms`);
    check("adopt is an attach, not a launch", adoptMs < 2000, `${adoptMs}ms`);
    check("acquire reports its profileDir", second.profileDir === profile);
    await second.browser.close();

    // Driving the managed browser through the DRIVER publishes action points for
    // observers: one JSON line per successful action, next to endpoint.json.
    const previousProfile = process.env.COMPUTER_USE_PROFILE_DIR;
    const previousCdp = process.env.COMPUTER_USE_CDP_URL;
    process.env.COMPUTER_USE_PROFILE_DIR = profile;
    delete process.env.COMPUTER_USE_CDP_URL;
    try {
      // Dead fallback endpoint so the driver cannot attach to a developer's own :9222
      // Chrome — the managed path (which adopts the browser above) is the one under test.
      const driver = new BrowserDriver(undefined, "http://127.0.0.1:9");
      const nav = await driver.perform("open_url", { url: "data:text/html,<title>actions</title><button>hi</button>" });
      const clicked = await driver.perform("click", { x: 40, y: 40 });
      check("driver drives the managed browser", nav.ok && clicked.ok);
      // The append is fire-and-forget by contract, so poll briefly instead of racing it.
      type ActionLine = {
        kind?: string; x?: unknown; y?: unknown; url?: string; ok?: boolean; note?: string;
        name?: string; text?: string; chord?: string; direction?: string; to?: string;
        target?: string; shot?: string; auto?: boolean;
      };
      /** Newest journal line matching pred, polling because appends are asynchronous. */
      const lastMatching = async (pred: (l: ActionLine) => boolean): Promise<ActionLine | null> => {
        for (const deadline = Date.now() + 4000; Date.now() < deadline; await sleep(50)) {
          try {
            const lines = readFileSync(actionsFileFor(profile), "utf8").trim().split("\n");
            for (let i = lines.length - 1; i >= 0; i--) {
              const parsed = JSON.parse(lines[i]!) as ActionLine;
              if (pred(parsed)) return parsed;
            }
          } catch { /* not written yet */ }
        }
        return null;
      };
      const runDir = dirname(actionsFileFor(profile));
      const shotsDir = join(runDir, "shots");
      const seqOf = (shot?: string) => Number(/(\d+)\.jpg$/.exec(shot ?? "")?.[1] ?? -1);

      const lastLine = await lastMatching((l) => l.kind === "click");
      check("actions.jsonl records the click", lastLine?.kind === "click", JSON.stringify(lastLine));
      check("click line carries numeric x/y", typeof lastLine?.x === "number" && typeof lastLine?.y === "number");
      check("click line carries the dispatch verdict ok:true", lastLine?.ok === true);

      // Every journal line references an evidence shot of the page after the action, and the
      // file is on disk by the time the line is readable (.jpg per screenshotMimeType).
      check("click line references an evidence shot", typeof lastLine?.shot === "string" && /^shots\/\d+\.jpg$/.test(lastLine.shot), lastLine?.shot ?? "(none)");
      if (typeof lastLine?.shot === "string") {
        const shotPath = join(runDir, lastLine.shot);
        check("the shot file exists where the line points", existsSync(shotPath), shotPath);
        const magic = readFileSync(shotPath);
        check("the shot is a real JPEG", magic[0] === 0xff && magic[1] === 0xd8, `magic ${magic[0]?.toString(16)}${magic[1]?.toString(16)}`);
      }

      // A name-grounded click journals the element name it targeted, plus the located
      // element's center as x/y (captured before the click runs).
      await driver.perform("click", { name: "hi" });
      const named = await lastMatching((l) => l.kind === "click" && l.name === "hi");
      check("named click journals the element name", named !== null, JSON.stringify(named));
      check("named click still carries the located point", typeof named?.x === "number" && typeof named?.y === "number");

      // set_text journals what it wrote — verbatim, the text is behavioral evidence.
      await driver.perform("set_text", { text: "journal me" });
      const typed = await lastMatching((l) => l.kind === "set_text");
      check("set_text line carries the text", typed?.text === "journal me", JSON.stringify(typed));

      // A failed dispatch is journaled too: ok:false with the reason.
      const failed = await driver.perform("click", { ref: "e999" });
      const failLine = await lastMatching((l) => l.kind === "click" && l.ok === false);
      check("a failed dispatch is journaled as ok:false + note", !failed.ok && typeof failLine?.note === "string", JSON.stringify(failLine));

      // Rolling shot cleanup: with COMPUTER_USE_SHOTS_KEEP=3, only the 3 newest shots survive
      // (numbering keeps growing — files are pruned, the sequence is not reset).
      process.env.COMPUTER_USE_SHOTS_KEEP = "3";
      try {
        await driver.perform("scroll", { direction: "down" });
        await driver.perform("scroll", { direction: "up" });
        await driver.perform("scroll", { to: "top" });
        const jumped = await lastMatching((l) => l.kind === "scroll" && l.to === "top");
        check("scroll lines carry direction/to", jumped?.to === "top" && (await lastMatching((l) => l.kind === "scroll" && l.direction === "up")) !== null, JSON.stringify(jumped));
        const kept = readdirSync(shotsDir).filter((n) => /^\d+\.jpg$/.test(n));
        check("shots/ is pruned to COMPUTER_USE_SHOTS_KEEP", kept.length === 3, `${kept.length} kept: ${kept.sort().join(",")}`);
        if (typeof jumped?.shot === "string") check("the newest shot survives the prune", existsSync(join(runDir, jumped.shot)), jumped.shot);
      } finally {
        delete process.env.COMPUTER_USE_SHOTS_KEEP;
      }

      // COMPUTER_USE_SHOTS_KEEP=0 disables screenshots entirely: no shot field on new lines, and
      // the shots directory is not even (re)created.
      rmSync(shotsDir, { recursive: true, force: true });
      process.env.COMPUTER_USE_SHOTS_KEEP = "0";
      try {
        await driver.perform("scroll", { direction: "down" });
        const bare = await lastMatching((l) => l.kind === "scroll" && l.direction === "down" && !l.shot);
        check("COMPUTER_USE_SHOTS_KEEP=0: the line has no shot field", bare !== null && bare.ok === true, JSON.stringify(bare));
        check("COMPUTER_USE_SHOTS_KEEP=0: no shots directory is created", !existsSync(shotsDir));
      } finally {
        delete process.env.COMPUTER_USE_SHOTS_KEEP;
      }

      // CLOSE DRAINS THE JOURNAL — the last action of a run is the one an auditor reads
      // first, and its shot is taken through the page handle close() drops. A separate
      // driver so the one under test above keeps its connection: close() only disconnects,
      // the managed browser outlives it.
      {
        const exiting = new BrowserDriver(undefined, "http://127.0.0.1:9");
        await exiting.perform("open_url", { url: "data:text/html,<title>drain</title><button>bye</button>" });
        const before = readFileSync(actionsFileFor(profile), "utf8").trim().split("\n").length;
        await exiting.perform("click", { x: 40, y: 40 });
        await exiting.close();
        // No polling on purpose: after close() returns, the line must ALREADY be readable.
        const lines = readFileSync(actionsFileFor(profile), "utf8").trim().split("\n");
        const landed = lines.slice(before).map((l) => JSON.parse(l) as ActionLine);
        const lastClick = landed.reverse().find((l) => l.kind === "click") ?? null;
        check("close() lands the pending journal line before disconnecting", lastClick !== null, JSON.stringify(landed));
        check("the drained line still carries its evidence shot",
          typeof lastClick?.shot === "string" && existsSync(join(runDir, lastClick.shot)), lastClick?.shot ?? "(none)");
      }

      // BACKGROUND POSTURE — the guarantee the product makes: the window stays OFF-SCREEN no
      // matter what an action does, unless the user asked to see it. Position is asserted (it is
      // deterministic); focus is only reported, because Chrome also claims focus on its own
      // during startup and a focus assertion would be flaky rather than wrong.
      const front = (): string => {
        try {
          return execFileSync("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: "utf8" }).trim();
        } catch { return "?"; }
      };
      // Re-reads the CURRENT port and opens a fresh browser-level session every time: the
      // browser under test gets killed and relaunched below, so a cached port or connection
      // would answer ECONNREFUSED rather than the truth.
      const windowLeft = async (): Promise<number> => {
        const live = readDevToolsPort(profile);
        if (live === null) return Number.NaN;
        const url = `http://127.0.0.1:${live}`;
        const list = (await (await fetch(`${url}/json/list`)).json()) as Array<{ id: string; type: string; url: string }>;
        const target = list.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
        if (!target) return Number.NaN;
        const conn = await chromium.connectOverCDP(url, { timeout: 5000 });
        try {
          const session = await conn.newBrowserCDPSession();
          const { windowId } = await session.send("Browser.getWindowForTarget", { targetId: target.id }) as { windowId: number };
          const { bounds } = await session.send("Browser.getWindowBounds", { windowId }) as { bounds: { left: number } };
          await session.detach().catch(() => {});
          return bounds.left;
        } finally {
          await conn.close().catch(() => {});
        }
      };

      // A page that opens a NEW TAB on click is the real-world case (a search result with
      // target=_blank): Chrome raises the window for the new tab, and nothing can stop that at
      // the source — so the driver must put the window back.
      await driver.perform("open_url", { url: "data:text/html,<title>bg</title><a id=x href='data:text/html,<title>t2</title>' target=_blank>go</a>" });
      const leftBefore = await windowLeft();
      check("the window starts off-screen", leftBefore <= -200, `left ${leftBefore}`);
      const frontBefore = front();
      const pagesBefore = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string }>).filter((t) => t.type === "page").length;
      await driver.perform("click", { name: "go" });
      const leftAfter = await windowLeft();
      check("a page-opened tab does not leave the window on-screen", leftAfter <= -200, `left ${leftAfter}`);
      // A target=_blank click must not open a tab at all: tab creation is what makes Chrome
      // frontmost, and nothing after the fact can undo that.
      const pagesAfter = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string }>).filter((t) => t.type === "page").length;
      check("a target=_blank click opens no new tab in background mode", pagesAfter === pagesBefore, `${pagesBefore} → ${pagesAfter} page targets`);
      console.log(`      (focus, observed only: ${frontBefore} → ${front()})`);

      // Switching tabs must not raise the browser either: `page.bringToFront()` activates the
      // whole application.
      const beforeTabSwitch = await windowLeft();
      const targets = await driver.listTargets();
      if (targets[0]) await driver.focusTarget(targets[0].id);
      check("switching tabs leaves the window in the background", (await windowLeft()) <= -200, `left ${beforeTabSwitch} → ${await windowLeft()}`);
      // Tab switches are journaled with the tab id — an observer cannot follow the run if
      // the page changes under it silently. `!l.auto` picks the REQUESTED switch: the driver
      // also journals the moves it makes on its own (a tab it opened became real, the tab it
      // was on closed) as focus lines carrying `auto: true` and no target.
      const focusLine = await lastMatching((l) => l.kind === "focus" && !l.auto);
      check("focus line carries the target id", focusLine?.target === targets[0]?.id && focusLine?.ok === true, JSON.stringify(focusLine));
      const autoFocus = await lastMatching((l) => l.kind === "focus" && l.auto === true);
      check("an unrequested surface move is journaled as auto, with no target",
        autoFocus !== null && autoFocus.target === undefined, JSON.stringify(autoFocus));

      // The user's reveal flag is the ONE thing that overrides background posture.
      writeFileSync(revealFlagFor(profile), "");
      check("reveal flag is read as 'the user is looking'", userWantsVisible(profile));
      rmFile(revealFlagFor(profile), { force: true });

      // The USER closes the browser mid-session: the driver reopens one IN THE BACKGROUND (no
      // window on the user's screen) and carries on, telling the model what happened.
      await killByProfileDir(profile);
      const after = await driver.perform("open_url", { url: "data:text/html,<title>reopened</title>" });
      check("a closed browser is reopened, not a dead end", after.ok, after.note?.slice(0, 60) ?? "");
      check("the model is told the browser had been closed", /had been closed/.test(after.note ?? ""));
      check("a replacement browser is running", (await browserPids(profile)).length > 0);
      const reopenedLeft = await windowLeft();
      check("the replacement is in the background too", reopenedLeft <= -200, `left ${reopenedLeft}`);
      // The note is delivered exactly once — a second action must not repeat it.
      const again = await driver.perform("open_url", { url: "data:text/html,<title>x</title>" });
      check("the note is not repeated", !/had been closed/.test(again.note ?? ""), again.note ?? "(no note)");
      await driver.close();

      // COMPUTER_USE_TAB=reuse — an EXCLUSIVE browser's next session continues the most recent
      // working tab (a leased browser runs one errand after another; page state IS the
      // continuity). The default stays new-tab-per-session: on a shared browser the open
      // tab is someone else's work in progress.
      const d2 = new BrowserDriver(undefined, "http://127.0.0.1:9");
      const defTargets = await d2.listTargets();
      check(
        "default: a new session takes a fresh blank tab, not the working one",
        defTargets.find((t) => t.active)?.title === "about:blank",
        JSON.stringify(defTargets.map((t) => `${t.active ? "*" : ""}${t.title}`)),
      );
      await d2.close();
      process.env.COMPUTER_USE_TAB = "reuse";
      try {
        const d3 = new BrowserDriver(undefined, "http://127.0.0.1:9");
        const reuseTargets = await d3.listTargets();
        check(
          // The browser was killed and reopened above, so the sole surviving working tab
          // is "x" — reuse must land there instead of taking the blank d2 left behind.
          "COMPUTER_USE_TAB=reuse continues the most recent working tab",
          reuseTargets.find((t) => t.active)?.title === "x",
          JSON.stringify(reuseTargets.map((t) => `${t.active ? "*" : ""}${t.title}`)),
        );
        // Shot numbering continues across sessions: d3 is a NEW driver instance, so its
        // first shot must resume after the highest sequence already on disk, not restart at 1.
        const maxBefore = Math.max(0, ...readdirSync(shotsDir).map((n) => Number(/^(\d+)\.jpg$/.exec(n)?.[1] ?? 0)));
        await d3.perform("keys", { chord: "End" });
        const keysLine = await lastMatching((l) => l.kind === "keys");
        check("keys line carries the chord", keysLine?.chord === "End", JSON.stringify(keysLine));
        check("shot numbering continues across sessions", seqOf(keysLine?.shot) > maxBefore, `${seqOf(keysLine?.shot)} > ${maxBefore}`);
        await d3.close();
      } finally {
        delete process.env.COMPUTER_USE_TAB;
      }
    } finally {
      if (previousProfile === undefined) delete process.env.COMPUTER_USE_PROFILE_DIR;
      else process.env.COMPUTER_USE_PROFILE_DIR = previousProfile;
      if (previousCdp !== undefined) process.env.COMPUTER_USE_CDP_URL = previousCdp;
    }
  } finally {
    process.env.COMPUTER_USE_WINDOW = previousWindow;
    if (previousShotsKeep !== undefined) process.env.COMPUTER_USE_SHOTS_KEEP = previousShotsKeep;
    await killByProfileDir(profile);
    check("teardown by identity leaves no pids", (await browserPids(profile)).length === 0);
    rmSync(profile, { recursive: true, force: true });
    rmSync(dirname(endpointFile), { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} failure(s)` : "\nall managed-chrome checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL  managed-chrome crashed:", e);
  process.exit(1);
});
