/**
 * A self-closing click must not be reported as an ordinary failure or blindly as success.
 * The lost reply is forced with the exact call-log shape seen on Linux; real self-closing
 * clicks are also repeated to cover the race without relying on it to make this suite fail.
 */
import { chromium, type Locator } from "playwright-core";
import { clickNamingCover } from "../src/platform/chromium/actions.ts";
import { spawnChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const OPTS = { button: "left" as const, clickCount: 1 };
const callLog = (stage: "waiting" | "performing" | "done") => "locator.click: Target page, context or browser has been closed\nCall log:\n"
  + "  - waiting for locator('button')\n"
  + (stage === "waiting" ? "" : "  - performing click action\n")
  + (stage === "done" ? "  - click action done\n  - waiting for scheduled navigations to finish\n" : "");
const uncertain = (s: string) => /page closed during click dispatch/.test(s)
  && /completion is uncertain/.test(s) && /do not repeat the click/.test(s)
  && !/never received|nothing.*clicked|failed|^ok/.test(s);

async function outcome(target: Parameters<typeof clickNamingCover>[0], loc: Locator) {
  try {
    const result = await clickNamingCover(target, loc, OPTS, "e1", "Close me");
    return result?.ok ? `ok: ${result.note ?? ""}` : `refused: ${result?.note ?? "gone"}`;
  } catch (e) {
    return (e as Error).message;
  }
}

async function main() {
  const chrome = await spawnChrome({});
  const browser = await chromium.connectOverCDP(chrome.cdpUrl);
  try {
    const context = browser.contexts()[0]!;
    const opener = await context.newPage();
    await opener.setContent(`<button onclick="window.open('about:blank')">Open</button><script>window.hits = 0</script>`);
    const popup = async () => {
      const [page] = await Promise.all([context.waitForEvent("page"), opener.locator("button").click()]);
      await page.setContent(`<button onclick="opener.hits++; window.close()">Close me</button>`);
      return page;
    };

    // Reproduce the recorded Linux rejection after a real click has closed its own tab. There
    // is no page left to query the receipt on; a dispatch-start log cannot prove completion.
    const lost = await popup();
    const loc = lost.locator("button");
    let calls = 0;
    const target = {
      evaluateHandle: (fn: unknown) => loc.evaluateHandle(fn as never),
      click: async () => {
        calls++;
        await Promise.all([lost.waitForEvent("close"), loc.click().catch((e) => { if (!lost.isClosed()) throw e; })]);
        throw new Error(callLog("performing"));
      },
    };
    const missing = await outcome(target, loc);
    check("a real self-close with a lost completion reply is explicitly uncertain", uncertain(missing), missing);
    check("the uncertain click is never retried", calls === 1 && await opener.evaluate("window.hits") === 1, `${calls} attempt(s)`);

    const completed = await popup();
    const completedLoc = completed.locator("button");
    const done = await outcome({ click: async () => {
      await completed.close();
      throw new Error(callLog("done"));
    } }, completedLoc);
    check("a dispatch-complete log is reported as clicked, with the closure stated",
      done === "ok: clicked — the page closed before the click call returned", done);

    const before = await popup();
    const beforeLoc = before.locator("button");
    const waiting = callLog("waiting");
    const notSent = await outcome({ click: async () => { await before.close(); throw new Error(waiting); } }, beforeLoc);
    check("closure before dispatch is never promoted to a click", notSent === waiting, notSent.split("\n")[0]);

    const open = await popup();
    const openLoc = open.locator("button");
    const disconnected = callLog("performing");
    const stillOpen = await outcome({ click: async () => { throw new Error(disconnected); } }, openLoc);
    check("a connection error alone does not claim the page closed or the click succeeded", stillOpen === disconnected && !open.isClosed());
    await open.close();

    const delayed = await popup();
    const delayedLoc = delayed.locator("button");
    const frame = delayed.mainFrame();
    const probe = frame.evaluate.bind(frame);
    // The timeout happened while the page was open; the page disappears during the follow-up
    // probe. No receipt is available after that, and "never received" would also be false.
    frame.evaluate = (async (...args: Parameters<typeof probe>) => {
      await delayed.close();
      return probe(...args);
    }) as typeof frame.evaluate;
    const duringProbe = await outcome({ click: async () => {
      throw Object.assign(new Error("locator.click: Timeout 2000ms exceeded\n  - performing click action"), { name: "TimeoutError" });
    } }, delayedLoc);
    check("closure during the follow-up probe is uncertain too", uncertain(duringProbe), duringProbe);

    const total = Number(process.argv[2] ?? 150);
    const tally = { clicked: 0, uncertain: 0, other: 0 };
    for (let i = 0; i < total; i++) {
      const page = await popup();
      const result = await outcome(page.locator("button"), page.locator("button"));
      if (result.startsWith("ok:")) tally.clicked++;
      else if (uncertain(result)) tally.uncertain++;
      else { tally.other++; console.log(`unexpected close result: ${result}`); }
    }
    check(`${total} real self-closing clicks return delivery or explicit uncertainty`, tally.other === 0, JSON.stringify(tally));
    check("every real click reached the button exactly once", await opener.evaluate("window.hits") === total + 1);
  } finally {
    await browser.close().catch(() => {});
    chrome.cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall click-closes-tab checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
