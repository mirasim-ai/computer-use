/**
 * Live acceptance for the diagnostics channel (`diagnostics()` / `observe what:'diagnostics'`) —
 * against a real throwaway Chrome and a local fixture server, through the test harness, reading
 * the driver's own renderings.
 *
 * Covers: console messages typed by level (+ source location) · async uncaught exception as
 * pageerror, stack fetched by id · the acceptance scenario — a click whose handler THROWS
 * while the DOM stays put: the post-action observation names the error instead of only
 * "try another element", and the note is consumed (never repeated) · HTTP ≥ 400 ·
 * connection-refused request failure · flood volume — ring cap drops + honest count,
 * bounded render · a load-time error across a NAVIGATION named as the page's own rather than
 * as a failed action · unknown id answered honestly · default-off: the channel answers disabled.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { sleep, spawnChrome } from "./helpers.ts";
import { createHarness } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";

/** Static DOM throughout — the throwing button must not change the page. */
const FIXTURE = `<!doctype html><title>diagnostics fixture</title><main>
  <button id="throw" onclick="window.__t=(window.__t||0)+1; throw new Error('handler exploded ' + window.__t)">Save</button>
  <button id="fetch404" onclick="fetch('/missing').catch(()=>{})">Load data</button>
  <button id="fetchdead" onclick="fetch('http://127.0.0.1:1/x').catch(()=>{})">Sync remote</button>
  <button id="img404" onclick="document.body.appendChild(Object.assign(new Image(),{src:'/missing.png'}))">Show logo</button>
  <button id="flood" onclick="for(let i=0;i<2000;i++) console.log('flood line ' + i)">Flood</button>
  <p>static content stays put</p>
</main>
<script>
  console.log('boot ok');
  console.info('info note');
  console.warn('low disk');
  console.error('boom from load');
  setTimeout(() => { throw new Error('async explosion'); }, 80);
</script>`;

