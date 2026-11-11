/**
 * Behavior tests for multi-tab targeting — the driver's promise that actions land in the
 * tab the task lives in, driven through the test harness against a real throwaway Chrome and
 * a real second tab (data: URLs cannot open windows, so fixtures ride a local http server).
 *
 * Pins: a spawned blank tab must NOT hijack the active tab (adoptWhenReal's 1.5s rule) · a
 * link-opened tab that navigates to real content IS adopted · a ref from another tab must fail
 * honestly, never type into the wrong page · targets/focus round-trips between tabs · when the
 * active tab closes, the driver re-selects a real-content tab, never a stray blank.
 */

import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { spawnChrome, sleep } from "./helpers.ts";
import { createHarness } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";

const PAGE_A = `<!doctype html><title>Tab A</title>
<h1>Alpha page</h1>
<p id="status">quiet</p>
<input placeholder="alpha field">
<button onclick="window.open('about:blank')">Spawn blank</button>
<button onclick="const w = window.open('about:blank'); w.location = '/b.html';">Open page B</button>
<a href="/b.html" target="_blank">Blank link</a>`;

const PAGE_B = `<!doctype html><title>Tab B</title>
<h1>Beta page</h1>
<input placeholder="beta field">`;

/** Serve the two fixture pages on an ephemeral local port. */
function serveFixtures(): Promise<{ base: string; close: () => void }> {
  const srv = createServer((req, res) => {
    // /slow.html holds the response open: the blank-surface note must not fire at a page
    // that is on its way, only at one that is genuinely empty.
    if (req.url === "/slow.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<!doctype html><title>Slow page</title>");
      setTimeout(() => res.end("<h1>Slow content</h1><button>late button</button>"), 1500);
      return;
    }
    const body = req.url === "/b.html" ? PAGE_B : PAGE_A;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

async function main() {
  const chrome = await spawnChrome({});
  const fixtures = await serveFixtures();
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  // Full renders keep the assertions direct; delta mechanics are scroll-behaviors' job.
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  // The default window posture: the stray blank tab below is one Chrome opens itself.
  delete process.env.COMPUTER_USE_WINDOW;
  delete process.env.COMPUTER_USE_TAB;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);
  const driver = profile.driver;

  try {
    // ── Baseline: task lives on page A ────────────────────────────────────────
    const nav = await h.act("open_url", { url: `${fixtures.base}/a.html` });
    const navText = firstText(nav);
    check("page A observed", navText.includes("Alpha page"), navText.split("\n")[0]);
    const alphaRef = navText.match(/(e\d+): textbox "alpha field"/)?.[1];
    const spawnRef = navText.match(/(e\d+): button "Spawn blank"/)?.[1];
    const openBRef = navText.match(/(e\d+): button "Open page B"/)?.[1];
    const blankLinkRef = navText.match(/(e\d+): link "Blank link"/)?.[1];
    check("page A refs found", !!alphaRef && !!spawnRef && !!openBRef && !!blankLinkRef, `${alphaRef},${spawnRef},${openBRef},${blankLinkRef}`);

    // ── A target=_blank link opens a SECOND tab, and the session follows it ──
    // Counted as a DIFFERENCE: a throwaway Chrome always holds its own start page. The driver
    // opens the tab itself, in the background (page-tabs.ts); test/page-opened-tabs.ts pins the
    // rest (window.open, forms, a cross-origin frame).
    const tabsBefore = (firstText(await h.targets()).match(/\[tab\]/g) ?? []).length;
    const blankClick = firstText(await h.act("click", { ref: blankLinkRef, name: "Blank link" }));
    const afterBlank = firstText(await h.targets());
    check("a _blank link opens one more tab", (afterBlank.match(/\[tab\]/g)?.length ?? 0) === tabsBefore + 1, afterBlank.replace(/\n/g, " | "));
    check("the click's own observation is the new tab", /Beta page/.test(blankClick), blankClick.split("\n")[0]);
    check("the move to it is announced as the page's doing, with the tab's id and address",
      new RegExp(`the page opened a new tab, t\\d+ \\(opened ${fixtures.base}/b\\.html\\)`).test(blankClick), blankClick.split("\n")[0]);
    check("page A is still open behind it", /Tab A/.test(afterBlank) && /Tab B/.test(afterBlank), afterBlank.replace(/\n/g, " | "));
    const closedBlank = firstText(await h.act("close_tab", {}));
    check("closing the new tab returns to page A", closedBlank.includes("Alpha page"), closedBlank.split("\n")[0]);
    // Back to A — a NEW document, so its refs are minted afresh above the old high-water mark
    // (ref-lifecycle.ts pins that). Re-read the handles; the first load's are stale.
    const backA = firstText(await h.act("open_url", { url: `${fixtures.base}/a.html` }));
    const alphaRefA = backA.match(/(e\d+): textbox "alpha field"/)?.[1];
    const spawnRefA = backA.match(/(e\d+): button "Spawn blank"/)?.[1];
    const openBRefA = backA.match(/(e\d+): button "Open page B"/)?.[1];
    check("page A re-read with fresh refs", !!alphaRefA && !!spawnRefA && !!openBRefA && alphaRefA !== alphaRef,
      `${alphaRef} → ${alphaRefA}`);

    // ── A stray about:blank tab must not hijack the active tab ───────────────
    await h.act("click", { ref: spawnRefA, name: "Spawn blank" });
    await sleep(2200); // past adoptWhenReal's 1.5s never-navigated cutoff
    const targets1 = firstText(await h.targets());
    check("stray blank tab exists (popup was not blocked)", /about:blank/.test(targets1), targets1);
    const obs1 = firstText(await h.observe({}));
    check("observation still shows page A, not the blank tab", obs1.includes("Alpha page"), obs1.split("\n")[0]);
    const filled = firstText(await h.act("set_text", { ref: alphaRefA, name: "alpha field", text: "typed on A" }));
    check("set_text lands in page A's field", filled.includes("filled:typed on A"), filled.split("\n")[0]);

    // ── A link-opened tab that navigates to real content IS adopted ──────────
    const clickB = firstText(await h.act("click", { ref: openBRefA, name: "Open page B" }));
    await sleep(800); // adoption happens on the new tab's first real navigation
    const obs2 = firstText(await h.observe({}));
    check("observation follows into page B", obs2.includes("Beta page"), obs2.split("\n")[0]);
    // Following silently would let the model read a different page as the effect of its own
    // click. WHICH of the two texts carries the note is a race (adoption can land inside the
    // click's own observation), so the contract is "exactly once across both".
    const bothB = `${clickB}\n${obs2}`;
    const announcements = bothB.match(/the active tab changed/g)?.length ?? 0;
    check("the move to page B is announced exactly once", announcements === 1, `${announcements} time(s)`);
    check("the announcement says refs from the old tab are stale", /refs from earlier observations belong to the previous tab/.test(bothB));
    check("the announcement is not a reopen claim", !/had been closed|fresh blank tab/.test(bothB));

    // ── A ref from another tab fails honestly — never types into this page ───
    const crossR = await h.act("set_text", { ref: alphaRefA, name: "alpha field", text: "hello across tabs" });
    const cross = firstText(crossR);
    check("cross-tab ref is rejected", !crossR.ok, cross.split("\n")[0]);
    check("rejection tells the model to re-observe", /[Rr]e-observe/.test(cross), cross.split("\n")[0]);
    const obs3 = firstText(await h.observe({}));
    check("nothing was typed into page B's field", !obs3.includes("hello across tabs"), obs3.split("\n").find((l) => l.includes("beta")) ?? "");

    // ── targets/focus round-trip ──────────────────────────────────────────────
    const targets2 = firstText(await h.targets());
    check("targets list all three tabs", /Tab A/.test(targets2) && /Tab B/.test(targets2) && /about:blank/.test(targets2), targets2);
    const infos = await driver.listTargets();
    check("exactly one target is active", infos.filter((t) => t.active).length === 1, JSON.stringify(infos));
    check("the active target is page B", infos.find((t) => t.active)?.title === "Tab B");
    const tabA = infos.find((t) => t.title === "Tab A");
    check("page A's target id found", !!tabA);

    // ── Active tab closes: re-select real content, never the stray blank ─────
    // Close B from the OUTSIDE (a second CDP client), as a user or the page itself would.
    const external = await chromium.connectOverCDP(chrome.cdpUrl);
    const bPage = external.contexts()[0]?.pages().find((p) => p.url().endsWith("/b.html"));
    check("external client sees page B", !!bPage);
    await bPage?.close();
    await sleep(300);
    const obs4 = firstText(await h.observe({}));
    check("after active tab closed, a real-content tab is re-selected", obs4.includes("Alpha page"), obs4.split("\n")[0]);
    check("the stray blank did not shadow the task page", !obs4.startsWith("Title: about:blank"), obs4.split("\n")[0]);
    check("the re-selection is announced too", /the active tab changed \(the tab it was on was closed\)/.test(obs4), obs4.split("\n")[0]);

    // ── Recovery end-to-end: fresh ref on the re-selected tab works ──────────
    const alphaRef2 = obs4.match(/(e\d+): textbox "alpha field"/)?.[1];
    check("field re-observed with a usable ref", !!alphaRef2);
    const refill = firstText(await h.act("set_text", { ref: alphaRef2, name: "alpha field", text: "recovered" }));
    check("set_text works again after recovery", refill.includes("filled:recovered"), refill.split("\n")[0]);

    // ── focus verb switches tabs through the harness ─────────────────────
    if (tabA) {
      const blankId = infos.find((t) => t.title === "about:blank")?.id;
      if (blankId) {
        await h.act("focus", { target: blankId });
        const afterBlank = await driver.listTargets();
        check("focus moves the active flag to the blank tab", afterBlank.find((t) => t.active)?.title === "about:blank", JSON.stringify(afterBlank));
        // Blank here means something different: the task's page is one tab away, so the
        // observation must point there instead of telling the model to navigate.
        const onBlank = firstText(await h.observe({}));
        check("observing the blank tab points at the other tab", /this tab is blank — your page may be in another tab/.test(onBlank), onBlank.split("\n").slice(0, 3).join(" / "));
      }
      await h.act("focus", { target: tabA.id });
      const obs5 = firstText(await h.observe({}));
      check("focus back to page A observes page A", obs5.includes("Alpha page"), obs5.split("\n")[0]);
      // A switch the model ASKED for is not a drift — announcing it would be noise.
      check("a requested focus is not announced as a change", !/the active tab changed/.test(obs5), obs5.split("\n")[0]);
    }

    // ── A page in flight is not a blank surface ──────────────────────────────
    // The note fires on url==about:blank with nothing collected. A navigation that has not
    // committed yet can be observed in that state, and telling the model to navigate while
    // its navigation is running would send it in a circle.
    const inFlight = h.act("open_url", { url: `${fixtures.base}/slow.html` });
    await sleep(300);
    const during = firstText(await h.observe({}));
    check("an observation during a navigation does not claim nothing was opened",
      !/nothing has been opened in it/.test(during), during.split("\n").slice(0, 2).join(" / "));
    const landed = firstText(await inFlight);
    check("the slow page still lands", landed.includes("late button") || firstText(await h.observe({})).includes("late button"),
      landed.split("\n")[0]);

    await driver.close();
  } finally {
    chrome.cleanup();
    fixtures.close();
    delete process.env.COMPUTER_USE_OBS_DELTA;
  }

  console.log(failures === 0 ? "\nTAB TARGETING OK" : `\nTAB TARGETING FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
