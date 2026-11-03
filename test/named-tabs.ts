/**
 * Named-tab mode (`COMPUTER_USE_TAB=name:<key>`) — several drivers sharing ONE Chrome, end to end
 * against a real instance:
 *
 *  - two named surfaces get two TABS of the same browser, not two browsers;
 *  - each surface sees only ITS tab among its targets, and its page survives the other
 *    surface's navigations (no active-tab stomping, no cross-adoption of foreign tabs);
 *  - a respawned driver (same key, fresh process in real life) re-adopts its stamped tab
 *    instead of leaking a new one per respawn;
 *  - two claims made CONCURRENTLY still get two tabs — the case sequential checks never see
 *    (the extension bridge behaves identically, so raw Chrome covers it);
 *  - a default-mode client on the same browser keeps its shared vision (all tabs listed).
 */

import { chromium } from "playwright-core";
import { BrowserDriver } from "../src/platform/browser/driver.ts";
import { spawnChrome } from "./helpers.ts";

const URL_A = `data:text/html,${encodeURIComponent("<title>alpha page</title><h1>ALPHA</h1><button>A</button>")}`;
const URL_B = `data:text/html,${encodeURIComponent("<title>beta page</title><h1>BETA</h1><button>B</button>")}`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A driver born with this COMPUTER_USE_TAB value (the field is captured at construction). */
function driverWithTab(tab: string | undefined, cdpUrl: string): BrowserDriver {
  if (tab === undefined) delete process.env.COMPUTER_USE_TAB;
  else process.env.COMPUTER_USE_TAB = tab;
  return new BrowserDriver(cdpUrl);
}

