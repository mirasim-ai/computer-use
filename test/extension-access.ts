/**
 * What the user lets the agent reach, enforced by the extension (extension/access.js), end to end
 * against a real Chromium with the extension loaded and the bridge in front of it:
 *
 *  - the default scope lists only the mirasim group and the agent's own tabs: a user's tab is
 *    invisible until handed over (joining the group), and taken back (leaving it) it is detached
 *    and unlisted again; the toolbar click is a hand-over only where there is something to hand;
 *  - the site rules: a blocked site is neither opened, navigated to nor read, an iframe from it
 *    is let go of, its cookies are filtered out, and wiping every cookie is refused;
 *  - the allow-only list, the pause, and the `ask` scope's yes and no in the ask window;
 *  - the panel renders what the worker reports and its pause button pauses.
 *
 * test/extension-bridge.ts pins the rest of the bridge in the `all` scope.
 */

import { chromium, type Page } from "playwright-core";
import { BridgeServer } from "../src/platform/browser/bridge/server.ts";
import { MIRASIM_EXTENSION_ID, extensionDir } from "../src/platform/browser/bridge/extension-id.ts";
import { createDriver } from "../src/platform/registry.ts";
import { spawnChrome, sleep } from "./helpers.ts";
import { RawCdp, evalInExtension, findLoadableChromium, servePages, setAccess } from "./rig.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** The message a refused call ends with, or "" when it went through. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "";
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

