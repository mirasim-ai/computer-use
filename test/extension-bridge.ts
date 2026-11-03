/**
 * Extension bridge, end to end against a real browser:
 *
 *  - the bridge's HTTP façade + WS relay serve a standard CDP endpoint that
 *    `chromium.connectOverCDP` accepts with no bridge-specific client code;
 *  - the extension executes the relay's chrome.* commands, and every agent tab
 *    lands in ONE "mirasim" tab group of the (simulated) user browser;
 *  - tabs OUTSIDE the group ARE visible to bridge clients, and the group
 *    says whose each tab is: the driver lists the user's too, marked `own: false`,
 *    and refuses to close them;
 *  - `newCDPSession` works (virtual sessions) and window-management commands are
 *    answered with fakes, never forwarded to the user's real window;
 *  - two CDP clients share the one browser.
 *
 * The "user's browser" is a throwaway Chromium-flavored instance because branded
 * Chrome removed `--load-extension`; the extension path is identical.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Files the upload verb hands over — their NAMES are what the page reports back, and the two
 *  routes get different ones so the second cannot pass on the first one's evidence. */
const UPLOAD_FILE = join(tmpdir(), "computer-use-bridge-by-ref.txt");
const CHOOSER_FILE = join(tmpdir(), "computer-use-bridge-by-chooser.txt");
import { chromium } from "playwright-core";
import { BridgeServer } from "../src/platform/browser/bridge/server.ts";
import { MIRASIM_EXTENSION_ID, extensionDir, extensionIdFromKey } from "../src/platform/browser/bridge/extension-id.ts";
import { createDriver } from "../src/platform/registry.ts";
import { createHarness } from "./harness.ts";
import { spawnChrome, sleep } from "./helpers.ts";
import { RawCdp, evalInExtension, findLoadableChromium, servePages } from "./rig.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  // The pinned key and the derived ID must agree, or the connect URL goes nowhere.
  const manifest = JSON.parse(readFileSync(join(extensionDir(), "manifest.json"), "utf8")) as { key: string };
  check("manifest key derives the pinned extension ID", extensionIdFromKey(manifest.key) === MIRASIM_EXTENSION_ID);

  const binary = findLoadableChromium();
  if (!binary) {
    console.log("SKIP  extension-bridge: no Chromium-flavored binary (branded Chrome cannot --load-extension); npx playwright install chromium to enable");
    return;
  }

  const pages = await servePages({
    "/bridge": "<title>bridge page</title><h1>BRIDGE</h1>",
    "/outside": "<title>outside</title><h1>USER TAB</h1><a id=pop href=/popup target=_blank>pop</a>",
    "/popup": "<title>user popup</title>",
    "/two": "<title>from client two</title>",
    "/upload": `<title>upload</title><input type=file id=f>
      <button id=pick onclick="document.getElementById('f').click()">Pick a file</button><div id=out>none</div>
      <script>document.getElementById('f').onchange=e=>{document.getElementById('out').textContent='got: '+e.target.files[0].name}</script>`,
    "/dialog": `<title>dialog</title>
      <button id=ask onclick="document.getElementById('out').textContent='answer: '+confirm('really?')">Ask</button><div id=out>none</div>`,
  });
  const PAGE_URL = pages.url("/bridge");
  const UPLOAD_URL = pages.url("/upload");
  const DIALOG_URL = pages.url("/dialog");
  const OUTSIDE_URL = pages.url("/outside");

  /** Everything the bridge said about itself — the stall probe is asserted against this. */
  const bridgeLog: string[] = [];
  const chrome = await spawnChrome({ binary, extraArgs: [`--load-extension=${extensionDir()}`] });
  const server = new BridgeServer({
    // Keep the sink wired: a stall on the extension side is the one failure the client's
    // timeout cannot explain, and the stall probe below is asserted against it.
    log: (...args: unknown[]) => {
      const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
      bridgeLog.push(line);
      console.error("[bridge]", line);
    },
    // The connect page reaches the throwaway browser through its own CDP —
    // stand-in for "spawn the Chrome binary with the URL" against a real install.
    openUrl: async (url) => {
      const probe = await chromium.connectOverCDP(chrome.cdpUrl);
      try {
        const ctx = probe.contexts()[0]!;
        const page = await ctx.newPage();
        await page.goto(url).catch(() => {}); // the SW may close the tab mid-navigation-settle
      } finally {
        await probe.close();
      }
    },
  });
  await server.start();

  let browser1: import("playwright-core").Browser | null = null;
  let browser2: import("playwright-core").Browser | null = null;
  let rawCdp: RawCdp | null = null;
  try {
    // ── Extension handshake ─────────────────────────────────────────────
    await server.ensureExtension();
    check("extension connects through the connect page", server.extensionConnected());
    // A connect opens nothing: the group appears with the agent's first tab (below), never as a
    // blank seed tab left in the user's window.
    rawCdp = await RawCdp.connect(chrome.cdpUrl);
    const atConnect = await evalInExtension(
      rawCdp,
      `(async () => {
        const groups = await chrome.tabGroups.query({ title: "mirasim" });
        const tabs = groups.length ? await chrome.tabs.query({ groupId: groups[0].id }) : [];
        return { groups: groups.length, tabs: tabs.length };
      })()`,
    );
    check("connecting opens no tab of the extension's own", atConnect.tabs === 0, JSON.stringify(atConnect));

    // ── Standard CDP client via the HTTP façade ─────────────────────────
    browser1 = await chromium.connectOverCDP(server.cdpUrl());
    const ctx1 = browser1.contexts()[0]!;
    const deadline = Date.now() + 5000;
    while (!ctx1.pages().length && Date.now() < deadline) await sleep(100);
    // Not a count: the client sees whatever the browser already had open (the rig's own
    // about:blank, the connect page until it closes itself), so `=== 1` would flake.
    check("the user's open tabs are visible to the client", ctx1.pages().length >= 1, `${ctx1.pages().length} pages`);

    // ── Drive a page end to end ─────────────────────────────────────────
    const page = await ctx1.newPage();
    await page.goto(PAGE_URL);
    check("navigation works through the bridge", (await page.title()) === "bridge page");
    check("evaluate works through the bridge", (await page.evaluate("1 + 41")) === 42);
    // ── Capture: bounded, because the frame is not the bridge's to produce ──────
    // Chrome sometimes produces no frame for this browser (tab visibility / the host's
    // compositor) — `Page.captureScreenshot` from the worker itself hangs too — and the bridge
    // cannot fix it without activating a tab and yanking the USER's focus. Callers bound their own
    // capture (SHOT_TIMEOUT_MS = 4s), so this asserts the bridge's part on either outcome: the
    // bytes when a frame exists, the named stall when it does not.
    const capturedAt = bridgeLog.length;
    const captured = await Promise.race([
      page.screenshot({ type: "jpeg", timeout: 20_000 }).then((b) => b.length).catch(() => -1),
      sleep(6000).then(() => 0),
    ]);
    if (captured > 0) {
      check("screenshot works through the bridge", captured > 1000, `${captured} bytes`);
    } else {
      console.log(`SKIP  screenshot: Chrome produced no frame for this browser (${captured === 0 ? "still pending at 6s" : "capture rejected"})`);
      check("an unanswered capture is reported by the bridge, naming the call",
        bridgeLog.slice(capturedAt).some((l) => /^slow: Page\.captureScreenshot tab=\d+ pending \d+ms$/.test(l)),
        bridgeLog.slice(capturedAt).join(" | ") || "(nothing logged)");
    }

    // ── newCDPSession + window fakes (computer-use's own-window bookkeeping) ──
    const session = await ctx1.newCDPSession(page);
    const win = await session.send("Browser.getWindowForTarget");
    // ── The two tab-scoped VERBS through the bridge ────────────────────────
    // Both must forward untouched — `upload` is DOM.setFileInputFiles / the file-chooser
    // interception, `dialog` arms a handler. A dialog BLOCKS its tab, so the risk is a timeout
    // (the bridge's 30 s, or a caller's tighter one) speaking before the answer.
    {
      writeFileSync(UPLOAD_FILE, "handed over by ref\n");
      writeFileSync(CHOOSER_FILE, "handed over through the chooser\n");
      const driver = createDriver("browser", {
        cdpUrl: server.cdpUrl(), browser: { cdpUrl: server.cdpUrl(), cdpStrict: true },
        env: { ...process.env, COMPUTER_USE_CDP_URL: server.cdpUrl(), COMPUTER_USE_CDP_STRICT: "1" },
      });
      const h = createHarness(driver);
      const say = (r: unknown) => (r as { content: Array<{ type: string; text?: string }> })
        .content.find((c) => c.type === "text")?.text ?? "";
      const refIn = (body: string, re: RegExp) => body.split("\n").find((l) => re.test(l))?.match(/^e\d+/)?.[0];
      try {
        // One load, both routes: a second navigation re-mints the refs and the observation
        // after it is a delta with no element lines to read one from.
        const up = say(await h.act("open_url", { url: UPLOAD_URL }));
        const set = say(await h.act("upload", { ref: refIn(up, /^e\d+: file/), paths: [UPLOAD_FILE] }));
        check("upload by ref forwards through the bridge", /set 1 file on/.test(set) && /got: computer-use-bridge-by-ref/.test(set),
          set.split("\n").find((l) => /NOTE|got:/.test(l)) ?? set.split("\n")[0]);

        const armed = say(await h.act("upload", { paths: [CHOOSER_FILE] }));
        check("the chooser route arms without touching the page", /the next file chooser will receive 1 file/.test(armed),
          armed.split("\n")[0]);
        const picked = say(await h.act("click", { ref: refIn(up, /"Pick a file"/) }));
        check("...and the chooser a click opens is answered with the OTHER file",
          /got: computer-use-bridge-by-chooser/.test(picked),
          picked.split("\n").find((l) => /got:|NOTE/.test(l)) ?? picked.split("\n")[0]);

        // Other CDP clients are attached (the sections above), and a JS dialog is answered by
        // whichever client's handler fires first. So the contract is not "our answer wins" but that
        // the outcome is SAID: the answer we armed, or a named race we lost.
        const dlg = say(await h.act("open_url", { url: DIALOG_URL }));
        await h.act("dialog", { answer: "accept" });
        const t0 = Date.now();
        const answered = say(await h.act("click", { ref: refIn(dlg, /"Ask"/) }));
        const ms = Date.now() - t0;
        const outcome = answered.split("\n").find((l) => /a JS dialog appeared/.test(l)) ?? "";
        check("a JS dialog through the bridge is seen and named", /a JS dialog appeared: «really\?»/.test(outcome), outcome.slice(0, 120));
        check("...and its outcome is stated — our answer, or the race we lost",
          /accepted as you asked/.test(outcome)
          || (/already answered before your accept could land/.test(outcome) && /answer:/.test(answered)),
          outcome.slice(0, 190));
        check("...well inside every caller's budget, so no timeout speaks", ms < 10_000, `${ms}ms`);
      } finally {
        await driver.close().catch(() => {});
      }
    }

    // ── The one fake that must stay a fake ─────────────────────────────────
    // `Browser.setDownloadBehavior` is answered with {} and Chrome never receives it, so a
    // download lands wherever the user's browser puts it. Pinned so a future download verb is not
    // built on that answer silently. Refusing is no fix: playwright sends it on connect, so a
    // throw fails `connectOverCDP` at the handshake.
    const dl = await session.send("Browser.setDownloadBehavior" as never, { behavior: "allow", downloadPath: "/tmp/computer-use-dl" } as never);
    check("setDownloadBehavior is answered, not forwarded — a recorded boundary, not a capability",
      JSON.stringify(dl) === "{}", JSON.stringify(dl));

    check("getWindowForTarget answers the fake window", win.windowId === 1, JSON.stringify(win));
    await session.send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { left: -4000, top: 200 } });
    check("setWindowBounds lands in the black hole", true);
    await session.detach();

    // ── The tab group is real and holds every agent tab ─────────────────
    const group = await evalInExtension(
      rawCdp!,
      `(async () => {
        const groups = await chrome.tabGroups.query({ title: "mirasim" });
        const tabs = groups.length ? await chrome.tabs.query({ groupId: groups[0].id }) : [];
        return { groups: groups.length, color: groups[0]?.color ?? null, urls: tabs.map((t) => t.url) };
      })()`,
    );
    check("exactly one mirasim tab group exists", group.groups === 1, JSON.stringify(group));
    check("the driven page lives in the group", group.urls.includes(PAGE_URL), JSON.stringify(group.urls));
    check("the group holds no blank tab nobody asked for", !group.urls.includes("about:blank"), JSON.stringify(group.urls));

    // ── Scope: a user tab outside the group is REACHABLE but not OURS ───
    // The group is not a visibility boundary, so both halves must hold: the tab shows up, and it
    // is marked as the user's so nothing closes it.
    const probe = await chromium.connectOverCDP(chrome.cdpUrl);
    const userPage = await probe.contexts()[0]!.newPage();
    await userPage.goto(OUTSIDE_URL);
    await sleep(1200);
    const seen = ctx1.pages().map((p) => p.url());
    check("a tab outside the group IS visible to the client", seen.includes(OUTSIDE_URL), JSON.stringify(seen));

    // A link the USER opens from their own tab is theirs too. With a client attached the bridge
    // attaches the new tab the moment it is created, before any navigation could mark it, so it
    // must not be swept into the group as if the agent had opened it.
    const [userPopup] = await Promise.all([userPage.waitForEvent("popup"), userPage.click("#pop")]);
    await userPopup.waitForLoadState();
    await sleep(800);
    const popupGrouped = await evalInExtension(rawCdp!, `(async () => {
      const groups = await chrome.tabGroups.query({ title: "mirasim" });
      const tabs = groups.length ? await chrome.tabs.query({ groupId: groups[0].id }) : [];
      return tabs.some((t) => t.url === ${JSON.stringify(pages.url("/popup"))});
    })()`);
    check("a link the user opens from their own tab stays outside the group", popupGrouped === false);
    await userPopup.close();
    // ...and the other half, so the check above cannot pass by grouping no popup at all: one the
    // AGENT'S page opens is the agent's.
    // A string, like the extension evals here: this project types Node, not the DOM.
    await page.evaluate(`document.body.append(Object.assign(document.createElement("a"),
      { id: "agent-pop", href: ${JSON.stringify(pages.url("/popup?agent"))}, target: "_blank", textContent: "pop" }))`);
    const [agentPopup] = await Promise.all([page.waitForEvent("popup"), page.click("#agent-pop")]);
    await agentPopup.waitForLoadState();
    await sleep(800);
    const agentPopupGrouped = await evalInExtension(rawCdp!, `(async () => {
      const groups = await chrome.tabGroups.query({ title: "mirasim" });
      const tabs = groups.length ? await chrome.tabs.query({ groupId: groups[0].id }) : [];
      return tabs.some((t) => t.url === ${JSON.stringify(pages.url("/popup?agent"))});
    })()`);
    check("a link the agent's page opens lands in the group", agentPopupGrouped === true);
    await agentPopup.close();

    const scopeDriver = createDriver("browser", {
      cdpUrl: server.cdpUrl(), browser: { cdpUrl: server.cdpUrl(), cdpStrict: true },
      env: { ...process.env, COMPUTER_USE_CDP_URL: server.cdpUrl(), COMPUTER_USE_CDP_STRICT: "1" },
    });
    // Connecting is what the first listing does, and on the user's browser it opens nothing.
    const tabsBefore = probe.contexts()[0]!.pages().length;
    const targets = await scopeDriver.listTargets();
    await sleep(500);
    check("connecting and listing opens no tab in the user's browser",
      probe.contexts()[0]!.pages().length === tabsBefore, `${tabsBefore} → ${probe.contexts()[0]!.pages().length} tabs`);
    check("...so the session holds none of its own yet",
      targets.every((t) => t.own === false), JSON.stringify(targets.map((t) => `${t.title}:${t.own}`)));
    const outside = targets.find((t) => t.title.includes("outside") || t.title.includes(OUTSIDE_URL));
    check("the user's tab is listed", !!outside, JSON.stringify(targets.map((t) => `${t.id}:${t.title}:${t.own}`)));
    check("the user's tab is marked as NOT this session's", outside?.own === false, JSON.stringify(outside));
    const opened = await scopeDriver.perform("new_tab", {});
    await sleep(500);
    check("new_tab with no tab held opens exactly one", opened.ok === true
      && probe.contexts()[0]!.pages().length === tabsBefore + 1, `${JSON.stringify(opened)}; ${probe.contexts()[0]!.pages().length} tabs`);
    check("the session's own tabs are marked as its own",
      (await scopeDriver.listTargets()).some((t) => t.own === true), JSON.stringify(targets.map((t) => t.own)));

    // The half that protects the user: close_tab refuses it BY NAME, and `all` leaves it alone.
    const refused = outside ? await scopeDriver.perform("close_tab", { id: outside.id }) : { ok: true, note: "not run" };
    check("close_tab refuses the user's tab", refused.ok === false && /user's own tab/.test(refused.note ?? ""),
      JSON.stringify(refused));
    await sleep(300);
    check("the user's tab is still open after the refusal", !userPage.isClosed());
    check("the refusal tells the model to ASK rather than just saying no",
      /Ask them in the conversation/.test(refused.note ?? ""), JSON.stringify(refused.note));

    // The way through: the model asked the person, they agreed, it says so. A separate tab from
    // the one above — the recycle assertions further down still need that one open.
    const doomedPage = await probe.contexts()[0]!.newPage();
    await doomedPage.goto(UPLOAD_URL);
    await sleep(1200);
    const withDoomed = await scopeDriver.listTargets();
    const doomedTarget = withDoomed.find((t) => t.own === false && t.title.includes("upload"));
    check("the second user tab is listed too", !!doomedTarget, JSON.stringify(withDoomed.map((t) => `${t.title}:${t.own}`)));
    const allowed = doomedTarget
      ? await scopeDriver.perform("close_tab", { id: doomedTarget.id, confirmed: true })
      : { ok: false, note: "not run" };
    check("close_tab closes the user's tab once confirmed", allowed.ok === true, JSON.stringify(allowed));
    check("and the note says whose tab it was", /the user's own/.test(allowed.note ?? ""), JSON.stringify(allowed.note));
    await sleep(400);
    check("the user's tab really is closed", doomedPage.isClosed());

    await scopeDriver.close();
    await probe.close();

    // ── Second CDP client shares the same browser ───────────────────────
    browser2 = await chromium.connectOverCDP(server.cdpUrl());
    const ctx2 = browser2.contexts()[0]!;
    const deadline2 = Date.now() + 5000;
    while (ctx2.pages().length < 2 && Date.now() < deadline2) await sleep(100);
    check("second client sees the same tabs", ctx2.pages().length >= 2, `${ctx2.pages().length} pages`);
    const before1 = ctx1.pages().length;
    const page2 = await ctx2.newPage();
    await page2.goto(pages.url("/two"));
    check("second client can drive its own tab", (await page2.title()) === "from client two");
    const deadline3 = Date.now() + 5000;
    while (ctx1.pages().length <= before1 && Date.now() < deadline3) await sleep(100);
    check("first client sees the second client's tab appear", ctx1.pages().length === before1 + 1);

    // ── evaluate() on a tab a PREVIOUS client drove ─────────────────────
    // One chrome.debugger session per tab is shared by every client, so a later client's
    // `Runtime.enable` hits an already-enabled domain, Chrome replays no execution context, and
    // `evaluate` waits forever while `title()`/`screenshot()` keep working.
    const evaluateWithin = async (p: import("playwright-core").Page, ms: number): Promise<unknown> =>
      await Promise.race([p.evaluate("1+1"), sleep(ms).then(() => "<timeout>")]);
    check("second client can evaluate on a tab it created", (await evaluateWithin(page2, 8000)) === 2);
    await browser2.close();
    browser2 = null;
    await sleep(600); // the bridge releases tabs no client holds any more
    const browser3 = await chromium.connectOverCDP(server.cdpUrl());
    try {
      const ctx3 = browser3.contexts()[0]!;
      const deadline4 = Date.now() + 5000;
      while (!ctx3.pages().some((p) => p.url().includes("/two")) && Date.now() < deadline4) await sleep(100);
      const reclaimed = ctx3.pages().find((p) => p.url().includes("/two"));
      check("a respawned client sees the released tab", !!reclaimed, `${ctx3.pages().length} pages`);
      if (reclaimed) {
        check("a respawned client can evaluate on it (context replay)", (await evaluateWithin(reclaimed, 8000)) === 2);
        check("window.name survives for the named-tab claim", typeof (await reclaimed.evaluate("window.name")) === "string");
      }
    } finally {
      await browser3.close().catch(() => {});
    }

    // ── a tab closed while nobody drove it must not strand the next client ──
    // Releasing a tab takes it out of the extension's watch list, so its `onRemoved` can go
    // unreported and the model keep a ghost — the next client handed a page whose renderer is
    // gone, where `evaluate` never returns (the same hang, one layer over).
    const doomed = await ctx1.newPage();
    await doomed.goto(pages.url("/two"));
    await doomed.close();
    await sleep(400);
    const browser4 = await chromium.connectOverCDP(server.cdpUrl());
    try {
      const ctx4 = browser4.contexts()[0]!;
      await sleep(800);
      const alive = ctx4.pages();
      check("a client after a stray close sees only live tabs", alive.length > 0, `${alive.length} pages`);
      const verdicts = await Promise.all(alive.map((p) => evaluateWithin(p, 8000)));
      check("every page a fresh client is handed can evaluate", verdicts.every((v) => v === 2), JSON.stringify(verdicts));
    } finally {
      await browser4.close().catch(() => {});
    }

    // ── The stall probe fires on a stall we manufacture ─────────────────
    // `slow: …` is the only record that says WHICH side a hang is on, so prove it on a
    // real stall: make the extension's chrome.debugger.sendCommand never answer while the
    // socket stays up, then issue one command and let the 3s warning arrive.
    const patched = await evalInExtension(
      rawCdp!,
      `(() => {
        if (!globalThis.__origSend) globalThis.__origSend = chrome.debugger.sendCommand;
        chrome.debugger.sendCommand = () => new Promise(() => {});
        return "patched";
      })()`,
    );
    check("the extension's debugger call can be made to hang", patched === "patched");
    const before = bridgeLog.length;
    const stalled = await ctx1.newCDPSession(page);
    // Never resolves while patched; the bridge rejects it at its own 30s bound, long after.
    void stalled.send("Page.captureScreenshot", { format: "jpeg" }).catch(() => {});
    await sleep(4000); // the warning lands at 3s
    const warned = bridgeLog.slice(before).find((l) => l.startsWith("slow: "));
    check("a stall is reported while it is still stalling", !!warned, warned ?? (bridgeLog.slice(before).join(" | ") || "(nothing logged)"));
    check("the report names the CALL, not the transport",
      /^slow: Page\.captureScreenshot tab=\d+ pending \d+ms$/.test(warned ?? ""), warned ?? "");
    await evalInExtension(rawCdp!, `(() => { chrome.debugger.sendCommand = globalThis.__origSend; return "restored"; })()`);
    await stalled.detach().catch(() => {});

    // ── /json/list reports LIVE urls, not the attach-time snapshot ──────
    const listed = (await (await fetch(`${server.cdpUrl()}/json/list`)).json()) as Array<{ url: string }>;
    check(
      "/json/list shows live urls",
      listed.some((t) => t.url.includes("/bridge")),
      JSON.stringify(listed.map((t) => t.url.slice(0, 40))),
    );

    // …and keeps showing them with NO client connected: tabs are released between tasks,
    // and an endpoint that reports "no pages" for a browser full of them is what
    // `hasPageTarget` would act on.
    await browser1.close();
    browser1 = null;
    await sleep(600);
    const idle = (await (await fetch(`${server.cdpUrl()}/json/list`)).json()) as Array<{ url: string }>;
    check("/json/list still lists the group's tabs with no client attached", idle.length > 0, `${idle.length} targets`);

    // ── /recycle closes the AGENT's tabs and leaves the user's granted one ──
    // Recycle acts on the user's OWN browser: a tab the user drags into the group (a membership
    // change, not a create) was granted for the agent to use, not given away, so it survives.
    const granted = await evalInExtension(
      rawCdp!,
      `(async () => {
        const groups = await chrome.tabGroups.query({ title: "mirasim" });
        const tab = await chrome.tabs.create({ url: "${OUTSIDE_URL}", active: false });
        await chrome.tabs.group({ groupId: groups[0].id, tabIds: [tab.id] });
        return tab.id;
      })()`,
    );
    // A tab of the USER'S, outside the group. The bridge lists it, so recycle must be asserted
    // not to reach it.
    const untouched = await evalInExtension(
      rawCdp!,
      `chrome.tabs.create({ url: "${pages.url("/two")}", active: false }).then((t) => t.id)`,
    );
    await sleep(700);
    const beforeRecycle = (await (await fetch(`${server.cdpUrl()}/json/list`)).json()) as Array<{ url: string }>;
    check("a dragged-in tab joins the group's targets", beforeRecycle.some((t) => t.url === OUTSIDE_URL),
      JSON.stringify(beforeRecycle.map((t) => t.url.slice(0, 40))));
    const recycled = (await (await fetch(`${server.cdpUrl()}/recycle`, { method: "POST" })).json()) as { closed: number };
    // Not a count: the list carries the user's tabs too, which recycle rightly leaves. What
    // must hold is whose tabs survived.
    check("recycle closes agent tabs", recycled.closed > 0, `closed ${recycled.closed} of ${beforeRecycle.length} targets`);
    await sleep(500);
    const afterRecycle = (await (await fetch(`${server.cdpUrl()}/json/list`)).json()) as Array<{ url: string }>;
    check("the tab the user granted survives", afterRecycle.some((t) => t.url === OUTSIDE_URL),
      JSON.stringify(afterRecycle.map((t) => t.url.slice(0, 40))));
    const untouchedAlive = await evalInExtension(rawCdp!, `chrome.tabs.get(${untouched}).then((t) => t.id, () => null)`);
    check("a tab of the user's OUTSIDE the group is not touched by recycle", untouchedAlive === untouched,
      `tab ${untouchedAlive}`);
    const alive = await evalInExtension(rawCdp!, `chrome.tabs.get(${granted}).then((t) => t.id, () => null)`);
    check("and it is still a live tab in the browser", alive === granted, `tab ${alive}`);
    const again = (await (await fetch(`${server.cdpUrl()}/recycle`, { method: "POST" })).json()) as { closed: number };
    check("a second recycle closes nothing", again.closed === 0, `closed ${again.closed}`);

    // ── Browser.close is refused, not forwarded ────────────────────────
    // The endpoint's backend is the user's own browser; whether chrome.debugger would carry a
    // browser-level command out is not a question worth leaving open.
    const rawAfter = await RawCdp.connect(server.cdpUrl());
    let refusal = "";
    try {
      await rawAfter.send("Browser.close");
    } catch (e) {
      refusal = e instanceof Error ? e.message : String(e);
    }
    rawAfter.close();
    check("Browser.close is refused with a reason", refusal.includes("not available on the mirasim bridge"), refusal || "(resolved!)");
    const survived = await evalInExtension(rawCdp!, `chrome.tabs.get(${granted}).then((t) => t.id, () => null)`);
    check("and the browser is still there", survived === granted, `tab ${survived}`);

    // ── Ids the façade publishes are accepted back ─────────────
    // Between tasks nothing is attached (the recycle above dropped the last attachment). Three
    // things a client does in that state.
    //
    // A browser-scoped command: forwarded over whichever tab is attached, and with none it must
    // still be answered — any tab could answer it.
    const rawCold = await RawCdp.connect(server.cdpUrl());
    let coldCookies = "";
    try {
      await rawCold.send("Storage.getCookies");
    } catch (e) {
      coldCookies = e instanceof Error ? e.message : String(e);
    }
    check("a browser-scoped command is answered with nothing attached", coldCookies === "", coldCookies);
    rawCold.close();

    // Connecting works cold: playwright sends `Target.setAutoAttach` first, which attaches every
    // known tab before any browser-scoped command is sent.
    const cold = await chromium.connectOverCDP(server.cdpUrl());
    check("a client can connect while nothing is attached", cold.contexts().length > 0, `${cold.contexts().length} contexts`);
    await cold.close();

    // And acting on a listed row: an unattached tab is listed with a `mirasim-tab-<n>` stand-in
    // id, which every command that takes a targetId must accept.
    const spares = (await evalInExtension(rawCdp!, `(async () => {
        const groups = await chrome.tabGroups.query({ title: "mirasim" });
        const a = await chrome.tabs.create({ url: "${OUTSIDE_URL}", active: false });
        const b = await chrome.tabs.create({ url: "${OUTSIDE_URL}", active: false });
        await chrome.tabs.group({ groupId: groups[0].id, tabIds: [a.id, b.id] });
        return [a.id, b.id];
      })()`)) as number[];
    await sleep(700);
    const rows = (await (await fetch(`${server.cdpUrl()}/json/list`)).json()) as Array<{ id: string; url: string }>;
    const standIns = rows.filter((t) => t.id.startsWith("mirasim-tab-") && spares.includes(Number(t.id.replace("mirasim-tab-", ""))));
    check("a tab nothing has attached to is listed under a stand-in id", standIns.length === 2,
      JSON.stringify(rows.map((t) => t.id)));

    const raw2 = await RawCdp.connect(server.cdpUrl());
    const closeRes = await raw2.send("Target.closeTarget", { targetId: standIns[0]!.id });
    check("closeTarget accepts a stand-in id", closeRes?.success === true, JSON.stringify(closeRes));
    const goneId = Number(standIns[0]!.id.replace("mirasim-tab-", ""));
    const gone = await evalInExtension(rawCdp!, `chrome.tabs.get(${goneId}).then((t) => t.id, () => null)`);
    check("and the tab it named is really closed", gone === null, `${gone}`);

    const attachRes = await raw2.send("Target.attachToTarget", { targetId: standIns[1]!.id, flatten: true });
    check("attachToTarget accepts a stand-in id", typeof attachRes?.sessionId === "string" && !!attachRes.sessionId,
      JSON.stringify(attachRes));
    const evaled = await raw2.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, attachRes.sessionId);
    check("and the session it hands back drives that tab", evaled?.result?.value === OUTSIDE_URL,
      JSON.stringify(evaled?.result));
    raw2.close();

    // ── A group that EMPTIED comes back ─────────────────────────────────
    // Chrome deletes a group whose last tab closed, which `/recycle` does. A stale group id
    // would make every later join fail silently and the agent drive tabs OUTSIDE the group —
    // this mode's ownership boundary.
    await evalInExtension(rawCdp!, `(async () => {
      const groups = await chrome.tabGroups.query({ title: "mirasim" });
      if (!groups.length) return 0;
      const tabs = await chrome.tabs.query({ groupId: groups[0].id });
      await chrome.tabs.remove(tabs.map((t) => t.id));
      return tabs.length;
    })()`);
    await sleep(600);
    const emptied = await evalInExtension(rawCdp!, `chrome.tabGroups.query({ title: "mirasim" }).then((g) => g.length)`);
    check("the group is gone once its last tab closed", emptied === 0, `${emptied} group(s)`);

    const raw3 = await RawCdp.connect(server.cdpUrl());
    await raw3.send("Target.createTarget", { url: OUTSIDE_URL });
    await sleep(900);
    const regrouped = await evalInExtension(rawCdp!, `(async () => {
      const groups = await chrome.tabGroups.query({ title: "mirasim" });
      if (!groups.length) return 0;
      return (await chrome.tabs.query({ groupId: groups[0].id })).length;
    })()`);
    check("a tab opened afterwards lands in a fresh mirasim group", regrouped >= 1, `${regrouped} tab(s) grouped`);
    raw3.close();
  } finally {
    rawCdp?.close();
    await browser1?.close().catch(() => {});
    await browser2?.close().catch(() => {});
    server.stop();
    chrome.cleanup();
    pages.close();
  }

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