async function main() {
  const chrome = await spawnChrome({});

  try {
    const a = driverWithTab("name:alpha", chrome.cdpUrl);
    const b = driverWithTab("name:beta", chrome.cdpUrl);
    check("alpha open_url ok", (await a.perform("open_url", { url: URL_A })).ok);
    check("beta open_url ok", (await b.perform("open_url", { url: URL_B })).ok);

    // Two tabs, ONE browser: launcher's about:blank + alpha's tab + beta's tab.
    const probe = await chromium.connectOverCDP(chrome.cdpUrl);
    const countPages = () => probe.contexts()[0]!.pages().filter((p) => !p.isClosed()).length;
    check("two surfaces cost two tabs of one browser", countPages() === 3, `${countPages()} pages`);

    check("alpha stayed on its page after beta navigated", (await a.currentUrl()) === URL_A, await a.currentUrl());
    check("beta is on its own page", (await b.currentUrl()) === URL_B);

    // Ownership scoping: each surface lists exactly ITS tab, never the neighbours'.
    const aTargets = await a.listTargets();
    check("alpha lists only its own tab", aTargets.length === 1 && aTargets[0]!.title.includes("alpha"), JSON.stringify(aTargets));
    const bTargets = await b.listTargets();
    check("beta lists only its own tab", bTargets.length === 1 && bTargets[0]!.title.includes("beta"));

    // Respawn: a FRESH driver with alpha's key must re-adopt the stamped tab, not open one.
    const a2 = driverWithTab("name:alpha", chrome.cdpUrl);
    check("respawned alpha re-adopts its stamped tab", (await a2.currentUrl()) === URL_A, await a2.currentUrl());
    check("re-adoption leaked no tab", countPages() === 3, `${countPages()} pages`);
    await a2.close();

    // CONCURRENT claims. Two fresh keys, both first actions in flight at once. A claim must
    // identify its new tab by the id createTarget returns: by set difference, both drivers would
    // land on ONE tab.
    const [e, f] = [driverWithTab("name:eps", chrome.cdpUrl), driverWithTab("name:zeta", chrome.cdpUrl)];
    const [eOk, fOk] = await Promise.all([
      e.perform("open_url", { url: URL_A }),
      f.perform("open_url", { url: URL_B }),
    ]);
    check("concurrent claims both acted", eOk.ok && fOk.ok);
    check("concurrent claim: eps is on its own page", (await e.currentUrl()) === URL_A, await e.currentUrl());
    check("concurrent claim: zeta is on its own page", (await f.currentUrl()) === URL_B, await f.currentUrl());
    check("concurrent claims cost two tabs, not one", countPages() === 5, `${countPages()} pages`);
    await e.close();
    await f.close();

    // Default mode on the same browser keeps shared vision (the session_key inspection path).
    const c = driverWithTab(undefined, chrome.cdpUrl);
    const cTargets = await c.listTargets();
    check("default-mode client still sees every tab", cTargets.length >= 5, `${cTargets.length} targets`);
    await c.close();

    // Isolated-context mode (ctx:) — a simulated user's surface: same shared browser, own
    // cookie jar. The cookie needs a real http origin (data: URLs cannot set cookies), and
    // the CDP endpoint itself is one.
    const HTTP_URL = `${chrome.cdpUrl}/json/version`;
    const g = driverWithTab("ctx:ev-gamma", chrome.cdpUrl);
    const d = driverWithTab("ctx:ev-delta", chrome.cdpUrl);
    // Concurrently, for the same reason as the named pair above — picking up another actor's tab
    // would also put this surface in the wrong cookie jar.
    const [gOk, dOk] = await Promise.all([
      g.perform("open_url", { url: HTTP_URL }),
      d.perform("open_url", { url: HTTP_URL }),
    ]);
    check("gamma open_url ok", gOk.ok);
    check("delta open_url ok", dOk.ok);

    // Still ONE browser — each actor in a CDP context of its own. Playwright's wrappers
    // cannot see this (it files foreign contexts' pages under the default wrapper), so the
    // assertions ask CDP itself.
    const cdp = await probe.newBrowserCDPSession();
    const createdContexts = async () => (await cdp.send("Target.getBrowserContexts")).browserContextIds;
    check("two actors cost two contexts, zero extra Chromes", (await createdContexts()).length === 2, `${(await createdContexts()).length} created contexts`);

    // Both actors sit on the SAME url, so the stamp — not the url — is the identity.
    const pageWithStamp = async (key: string) => {
      for (const ctx of probe.contexts()) {
        for (const p of ctx.pages()) if (!p.isClosed() && String(await p.evaluate("window.name")) === `__mirasim_computer_use_tab:${key}`) return p;
      }
      throw new Error(`no page stamped ${key}`);
    };
    const cdpContextOf = async (p: import("playwright-core").Page) => {
      const s = await p.context().newCDPSession(p);
      try { return (await s.send("Target.getTargetInfo")).targetInfo.browserContextId ?? ""; }
      finally { await s.detach().catch(() => {}); }
    };

    // Cookie isolation: what gamma sets, delta (and the default context) never see.
    const gPage = await pageWithStamp("ev-gamma");
    await gPage.evaluate("document.cookie = 'actor=gamma; path=/'");
    check("gamma sees its own cookie", String(await gPage.evaluate("document.cookie")).includes("actor=gamma"));
    const dPage = await pageWithStamp("ev-delta");
    check("delta's jar is empty of gamma's cookie", !String(await dPage.evaluate("document.cookie")).includes("actor=gamma"));
    const gCtx = await cdpContextOf(gPage);
    const dCtx = await cdpContextOf(dPage);
    check("gamma and delta are different CREATED contexts", gCtx !== dCtx && (await createdContexts()).includes(gCtx) && (await createdContexts()).includes(dCtx));
    // The default context kept exactly its five tabs (launcher blank + alpha + beta + the two
    // concurrent claims). The isolated actors must have grown none of them.
    const defaultPages = async () => {
      const created = new Set(await createdContexts());
      const { targetInfos } = await cdp.send("Target.getTargets");
      return targetInfos.filter((t) => t.type === "page" && !created.has(t.browserContextId ?? "")).length;
    };
    check("default context did not grow a tab", (await defaultPages()) === 5, `${await defaultPages()} pages`);

    // Each isolated surface lists exactly ITS tab; the shared tabs stay unlisted.
    const gTargets = await g.listTargets();
    check("gamma lists only its own tab", gTargets.length === 1, JSON.stringify(gTargets.map((t) => t.title)));

    // Respawn: a fresh driver with gamma's key re-adopts the stamped tab AND its context.
    const g2 = driverWithTab("ctx:ev-gamma", chrome.cdpUrl);
    check("respawned gamma re-adopts its stamped tab", (await g2.currentUrl()) === HTTP_URL, await g2.currentUrl());
    check("re-adoption minted no context", (await createdContexts()).length === 2, `${(await createdContexts()).length} created contexts`);
    check("respawned gamma still sees gamma's cookie", String(await (await pageWithStamp("ev-gamma")).evaluate("document.cookie")).includes("actor=gamma"));
    await g2.close();

    await probe.close();
    await a.close();
    await b.close();
    await g.close();
    await d.close();
  } finally {
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nNAMED TABS OK" : `\nNAMED TABS FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