async function main() {
  const binary = findLoadableChromium();
  if (!binary) {
    console.log("SKIP  extension-access: no Chromium-flavored binary (branded Chrome cannot --load-extension); npx playwright install chromium to enable");
    return;
  }

  const pages = await servePages({
    "/agent": "<title>agent page</title><h1>AGENT</h1>",
    "/user": "<title>user page</title><h1>THE USER'S PAGE</h1>",
    "/second": "<title>second user page</title>",
    "/third": "<title>third user page</title>",
    "/cookie": "<title>cookie</title><script>document.cookie = 'mark=' + location.hostname + '; max-age=3600; path=/'</script>",
    "/secret": "<title>secret</title><h1 id=s>SECRET</h1>",
  });
  // Two sites on one server: 127.0.0.1 is the agent's, localhost plays the bank.
  const url = (path: string) => pages.url(path);
  const bank = (path: string) => pages.url(path).replace("127.0.0.1", "localhost");
  const linkPage = `<title>link</title><a id=go href="${bank("/secret")}">go</a>`;
  const framedPage = `<title>framed</title><h1>OUTER</h1><iframe id=f src="${bank("/secret")}"></iframe>`;
  const routes = await servePages({ "/link": linkPage, "/framed": framedPage });

  const chrome = await spawnChrome({ binary, extraArgs: [`--load-extension=${extensionDir()}`] });
  const server = new BridgeServer({
    log: () => {},
    openUrl: async (target) => {
      const probe = await chromium.connectOverCDP(chrome.cdpUrl);
      try {
        await (await probe.contexts()[0]!.newPage()).goto(target).catch(() => {});
      } finally {
        await probe.close();
      }
    },
  });
  await server.start();

  const raw = await RawCdp.connect(chrome.cdpUrl);
  const ext = (expression: string) => evalInExtension(raw, expression);
  /** A tab the USER opens: made by the worker itself, never through the bridge. */
  const userTab = (target: string) => ext(`chrome.tabs.create({ url: ${JSON.stringify(target)}, active: false }).then((t) => t.id)`) as Promise<number>;
  const listed = async () => ((await (await fetch(`${server.cdpUrl()}/json/list`)).json()) as Array<{ id: string; url: string }>);
  const debuggerOn = (tabId: number) =>
    ext(`chrome.debugger.getTargets().then((ts) => ts.some((t) => t.tabId === ${tabId} && t.attached))`) as Promise<boolean>;
  const intoGroup = (tabId: number) => ext(`(async () => {
    const [g] = await chrome.tabGroups.query({ title: "mirasim" });
    if (g) await chrome.tabs.group({ groupId: g.id, tabIds: [${tabId}] });
    else { const id = await chrome.tabs.group({ tabIds: [${tabId}] }); await chrome.tabGroups.update(id, { title: "mirasim" }); }
    return true;
  })()`);
  const popupOf = (tabId: number) => ext(`chrome.action.getPopup({ tabId: ${tabId} })`) as Promise<string>;
  const badgeOf = (tabId: number) => ext(`chrome.action.getBadgeText({ tabId: ${tabId} })`) as Promise<string>;
  const log = () => ext(`chrome.storage.session.get("mirasim-access-state").then((v) => v["mirasim-access-state"]?.log ?? [])`) as Promise<Array<{ reason: string; url?: string }>>;
  const setPaused = (paused: boolean) => ext(`chrome.storage.session.get("mirasim-access-state").then((v) =>
    chrome.storage.session.set({ "mirasim-access-state": { ...(v["mirasim-access-state"] ?? {}), paused: ${paused} } })).then(() => true)`);

  let browser: import("playwright-core").Browser | null = null;
  try {
    await setAccess(raw, {}); // the defaults, as a fresh install (or an upgrade) has them
    const userId = await userTab(url("/user"));
    await server.ensureExtension();
    browser = await chromium.connectOverCDP(server.cdpUrl());
    const ctx = browser.contexts()[0]!;

    // ── The default scope: the group and the agent's own tabs ─────────────
    const agent = await ctx.newPage();
    await agent.goto(url("/agent"));
    check("the agent's own tab works under the default scope", (await agent.title()) === "agent page");
    let urls = (await listed()).map((t) => t.url);
    check("a tab the user never handed over is not listed", !urls.includes(url("/user")), JSON.stringify(urls));
    check("...and has no debugger", !(await debuggerOn(userId)));
    check("the toolbar click hands over a tab outside the group (no popup there)", (await popupOf(userId)) === "");
    const agentTabId = await ext(`chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(url("/agent"))})?.id)`) as number;
    check("...and opens the panel on one the agent holds", (await popupOf(agentTabId)).endsWith("/panel.html"));
    check("the badge marks the tab the agent holds", (await badgeOf(agentTabId)) === "✓", await badgeOf(agentTabId));

    await intoGroup(userId);
    await sleep(800);
    urls = (await listed()).map((t) => t.url);
    check("handed over (into the group), the user's tab is listed", urls.includes(url("/user")), JSON.stringify(urls));
    check("...and its click opens the panel now", (await popupOf(userId)).endsWith("/panel.html"));

    // Bind it the way a client does, then take it back: detached and gone from the list.
    const userTarget = (await listed()).find((t) => t.url === url("/user"))!;
    const bridgeCdp = await RawCdp.connect(server.cdpUrl());
    const { sessionId } = await bridgeCdp.send("Target.attachToTarget", { targetId: userTarget.id, flatten: true });
    check("a client can attach a handed-over tab", !!sessionId && (await debuggerOn(userId)));
    await ext(`chrome.tabs.ungroup(${userId}).then(() => true)`);
    await sleep(800);
    check("dragged out of the group, the tab is detached", !(await debuggerOn(userId)));
    urls = (await listed()).map((t) => t.url);
    check("...and no longer listed", !urls.includes(url("/user")), JSON.stringify(urls));
    bridgeCdp.close();

    // ── Site rules ───────────────────────────────────────────────────────
    await setAccess(raw, { blocked: ["localhost"] });
    await sleep(300);
    const goBank = await refusal(() => agent.goto(bank("/secret")));
    check("navigating to a blocked site is refused with the reason", goBank.includes("blocked by the user's Mirasim site rules"), goBank.slice(0, 160));
    const newBank = await refusal(async () => {
      const p = await ctx.newPage();
      await p.goto(bank("/secret"));
    });
    check("...and so is opening it in a new tab", newBank.includes("blocked by the user's Mirasim site rules"), newBank.slice(0, 160));

    // A link the page follows is not a command to refuse: the tab is taken away as it lands.
    const linker = await ctx.newPage();
    await linker.goto(routes.url("/link"));
    const linkerId = await ext(`chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(routes.url("/link"))})?.id)`) as number;
    await linker.click("#go").catch(() => {});
    await sleep(1200);
    const linkerTab = await ext(`chrome.tabs.get(${linkerId}).then((t) => t.url)`) as string;
    check("(the link did land on the blocked site)", linkerTab === bank("/secret"), linkerTab);
    check("following a link onto a blocked site detaches the tab", !(await debuggerOn(linkerId)));
    check("...unlists it", !(await listed()).some((t) => t.url === bank("/secret")));
    check("...and the page is gone from the client", linker.isClosed());
    check("...and the refusal is logged for the panel", (await log()).some((e) => e.reason === "site-blocked" && e.url === bank("/secret")));
    check("the badge marks the blocked tab", (await badgeOf(linkerId)) === "×");

    // An iframe from the blocked site: the page loads, the frame stays out of reach.
    const framed = await ctx.newPage();
    await framed.goto(routes.url("/framed"));
    check("a page framing a blocked site still loads", (await framed.textContent("h1")) === "OUTER");
    await sleep(500);
    const { targetInfos: frames } = await raw.send("Target.getTargets");
    check("...its blocked iframe too, for the user", frames.some((t: { type: string; url: string }) => t.type === "iframe" && t.url === bank("/secret")),
      JSON.stringify(frames.filter((t: { type: string }) => t.type === "iframe").map((t: { url: string }) => t.url)));
    const frame = framed.frames().find((f) => f !== framed.mainFrame());
    const inside = frame
      ? await Promise.race([frame.evaluate("document.body.innerText").catch((e) => `refused: ${e}`), sleep(3000).then(() => "timed out")])
      : "no frame";
    check("...but what the blocked frame shows never reaches the agent", !String(inside).includes("SECRET"), String(inside).slice(0, 120));

    // Cookies: a blocked site's are filtered out; wiping every site's is refused.
    await setAccess(raw, {});
    const cookieAgent = await ctx.newPage();
    await cookieAgent.goto(url("/cookie"));
    await cookieAgent.goto(bank("/cookie"));
    const { cookies: all } = await raw.send("Storage.getCookies");
    check("(both sites did set a cookie)", ["127.0.0.1", "localhost"].every((d) => all.some((c: { domain: string }) => c.domain === d)),
      JSON.stringify(all.map((c: { domain: string }) => c.domain)));
    await setAccess(raw, { blocked: ["localhost"] });
    await sleep(300);
    const cookies = await ctx.cookies();
    const domains = cookies.map((c) => c.domain);
    check("the agent reads its own site's cookies", domains.includes("127.0.0.1"), JSON.stringify(domains));
    check("...but not a blocked site's", !domains.includes("localhost"), JSON.stringify(domains));
    const wipe = await refusal(() => ctx.clearCookies());
    check("wiping every cookie is refused while access is limited", wipe.includes("Clearing every browser cookie is refused"), wipe.slice(0, 160));

    // ── Allow-only ───────────────────────────────────────────────────────
    await setAccess(raw, { allowOnly: true, allowed: ["127.0.0.1"] });
    await sleep(300);
    const offList = await refusal(() => agent.goto(bank("/agent")));
    check("allow-only refuses a site off the list", offList.includes("not on the user's Mirasim allow list"), offList.slice(0, 160));
    await agent.goto(url("/agent"));
    check("...and lets the listed one through", (await agent.title()) === "agent page");

    // ── Pause ────────────────────────────────────────────────────────────
    await setAccess(raw, {});
    await setPaused(true);
    await sleep(500);
    check("pausing lets go of every tab the agent holds", !(await debuggerOn(agentTabId)) && agent.isClosed());
    check("...which stay listed for after the resume", (await listed()).some((t) => t.url === url("/agent")));
    const paused = await refusal(async () => (await ctx.newPage()).goto(url("/agent")));
    check("a paused agent's commands are refused, saying so", paused.includes("paused the agent"), paused.slice(0, 160));
    const pausedAttach = await refusal(async () => {
      const c = await RawCdp.connect(server.cdpUrl());
      try {
        await c.send("Target.attachToTarget", { targetId: (await listed()).find((t) => t.url === url("/agent"))!.id, flatten: true });
      } finally {
        c.close();
      }
    });
    check("...attaching a tab again included", pausedAttach.includes("paused the agent"), pausedAttach.slice(0, 160));
    check("the badge shows the pause", (await badgeOf(agentTabId)) === "II", await badgeOf(agentTabId));
    await setPaused(false);
    await sleep(300);
    const resumedPage = await ctx.newPage();
    await resumedPage.goto(url("/agent"));
    check("resumed, the agent works again", (await resumedPage.evaluate("1 + 1")) === 2);

    // ── Ask ──────────────────────────────────────────────────────────────
    await setAccess(raw, { scope: "ask" });
    const secondId = await userTab(url("/second"));
    await sleep(800);
    const second = (await listed()).find((t) => t.url === url("/second"));
    check("ask scope lists the user's tabs", !!second);
    const askCdp = await RawCdp.connect(server.cdpUrl());
    const askAnswer = (allow: boolean) => (async () => {
      for (let i = 0; i < 50; i++) {
        const { targetInfos } = await raw.send("Target.getTargets");
        const win = targetInfos.find((t: { url: string }) => t.url.startsWith(`chrome-extension://${MIRASIM_EXTENSION_ID}/ask.html`));
        if (win) {
          const { sessionId: s } = await raw.send("Target.attachToTarget", { targetId: win.targetId, flatten: true });
          await sleep(200);
          await raw.send("Runtime.evaluate", { expression: `document.getElementById(${JSON.stringify(allow ? "allow" : "deny")}).click()` }, s);
          return true;
        }
        await sleep(100);
      }
      return false;
    })();
    const [askedYes, attachedYes] = await Promise.all([askAnswer(true), askCdp.send("Target.attachToTarget", { targetId: second!.id, flatten: true }).then(() => "", (e) => String(e))]);
    check("attaching a tab outside the group opens the ask window", askedYes);
    check("...and goes through once the user allows it", attachedYes === "" && (await debuggerOn(secondId)), attachedYes);

    const thirdId = await userTab(url("/third"));
    await sleep(800);
    const third = (await listed()).find((t) => t.url === url("/third"));
    const [askedNo, attachedNo] = await Promise.all([askAnswer(false), askCdp.send("Target.attachToTarget", { targetId: third!.id, flatten: true }).then(() => "", (e) => String(e))]);
    check("...and is refused, saying so, when the user declines", askedNo && attachedNo.includes("declined"), attachedNo.slice(0, 160));
    check("...leaving that tab without a debugger", !(await debuggerOn(thirdId)));
    askCdp.close();

    // ── What the driver tells the model ─────────────────────────────────
    await setAccess(raw, { blocked: ["localhost"] });
    await sleep(300);
    const driver = createDriver("browser", {
      cdpUrl: server.cdpUrl(), browser: { cdpUrl: server.cdpUrl(), cdpStrict: true },
      env: { ...process.env, COMPUTER_USE_CDP_URL: server.cdpUrl(), COMPUTER_USE_CDP_STRICT: "1" },
    });
    try {
      const titles = (await driver.listTargets()).map((t) => t.title);
      check("the driver lists no tab the user kept back", !titles.includes("user page"), JSON.stringify(titles));
      const miss = driver.explainMiss("user page") ?? "";
      check("...and a miss says why and how to get it handed over",
        miss.includes("Mirasim toolbar icon") && miss.includes("blocked in Mirasim"), miss.slice(0, 200));
      await driver.perform("open_url", { url: url("/agent") });
      await setPaused(true);
      await sleep(300);
      const pausedJs = await driver.perform("run_js", { code: "1 + 1" }).then((r) => r.note ?? JSON.stringify(r), (e) => String(e));
      check("a paused agent's driver says the user paused it, not that the page navigated",
        pausedJs.includes("paused the agent"), pausedJs.slice(0, 200));
      await setPaused(false);
      await sleep(300);
      // The pause let go of the driver's tab: binding it again is what the model does next.
      const mine = (await driver.listTargets()).find((t) => t.own && t.title === "agent page");
      if (mine) {
        await driver.focusTarget(mine.id);
        await driver.prepareTarget();
      }
      const resumed = await driver.perform("run_js", { code: "1 + 1" });
      check("...and works again once resumed and bound", resumed.value === 2, JSON.stringify(resumed).slice(0, 200));
    } finally {
      await driver.close();
    }

    // ── The panel ────────────────────────────────────────────────────────
    await setAccess(raw, {});
    const shown = await ctx.newPage();
    await shown.goto(url("/agent"));
    const viewer = await chromium.connectOverCDP(chrome.cdpUrl);
    const panel: Page = await viewer.contexts()[0]!.newPage();
    await panel.goto(`chrome-extension://${MIRASIM_EXTENSION_ID}/panel.html`);
    await panel.waitForSelector("#status:not(:empty)");
    check("the panel shows the connection", ((await panel.textContent("#status")) ?? "").length > 0, await panel.textContent("#status") ?? "");
    const footer = (await panel.textContent("#footer")) ?? "";
    check("...which bridge is on the other end", footer.includes("Computer Use"), footer);
    check("...the scope in force", await panel.isChecked('input[name="scope"][value="group"]'));
    check("...and the tabs the agent is using", ((await panel.textContent("#using")) ?? "").includes("agent page"), await panel.textContent("#using") ?? "");
    await panel.click("#pause");
    await sleep(400);
    const pausedNow = await ext(`chrome.storage.session.get("mirasim-access-state").then((v) => v["mirasim-access-state"]?.paused === true)`);
    check("the panel's pause button pauses the agent", pausedNow === true);
    await panel.click("#pause");
    await panel.click('input[name="scope"][value="all"]');
    await sleep(400);
    const scopeNow = await ext(`chrome.storage.sync.get("mirasim-access").then((v) => v["mirasim-access"]?.scope)`);
    check("choosing a scope in the panel applies it", scopeNow === "all", String(scopeNow));
    await sleep(800);
    check("...and the newly reachable tabs are listed", (await listed()).some((t) => t.url === url("/user")));
    await viewer.close();
  } finally {
    await browser?.close().catch(() => {});
    raw.close();
    server.stop();
    pages.close();
    routes.close();
    chrome.cleanup();
  }
  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