async function main() {
  const chrome = await spawnChrome({});
  const server = http.createServer((req, res) => {
    if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end(FIXTURE); }
    else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  delete process.env.COMPUTER_USE_DIAGNOSTICS;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser", diagnostics: true });
  const h = createHarness(profile.driver, { diagnostics: true });

  const diag = async () => firstText(await h.observe({ what: "diagnostics" }));
  /** Events are delivered async over CDP — poll the channel until it says what we expect. */
  const upto = async (pred: (t: string) => boolean, ms = 6000) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = await diag();
      if (pred(t) || Date.now() > end) return t;
      await sleep(150);
    }
  };

  try {
    // ── Load-time events: console by level, async pageerror ───────────────────
    await h.observe({}); // first look attaches the listeners (about:blank's Page)
    await h.act("open_url", { url: `${base}/` });
    const t = await upto((s) => s.includes("async explosion") && s.includes("boom from load"));
    check("console.error captured and typed", /console\.error: boom from load/.test(t), t.slice(0, 200));
    check("console.warn captured and typed", /console\.warn: low disk/.test(t));
    check("console.info captured and typed", /console\.info: info note/.test(t));
    check("console.log carries source location", /console\.log: boot ok \([^)]*:\d+\)/.test(t));
    check("async uncaught exception is a pageerror entry", /pageerror: async explosion/.test(t));
    check("counts line names the types", /Counts since collection started: .*pageerror \d+, console\.error \d+/.test(t));

    // ── One full entry by id: stack + page url ─────────────────────────────────
    const idm = t.match(/(d\d+) \[\+[\d.]+s\] pageerror: async explosion/);
    check("pageerror line carries an id", !!idm);
    if (idm) {
      const one = firstText(await h.observe({ what: "diagnostics", id: idm[1] }));
      check("id fetch returns the full entry with its stack", one.includes("async explosion") && /\bat /.test(one), one.slice(0, 200));
      check("id fetch names the page url", one.includes(base));
    }

    // ── Acceptance scenario: handler throws, DOM static ────────────────────────
    // Drain any pending note first so the click's note is unambiguously its own.
    await h.observe({});
    const obs = firstText(await h.observe({}));
    check("no stale error note on a quiet page", !/new page\/console error/.test(obs), obs.slice(0, 200));
    // Refs come from the query channel: repeated observations render deltas, whose body
    // carries no element lines to parse.
    const q = async (name: string) => firstText(await h.observe({ query: name })).match(/\b(e\d+)\b/)?.[1];
    const refm = await q("Save");
    check("fixture button has a ref", !!refm);
    let noteText = "";
    if (refm) {
      const act = firstText(await h.act("click", { ref: refm }));
      noteText = act;
      // The pageerror event races the post-action observation; a later observe must carry it.
      for (let i = 0; i < 10 && !/new page\/console error/.test(noteText); i++) {
        await sleep(150);
        noteText = firstText(await h.observe({}));
      }
    }
    check("post-click observation NOTE names the thrown error", /new page\/console error/.test(noteText) && noteText.includes("handler exploded"), noteText.slice(0, 300));
    check("NOTE points at the diagnostics channel", noteText.includes("diagnostics()"));
    const after = firstText(await h.observe({}));
    check("the note is consumed, not repeated", !/new page\/console error/.test(after), after.slice(0, 200));

    // ── Network: HTTP ≥ 400 and connection-refused ─────────────────────────────
    const ref404 = await q("Load data");
    if (ref404) await h.act("click", { ref: ref404 });
    const t404 = await upto((s) => s.includes("HTTP 404"));
    check("HTTP 404 recorded as a network entry", /network: GET .*\/missing — HTTP 404/.test(t404), t404.slice(-300));
    const refDead = await q("Sync remote");
    if (refDead) await h.act("click", { ref: refDead });
    const tDead = await upto((s) => /127\.0\.0\.1:1\/x — net::ERR_/.test(s));
    check("connection failure recorded with its errorText", /network: GET http:\/\/127\.0\.0\.1:1\/x — net::ERR_/.test(tDead), tDead.slice(-300));

    // ── A failed SUBRESOURCE is ONE event, and it belongs to the network channel ───
    // Chrome logs its own "Failed to load resource" line at error level for every missing
    // image, font or favicon. Counted as console it would record the 404 twice and raise "the
    // page's own code may have failed" on every page without a favicon; the banner is about page
    // CODE, and a failed request has a channel of its own.
    const refImg = await q("Show logo");
    const imgObs = refImg ? firstText(await h.act("click", { ref: refImg })) : "";
    const tImg = await upto((s) => s.includes("/missing.png"));
    check("a failed subresource is recorded once, on the network channel",
      /network: GET .*\/missing\.png — HTTP 404/.test(tImg) && !/console\.error: Failed to load resource/.test(tImg), tImg.slice(-400));
    const afterImg = firstText(await h.observe({}));
    check("a failed subresource raises no page-code-failed note",
      !/new page\/console error/.test(imgObs) && !/new page\/console error/.test(afterImg),
      (imgObs + afterImg).slice(0, 240));

    // ── Volume: a console flood hits the ring cap, render stays bounded ────────
    const refFlood = await q("Flood");
    if (refFlood) await h.act("click", { ref: refFlood });
    const tf = await upto((s) => /dropped at the 300-entry cap/.test(s), 15000);
    check("flood: drops are counted and announced", /\d+ older entries were dropped at the 300-entry cap/.test(tf), tf.split("\n")[1] ?? "");
    const listed = tf.split("\n").filter((l) => /^d\d+ \[/.test(l)).length;
    check("flood: at most 20 entries listed", listed <= 20, `${listed} lines`);
    check("flood: render stays bounded", tf.length < 8000, `${tf.length} chars`);
    check("flood: console.log count reflects the whole burst", /console\.log 2\d{3}/.test(tf));

    // ── Across a NAVIGATION the errors are the new page's own ─────────────────────
    // Real sites throw on load routinely, and the note must not blame an action on every page
    // open. Filtering messages cannot generalize; WHEN the errors arrived separates the two.
    let navNote = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>noisy load</title><script>console.error("boom on load")</script><button>OK</button>',
    )}` }));
    for (let i = 0; i < 10 && !/page\/console error/.test(navNote); i++) {
      await sleep(150);
      navNote = firstText(await h.observe({}));
    }
    check("a load-time error after a navigation is named as the page's own",
      /while this page loaded/.test(navNote) && !/your action/.test(navNote), navNote.slice(0, 260));

    // ── …and a load error that arrives LATE still is ──────────────────────────────
    // Sites throw on their own clock, so errors can land seconds later on an observation of the
    // SAME url with no action in sight. The post-navigation settle can outlast the timer, so the
    // note may already be on open_url's own observation — start from it, as the navigation case does.
    let lateNote = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>late load</title><button>OK</button>'
      + '<script>setTimeout(() => console.error("late boom"), 3000)</script>',
    )}` }));
    for (let i = 0; i < 20 && !/page\/console error/.test(lateNote); i++) {
      await sleep(200);
      lateNote = firstText(await h.observe({}));
    }
    // "since the last observation" — NOT "while this page loaded": the timer outlasts the
    // settle, so this lands on a later observation and only the action timing spares it.
    check("an error arriving seconds after the load is still the page's own",
      /page\/console error/.test(lateNote) && !/your action/.test(lateNote),
      lateNote.split("\n").find((l) => l.includes("page/console error")) ?? "(no note)");

    // ── …including when the flow used `wait`, which acts on nothing ───────────────
    // open_url → wait → look is the most ordinary flow there is, and stamping `wait` as a
    // blamable action would clear the navigation's exemption.
    await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>late load 2</title><button>OK</button>'
      + '<script>setTimeout(() => console.error("late boom two"), 2500)</script>',
    )}` });
    let waitNote = firstText(await h.act("wait", { ms: 3500 }));
    for (let i = 0; i < 20 && !/page\/console error/.test(waitNote); i++) {
      await sleep(200);
      waitNote = firstText(await h.observe({}));
    }
    check("a wait between the load and the look does not make it the action's fault",
      /page\/console error/.test(waitNote) && !/your action/.test(waitNote),
      waitNote.split("\n").find((l) => l.includes("page/console error")) ?? "(no note)");

    // ── Unknown id ─────────────────────────────────────────────────────────────
    const miss = firstText(await h.observe({ what: "diagnostics", id: "d999999" }));
    check("unknown id answered honestly", miss.includes("no diagnostics entry 'd999999'") && miss.includes("span"), miss);

    // ── Default-off: the channel answers disabled ──────────────────────────────
    const off = resolveProfile({ driver: "browser" });
    const hOff = createHarness(off.driver);
    const rejected = firstText(await hOff.observe({ what: "diagnostics" }));
    check("off: the channel answers disabled", rejected.includes("not enabled"), rejected);
    check("off: driver-level read answers disabled", firstText(await off.driver.readDiagnostics()).includes("not enabled"));

    // No case for a platform with NO source (asking there enables nothing): every platform has
    // one — browser and electron from Chromium, macos from the helper's own log. The gate is
    // still there (`supportsDiagnostics` defaults to false in driver-base.ts); add the check with
    // the next platform that lacks a source.
  } finally {
    await profile.driver.close().catch(() => {});
    server.close();
    chrome.cleanup();
  }

  console.log(failures ? `\n${failures} failure(s)` : "\nall diagnostics checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
