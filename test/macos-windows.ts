/** Hermetic macOS coverage for WHICH SURFACE — the counterpart of macos-ui.ts that is about
 * picking an app and a window rather than acting inside one.
 *
 * The seam matches the driver's: `macos/driver-apps.ts` is the slice that answers "which app,
 * which window, and may we touch it", and these are its assertions — the window a screenshot
 * addresses, the user's allow-list gating both seeing and driving, the launch route, an
 * off-screen window named rather than rendered as an app with no controls, and the rule that
 * only the app under control is ever asked about. Every block builds its own stub and harness. */

import { createHarness } from "./harness.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import type { ToolResult } from "../src/platform/types.ts";
import { findCall, ONE_APP, stubTransport } from "./macos-fixtures.ts";
import { WINDOW } from "./macos-stub-app.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";
/** A read the surface refuses (a locked screen, an off-screen window) is the ANSWER, which is how
 *  `computer_repl` renders it; the harness lets the error propagate, so the suite folds it back into text. */
const orReason = (p: Promise<ToolResult>): Promise<ToolResult> =>
  p.catch((e: Error & { surfaceUnreadable?: boolean }) => {
    if (!e.surfaceUnreadable) throw e;
    return { content: [{ type: "text", text: e.message }], details: { error: "surface_unreadable" } };
  });

async function main() {
  // ── A screenshot first: the window it showed is the one every later read addresses ──
  {
    const px = stubTransport();
    const pxH = createHarness(new MacosDriver({ transport: px.transport, ...ONE_APP }));
    await pxH.observe({ what: "screenshot" });
    px.calls.length = 0;
    await pxH.observe({ what: "text" });
    check("a text read after a screenshot walks the window the screenshot photographed", findCall(px.calls, "tree")?.params.window === WINDOW.id, JSON.stringify(findCall(px.calls, "tree")?.params));
  }

  // ── The user's allow-list (COMPUTER_USE_MACOS_FALLBACK_APPS): seeing and driving are both gated ──
  {
    const one = stubTransport();
    const oneH = createHarness(new MacosDriver({ transport: one.transport, env: { COMPUTER_USE_MACOS_FALLBACK_APPS: "com.apple.TextEdit" } }));
    const listed = firstText(await oneH.targets());
    check("targets list only allowed apps", /com\.apple\.TextEdit/.test(listed) && !/calculator/.test(listed), listed.split("\n").join(" | "));
    one.calls.length = 0;
    // The bare API call: the harness would read the window after the refusal, and that read is
    // what asks the helper for windows — the claim here is that the REFUSAL never does.
    const focusOther = await oneH.api.focus("49403:62106").then(() => "", (e: Error) => e.message);
    check("focus onto an app outside the list is refused and says the host cannot ask", /not one of the apps this session may drive/.test(focusOther) && /cannot ask/.test(focusOther) && !one.calls.some((c) => c.op === "windows"), focusOther.split("\n")[0]);
    const launchOther = await oneH.act("launch_app", { bundle: "com.apple.calculator" }).then(firstText, (e: Error) => e.message);
    check("launch_app outside the list is refused before the helper is asked", /not one of the apps this session may drive/.test(launchOther) && !one.calls.some((c) => c.op === "launch"), launchOther.split("\n")[0]);

    const many = stubTransport();
    const manyH = createHarness(new MacosDriver({ transport: many.transport, env: { COMPUTER_USE_MACOS_FALLBACK_APPS: "com.apple.TextEdit,com.apple.calculator" } }));
    const ambiguous = firstText(await manyH.observe({}));
    // No candidate list: under an allow-list computer.surfaces() already lists exactly the allowed apps.
    check("several allowed apps and no `app` ⇒ asks for one, never picks the frontmost",
      /naming one is the caller's call/.test(ambiguous) && !/com\.apple\.calculator/.test(ambiguous)
      && !many.calls.some((c) => c.op === "tree"),
      ambiguous.split("\n")[0]);

    // An empty list answers the UNNAMED call the same way every other unnamed call is answered:
    // not naming one is the first thing wrong with it. "Nothing is allowed yet" is what the
    // NAMED call is told, which is also the call that can raise the consent dialog.
    const none = stubTransport();
    const noneH = createHarness(new MacosDriver({ transport: none.transport, env: { COMPUTER_USE_MACOS_FALLBACK_APPS: "" } }));
    const nothing = firstText(await noneH.observe({}));
    check("an empty list still asks for a name first", /no app was named/.test(nothing), nothing.split("\n")[0]);
    const named = await noneH.act("launch_app", { bundle: "com.apple.TextEdit" }).then(firstText, (e: Error) => e.message);
    check("…and the named call is refused for the list, not for a missing name",
      /not one of the apps this session may drive/.test(named), named.split("\n")[0]);
  }

  // ── A host that CAN ask (MCP elicitation): nameable by name, read only once cleared ──────
  // The Codex Computer Use shape: every running app is listed by name, window titles stay unread
  // until the user allows the app, and the question is asked on the action that needs it.
  {
    const asked: string[] = [];
    let answer = true;
    let persist: "session" | "always" | undefined = "session";
    let offered: unknown;
    let revoke: (ids: string[]) => void = () => {};
    const consent = {
      available: () => true,
      ask: async (_message: string, meta: Record<string, unknown>) => {
        asked.push((meta["mirasim-computer-use/macosApp"] as { bundle: string }).bundle);
        offered = meta.persist;
        return answer ? { allowed: true, ...(persist ? { persist } : {}) } : { allowed: false, reason: "nobody answered in time" };
      },
      onRevoke: (cb: (ids: string[]) => void) => { revoke = cb; },
    };
    const store = join(mkdtempSync(join(tmpdir(), "computer-use-approvals-")), "approvals.json");
    const st = stubTransport();
    const drv = new MacosDriver({ transport: st.transport, consent, env: { COMPUTER_USE_MACOS_APPROVALS: store } });
    const h = createHarness(drv);

    const listed = firstText(await h.targets());
    check("an uncleared app is listed by name, and its windows are never read",
      /计算器 \(com\.apple\.calculator\) — not allowed yet; binding it asks the user/.test(listed) && !st.calls.some((c) => c.op === "windows"),
      listed.split("\n").find((l) => /calculator/.test(l)) ?? listed);

    answer = false;
    const declined = await h.api.focus("49403").then(() => "", (e: Error) => e.message);
    check("binding an uncleared app asks, and a no stops the run with the host's reason",
      asked.join() === "com.apple.calculator" && /permission to drive 计算器 \(com\.apple\.calculator\) was not granted/.test(declined) && /nobody answered in time/.test(declined),
      declined);

    answer = true;
    await h.api.focus("49403");
    await h.observe({});
    await h.observe({});
    check("the question offers cua's persist choices", JSON.stringify(offered) === '["session","always"]', JSON.stringify(offered));
    check("an allow with persist:session clears the app for the session: later actions do not ask again",
      asked.length === 2, asked.join());

    revoke(["com.apple.calculator"]);
    persist = undefined;
    await h.observe({});
    check("a revoke takes effect at the NEXT action, not the next bind", asked.length === 3, asked.join());
    await h.observe({});
    drv.endCall();
    await h.observe({});
    check("an allow with no persist holds for the call only: the next call asks again", asked.length === 4, asked.join());

    persist = "always";
    drv.endCall();
    await h.observe({});
    const kept = readFileSync(store, "utf8");
    const fresh = new MacosDriver({ transport: stubTransport().transport, consent, env: { COMPUTER_USE_MACOS_APPROVALS: store } });
    await createHarness(fresh).api.focus("49403");
    check("persist:always is kept on disk, so a NEW session does not ask",
      /com\.apple\.calculator/.test(kept) && asked.length === 5, `${asked.join()} | ${kept.trim()}`);
    revoke(["com.apple.calculator"]);
    check("…and a revoke removes it from the disk store too", !/calculator/.test(readFileSync(store, "utf8")));
    persist = "session";

    // A key goes where the focus is. When that is ANOTHER app's field, the gate is that app's —
    // the bound app's clearance must not carry a keystroke into a process nobody allowed.
    answer = false;
    st.focusOn = "k12";
    st.focusOwner = 777; // TextEdit, never cleared
    const before = asked.length;
    const typed = await h.act("keys", { chord: "a" }).then(firstText, (e: Error) => e.message);
    check("a key whose focus sits in another app asks about THAT app, and a no means no key is posted",
      asked.slice(before).join() === "com.apple.TextEdit" && /permission to drive TextEdit \(com\.apple\.TextEdit\) was not granted/.test(typed)
      && !st.calls.some((c) => c.op === "key" && c.params.pid === 777), typed);
    st.focusOwner = 0;
    st.focusOn = "none";
    answer = true;

    const row = await drv.unlistedTarget("com.apple.Notes");
    check("computer.surface('<bundle id>') resolves an installed app no listing carries",
      row?.id === "com.apple.Notes" && /not running/.test(row.title), JSON.stringify(row));
    const cold = await h.api.focus("com.apple.Notes").then(() => "", (e: Error) => e.message);
    check("an installed app that is not running is reachable by bundle id, and asked about before its launch",
      asked.at(-1) === "com.apple.Notes" && !!findCall(st.calls, "launch"), cold || asked.join());
  }

  // ── A quit app answers to its NAME, not only its bundle id ───────────────────────
  // The reference promises computer.surface('<bundle id or app name>'). On a Chinese Mac the
  // listing says 备忘录 while the model says Notes; neither is in a quit app's (absent) row, so
  // the name is resolved to installed bundle ids (app-names.ts, stubbed here).
  {
    const named: string[] = [];
    const appsNamed = async (n: string) => {
      named.push(n);
      return ["notes", "notes.app", "备忘录"].includes(n.toLowerCase()) ? ["com.apple.Notes"] : n === "Agent Host" ? ["com.example.agenthost"] : [];
    };
    const asked: string[] = [];
    let answer = true;
    const consent = {
      available: () => true,
      ask: async (_m: string, meta: Record<string, unknown>) => {
        asked.push((meta["mirasim-computer-use/macosApp"] as { bundle: string }).bundle);
        return answer ? { allowed: true, persist: "session" as const } : { allowed: false };
      },
      onRevoke: () => {},
    };
    const store = join(mkdtempSync(join(tmpdir(), "computer-use-approvals-")), "approvals.json");
    const st = stubTransport();
    const drv = new MacosDriver({ transport: st.transport, consent, appsNamed, env: { COMPUTER_USE_MACOS_APPROVALS: store, COMPUTER_USE_HOST_APPS: "com.example.agenthost" } });
    const h = createHarness(drv);

    const byName = await drv.unlistedTarget("Notes");
    const byLocal = await drv.unlistedTarget("备忘录");
    check("a quit app resolves by its English file name and by its localized name",
      byName?.id === "com.apple.Notes" && byLocal?.id === "com.apple.Notes" && /备忘录 \(com\.apple\.Notes\) — not running; binding it starts it/.test(byName.title),
      JSON.stringify([byName, byLocal]));
    check("…a name nothing installs resolves to nothing, as before", (await drv.unlistedTarget("Nope")) === null);
    check("…and a name never resolves to the app this agent runs inside", (await drv.unlistedTarget("Agent Host")) === null);
    const before = named.length;
    await drv.unlistedTarget("com.apple.Notes");
    check("…a bundle id is not looked up as a name", named.length === before, named.join());
    const took = await h.api.focus(byName?.id ?? "").then(String, (e: Error) => e.message);
    check("…and binding the row a name found asks about that app, then starts it",
      asked.at(-1) === "com.apple.Notes" && !!findCall(st.calls, "launch") && /备忘录/.test(took), took.split("\n")[0]);

    // An app allowed ahead of time (`mirasim-cu approvals add`) is as nameable as one allowed this
    // session: a quit one gets its "not running" row, so a name match on the listing finds it.
    writeFileSync(store, JSON.stringify({ approvedBundleIdentifiers: ["com.apple.QuickTimePlayerX"] }));
    const listed = firstText(await h.targets());
    check("an app in the approvals store that is not running is listed, with the way to start it",
      /QuickTime Player \(com\.apple\.QuickTimePlayerX\) — not running; binding it starts it/.test(listed),
      listed.split("\n").find((l) => /QuickTime/.test(l)) ?? listed);

    // Under a fixed list with nobody to ask, a name is no way around the list.
    const fixed = new MacosDriver({ transport: stubTransport().transport, appsNamed, env: { COMPUTER_USE_MACOS_FALLBACK_APPS: "com.apple.TextEdit" } });
    check("under a fallback list with no way to ask, a name offers nothing outside it", (await fixed.unlistedTarget("Notes")) === null);
  }

  // ── The listing carries the apps that are NOT running, too ───────────────────────
  // A caller reads this list to pick a bundle id to name, and launchApp({bundle}) starts a quit
  // one, so whether the app is up right now does not decide whether it can be picked.
  {
    const q = stubTransport();
    const qH = createHarness(new MacosDriver({
      transport: q.transport,
      bundle: "com.apple.calculator", env: { COMPUTER_USE_MACOS_FALLBACK_APPS: "com.apple.calculator,com.apple.Notes,com.example.nope" },
    }));
    const listed = firstText(await qH.targets());
    check("an allowed app that is not running is listed, with the way to start it",
      /备忘录 \(com\.apple\.Notes\) — not running/.test(listed) && /binding it starts it/.test(listed),
      listed.split("\n").find((l) => /Notes/.test(l)) ?? listed);
    check("…and a bundle nothing installs is not listed at all — absence is the answer",
      !/com\.example\.nope/.test(listed));
    check("…while the running one keeps its pid and its window count",
      /49403.*计算器/.test(listed) && !/计算器.*not running/.test(listed));

    // The row must not be a handle whose every verb fails: switching to a quit app starts it.
    const took = await qH.api.focus("com.apple.Notes");
    check("switching to a not-running row launches it, the way launchApp does",
      /备忘录/.test(String(took)) && !!findCall(q.calls, "launch"), String(took).split("\n")[0]);

    // Without an allow-list there is no bounded set of nameable apps — every installed app on the
    // machine would qualify — so the listing stays what is running.
    const open = stubTransport();
    const openH = createHarness(new MacosDriver({ transport: open.transport, ...ONE_APP }));
    await openH.targets();
    check("without an allow-list nothing extra is asked for: there is no bounded set to list",
      !open.calls.some((c) => c.op === "installed"), JSON.stringify(open.calls.map((c) => c.op)));
  }

  // ── An unnamed session is refused, and that is all it does ───────────────────────
  // This layer does not choose which of the user's applications to operate — not the frontmost,
  // and not "the only one running", which is a fact about this instant rather than a decision.
  // The refusal names no candidates: `computer.surfaces()` already answers that, and under an
  // allow-list it answers it narrowed to the allowed apps.
  {
    const un = stubTransport();
    const unH = createHarness(new MacosDriver({ transport: un.transport }));
    const refused = firstText(await unH.observe({}));
    check("an unnamed session is refused, not guessed for",
      /no app was named/.test(refused) && /naming one is the caller's call/.test(refused)
      && /binding a quit app starts it/.test(refused), refused.split("\n")[0].slice(0, 120));
    check("…and it does not inline the app list: that is what computer.surfaces() is for",
      !/com\.apple\.calculator/.test(refused) && /computer\.surfaces\(\)/.test(refused));
    check("…and nothing was read: it refuses before asking the helper anything",
      un.calls.length === 0, JSON.stringify(un.calls.map((c) => c.op)));

    // One app running is still not a name: taking it, even saying so, would be a pick.
    const one = stubTransport();
    one.only("com.apple.calculator");
    const oneH = createHarness(new MacosDriver({ transport: one.transport }));
    check("the only app running is NOT taken unnamed — one candidate is still a choice",
      /no app was named/.test(firstText(await oneH.observe({}))));

    // And neither is an allow-list of one: a permission is not an instruction.
    const sole = stubTransport();
    const soleH = createHarness(new MacosDriver({ transport: sole.transport, env: { COMPUTER_USE_MACOS_FALLBACK_APPS: "com.apple.calculator" } }));
    check("the only ALLOWED app is not a default either — the allow-list permits, it does not choose",
      /no app was named/.test(firstText(await soleH.observe({}))) && sole.calls.length === 0);

    // A session that WAS given an app is told nothing: nothing was chosen on its behalf.
    const named = stubTransport();
    const namedH = createHarness(new MacosDriver({ transport: named.transport, ...ONE_APP }));
    check("a named session is told nothing about a choice, because none was made",
      !/no app was named/.test(firstText(await namedH.observe({}))));
  }

  // ── The app this session was GIVEN is launched on first use, in the background ──
  // Refusing would make `launchApp({bundle})` a step before every session on a quit app, over
  // a decision the model was never given: the bundle is already named and already allowed.
  {
    const cold = stubTransport();
    const coldH = createHarness(new MacosDriver({ transport: cold.transport, bundle: "com.apple.Notes" }));
    const first = firstText(await coldH.observe({}));
    check("a named app that is not running is launched and driven in ONE observe",
      !!findCall(cold.calls, "launch") && findCall(cold.calls, "tree")?.params.pid === 888 && /Interactive elements/.test(first),
      JSON.stringify(cold.calls.map((c) => c.op)));
    check("…and the observation says so, so a just-launched window is not read as one the user had open",
      /was not running/.test(first) && /background/.test(first), (first.match(/NOTE:.*/) ?? ["(no note)"])[0].slice(0, 90));
    cold.calls.length = 0;
    const second = firstText(await coldH.observe({}));
    check("…and the next observation neither launches again nor repeats the note",
      !findCall(cold.calls, "launch") && !/was not running/.test(second), JSON.stringify(cold.calls.map((c) => c.op)));

    // Not installed is the one case that still refuses — and it says both halves, because
    // "is not running" alone would send the model to launch_app for the same failure.
    const nope = stubTransport();
    const nopeH = createHarness(new MacosDriver({ transport: nope.transport, bundle: "com.example.nope" }));
    const refused = firstText(await nopeH.observe({}));
    check("a bundle nothing installs is refused with both halves: not running, and why it could not be launched",
      /could not be launched/.test(refused) && /no installed application/.test(refused), refused.split("\n")[0]);

    // Launched but not answering AX yet: the way out is time, and the note must say that rather
    // than leave an empty observation looking like an app with nothing in it.
    const slowCold = stubTransport();
    slowCold.launchReady = false;
    const slowColdH = createHarness(new MacosDriver({ transport: slowCold.transport, bundle: "com.apple.Notes" }));
    const notReadyYet = firstText(await slowColdH.observe({}));
    check("a transparently launched app that is not answering Accessibility yet points at waiting",
      /was not running/.test(notReadyYet) && /not answering Accessibility/.test(notReadyYet) && /wait\(\{ms/.test(notReadyYet),
      (notReadyYet.match(/NOTE:.*/) ?? ["(no note)"])[0].slice(0, 90));
  }

  // ── launch_app: the explicit form, for moving to ANOTHER app ──────────────────
  {
    const cold = stubTransport();
    const coldH = createHarness(new MacosDriver({ transport: cold.transport, ...ONE_APP }));
    await coldH.observe({});
    cold.calls.length = 0;
    const launched = firstText(await coldH.act("launch_app", { bundle: "com.apple.Notes" }));
    check("launch_app switches to an app this session was not given", !!findCall(cold.calls, "launch") && /备忘录/.test(launched), launched.split("\n")[0]);
    check("launch_app reports the app the launch itself returned, with no round trip in between",
      /备忘录/.test(launched) && /888/.test(launched) && cold.calls[0]?.op === "launch" && cold.calls[1]?.op !== "apps" && cold.calls[1]?.op !== "lookup",
      JSON.stringify(cold.calls.map((c) => c.op)));

    // ── The verb says the same thing the transparent path does ──────────────────────
    // Whether it found the app or started it decides what the caller may do — a window the USER
    // opened is theirs. `started` comes from the helper, which asks before it opens.
    {
      const fresh = stubTransport();
      const freshH = createHarness(new MacosDriver({ transport: fresh.transport, ...ONE_APP }));
      await freshH.observe({});
      const cold = firstText(await freshH.act("launch_app", { bundle: "com.apple.Notes" }));
      check("launch_app says it STARTED an app that was not running, in the transparent path's own words",
        /was not running/.test(cold) && /background/.test(cold) && /not a window the user had open/.test(cold),
        cold.split("\n")[0].slice(0, 110));
      // The same verb on the SAME app again: now it was already up, and saying "fresh start"
      // would be a lie about whose window it is.
      const again = firstText(await freshH.act("launch_app", { bundle: "com.apple.Notes" }));
      check("…and says the opposite when the app was already up — the windows are the user's",
        /was already running/.test(again) && /the user's own/.test(again) && !/fresh start/.test(again),
        again.split("\n")[0].slice(0, 110));

      // An app that answers Accessibility with NO window: real (a document app with everything
      // closed), and "observe() to see its window" would point at one that is not there.
      const bare = stubTransport();
      bare.launchWindowless = true;
      const bareH = createHarness(new MacosDriver({ transport: bare.transport, ...ONE_APP }));
      await bareH.observe({});
      const none = firstText(await bareH.act("launch_app", { bundle: "com.apple.Notes" }));
      check("a launch that leaves no window says so, instead of promising one to observe",
        /has no window open/.test(none) && !/observe\(\) to see its window/.test(none) && /menu\(\{\}\)/.test(none),
        none.split("\n")[0].slice(0, 110));

      // The same sentence is owed to a READ: an app already the target that has since closed every
      // window must not answer with the helper's bare `app <pid> has no window`, which a model reads
      // as "retry" and loops on.
      const closed = stubTransport();
      const closedH = createHarness(new MacosDriver({ transport: closed.transport, ...ONE_APP }));
      await closedH.observe({});
      closed.windowsGone = true;
      const gone = firstText(await orReason(closedH.observe({})));
      check("a read of an app whose windows are all closed says what that state is, not just the pid",
        /has no window open/.test(gone) && /menu\(\{\}\)/.test(gone) && !/has no window$/m.test(gone), gone.split("\n")[0].slice(0, 120));
      // …and the wording is NOT applied to the other states `no_window` also carries: a locked
      // screen and an off-Space window each already say something truer (the checks above).
      const spaced = stubTransport();
      const spacedH = createHarness(new MacosDriver({ transport: spaced.transport, ...ONE_APP }));
      await spacedH.observe({});
      spaced.offScreen = true;
      const elsewhere = firstText(await orReason(spacedH.observe({})));
      check("…while a window on another Space keeps its own reason rather than being called closed",
        !/has no window open/.test(elsewhere), elsewhere.split("\n").find((l) => /Space|minimis/.test(l)) ?? elsewhere.split("\n")[0]);

      // The other half of the same sentence: the window IS there and is still not the
      // app's own. A cold TextEdit lands on its Open panel (`ident=open-panel`).
      const panel = stubTransport();
      panel.launchPanelOnly = true;
      const panelH = createHarness(new MacosDriver({ transport: panel.transport, ...ONE_APP }));
      await panelH.observe({});
      const asked = firstText(await panelH.act("launch_app", { bundle: "com.apple.Notes" }));
      check("a launch that lands on an Open panel says so, and does not call it the app's window",
        /asking which document to open/.test(asked) && !/observe\(\) to see its window/.test(asked)
        && /openAndSavePanelService/.test(asked) && /BY REF/.test(asked),
        asked.split("\n")[0].slice(0, 120));

      // And the transparent path says the same thing.
      const coldPanel = stubTransport();
      coldPanel.launchPanelOnly = true;
      const coldPanelH = createHarness(new MacosDriver({ transport: coldPanel.transport, bundle: "com.apple.Notes" }));
      check("…and so does the launch the session does on its own",
        /asking which document to open/.test(firstText(await coldPanelH.observe({}))));
    }

    // An app that is up but not yet answering AX must not be reported as plainly ready: the helper
    // already waited, so the way out is time, not another launch.
    const slow = stubTransport();
    slow.launchReady = false;
    const slowH = createHarness(new MacosDriver({ transport: slow.transport, bundle: "com.apple.Notes" }));
    const notReady = firstText(await slowH.act("launch_app", { bundle: "com.apple.Notes" }));
    const notReadyNote = notReady.slice(notReady.indexOf("NOTE:"));
    check("a launch whose app is not answering Accessibility yet says so and points at waiting, not at launching again",
      /not answering Accessibility/.test(notReadyNote) && /wait/.test(notReadyNote) && !/launch_app/.test(notReadyNote), notReadyNote.split("\n")[0]);

    // The helper is resident, so its `apps` snapshot never contains an app that started later.
    // One observe must still drive it — no reopened session, no restarted helper.
    cold.calls.length = 0;
    const afterLaunch = firstText(await coldH.observe({}));
    check("an app launched AFTER the helper started is drivable in one observe",
      !/not running/.test(afterLaunch) && findCall(cold.calls, "tree")?.params.pid === 888, afterLaunch.split("\n")[0]);
  }

  // ── An off-screen window is named, never rendered as an app without controls ──
  {
    const off = stubTransport();
    const offDriver = new MacosDriver({ transport: off.transport, bundle: "com.apple.calculator" });
    const offH = createHarness(offDriver);
    off.offScreen = true;
    off.locked = true;

    const locked = firstText(await orReason(offH.observe({})));
    check("a locked screen is named, and the empty read is not offered as an element list",
      /LOCKED/.test(locked) && /unlock/.test(locked) && !/Interactive elements/.test(locked) && !/\(none\)/.test(locked), locked);
    check("the locked answer says the app does have controls, and points at pixels before giving up",
      /HAS controls/.test(locked) && /screenshot\(\)/.test(locked) && /stop/.test(locked), locked);
    const lockedText = firstText(await orReason(offH.observe({ what: "text" })));
    check("the text channel refuses with the same reason, rather than answering empty text",
      /LOCKED/.test(lockedText), lockedText);
    const lockedTargets = firstText(await orReason(offH.targets()));
    check("the targets listing names the lock next to the window count it cannot address",
      /none on screen/.test(lockedTargets) && /LOCKED/.test(lockedTargets), lockedTargets.split("\n").find((l) => /计算器/.test(l)) ?? lockedTargets);

    // Under a real lock the window-scoped capture still answers from the backing store while the
    // tree reads zero elements — so pixels are a live route.
    off.shotOffScreen = true;
    const lockedPixels = firstText(await orReason(offH.observe({ what: "screenshot" })));
    check("pixels can still answer while the tree cannot — the capture is not refused on principle",
      /Screenshot captured/.test(lockedPixels) && !/LOCKED/.test(lockedPixels), lockedPixels);
    off.shotOffScreen = false;
    const lockedShot = firstText(await orReason(offH.observe({ what: "screenshot" })));
    check("and when the capture IS refused, it reports the same unreadable surface, not a failed shot",
      /LOCKED/.test(lockedShot) && !/screenshot failed/.test(lockedShot), lockedShot);

    off.locked = false;
    const away = firstText(await orReason(offH.observe({})));
    check("without the lock the reason is the window's own: minimised, another Space, a sleeping display",
      /not on screen/.test(away) && /another Space/.test(away) && !/LOCKED/.test(away), away);
    check("that answer points at the channel that lists reachable windows", /computer\.surfaces\(\)/.test(away), away);

    // Off the window server's list and yet the tree answers (a freshly launched app): a real read,
    // so it is listed. Only the missing GEOMETRY is worth a note.
    off.offScreenElements = true;
    const partial = firstText(await orReason(offH.observe({})));
    check("an off-screen window that still answers is listed, not refused",
      /Interactive elements/.test(partial) && /e1: /.test(partial), JSON.stringify(partial));
    check("a window with no frame is flagged about coordinates, not about completeness",
      /no frame at all/.test(partial) && /act by ref/.test(partial) && !/cannot be trusted/.test(partial), partial.split("\n")[0]);
    // A fresh pair: the same snapshot twice in a row renders as "unchanged", which would hide
    // whether the note is there.
    const framedStub = stubTransport();
    framedStub.offScreen = true;
    framedStub.offScreenElements = true;
    framedStub.framedOffScreen = true;
    const framedH = createHarness(new MacosDriver({ transport: framedStub.transport, bundle: "com.apple.calculator" }));
    const framed = firstText(await orReason(framedH.observe({})));
    check("an off-screen window that still has a frame gets no note at all — a complete read is not flagged",
      /Interactive elements/.test(framed) && !/no frame at all/.test(framed), framed.split("\n")[0]);
  }

  // ── Only the app under control is ever asked about ──
  {
    const scoped = stubTransport();
    // Named as well as allowed: an allow-list of one is a permission, never a default.
    const scopedH = createHarness(new MacosDriver({ transport: scoped.transport, bundle: "com.apple.TextEdit", env: { COMPUTER_USE_MACOS_FALLBACK_APPS: "com.apple.TextEdit" } }));
    await scopedH.observe({});
    check("a named app is resolved by asking about THAT bundle alone, never by enumerating",
      JSON.stringify(findCall(scoped.calls, "lookup")?.params.bundles) === '["com.apple.TextEdit"]' && !scoped.calls.some((c) => c.op === "apps"),
      JSON.stringify(findCall(scoped.calls, "lookup")?.params));
    scoped.calls.length = 0;
    await scopedH.targets();
    check("the targets listing under an allow-list asks for the allowed bundles and enumerates nothing",
      JSON.stringify(findCall(scoped.calls, "lookup")?.params.bundles) === '["com.apple.TextEdit"]' && !scoped.calls.some((c) => c.op === "apps"),
      JSON.stringify(scoped.calls.map((c) => c.op)));
  }

  // ── the refs a caller holds survive a visit to another app and back ──
  // Binding a different app must not clear the signature → ref map, or every ref of an unchanged
  // window is re-minted on coming back and the one the caller holds refused. A task spanning two
  // apps needs ref identity across that boundary. Keyed per window (driver-read.ts `refsByWindow`).
  {
    const trip = stubTransport();
    const tripH = createHarness(new MacosDriver({ transport: trip.transport }));
    await tripH.api.focus("49403"); // Calculator
    const before = (await tripH.api.observe()).elements.find((e) => e.name === "7");
    await tripH.api.focus("777"); // TextEdit — a different bundle, so a different map
    const away = (await tripH.api.observe()).elements.find((e) => e.name === "7");
    await tripH.api.focus("49403"); // and back
    const after = (await tripH.api.observe()).elements.find((e) => e.name === "7");
    check("a ref survives a round-trip to another app", !!before?.ref && before.ref === after?.ref,
      `${before?.ref} → ${after?.ref}`);
    check("…while the other app's window mints its own, so no two windows are handed the same ref",
      !!away?.ref && away.ref !== before?.ref, `${before?.ref} vs ${away?.ref}`);
    check("…and the ref the caller was still holding acts, with no re-observation in between",
      await tripH.api.click(before!.ref).then(() => true, () => false));
  }

  // ── a window the window server does not number keys per APP, and that is the right unit ──
  // `listTargets` never hands out `<pid>:-1`: windows with no window-server id are reachable only
  // through the app-level target, so to a caller they ARE one surface — which is why
  // `refsByWindow` keys on the raw id and not on `pinnable()`.
  {
    const un = stubTransport();
    un.offScreen = true; un.offScreenElements = true; // id -1, and the tree still answers
    const unH = createHarness(new MacosDriver({ transport: un.transport }));
    await unH.api.focus("49403");
    const first = (await unH.api.observe()).elements[0];
    await unH.api.focus("777");
    const other = (await unH.api.observe()).elements[0];
    await unH.api.focus("49403");
    const back = (await unH.api.observe()).elements[0];
    check("an app whose window carries no window-server id keeps its refs across a round-trip too",
      !!first?.ref && first.ref === back?.ref, `${first?.ref} → ${back?.ref}`);
    check("…and the map is the APP's, so another app's unnumbered window is handed its own refs",
      !!other?.ref && other.ref !== first?.ref, `${first?.ref} vs ${other?.ref}`);
  }

  // ── remembering is bounded, and it is the oldest window that is forgotten ──
  // The map is per window, so a session that tours an app must not grow without bound. What is
  // pinned is the BEHAVIOUR, not the constant: visit far more windows than the cap, and the first
  // one has to mint fresh while the most recent is handed back unchanged.
  {
    const many = stubTransport();
    const manyH = createHarness(new MacosDriver({ transport: many.transport }));
    await manyH.api.focus("49403");
    const refAt = async (id: number) => {
      many.treeWindowId = id;
      return (await manyH.api.observe()).elements[0]?.ref;
    };
    const first = await refAt(1);
    for (let id = 2; id <= 20; id++) await refAt(id);
    const newest = await refAt(20);
    check("a window seen 20 windows ago is forgotten, so coming back to it mints fresh refs",
      !!first && (await refAt(1)) !== first, `was ${first}`);
    check("…while a window still in the map is handed its refs back unchanged",
      !!newest && (await refAt(20)) === newest, `${newest}`);
  }

  // ── A handle made from a BUNDLE ID keeps its refs across the binds every verb performs ──
  // A handle taken by bundle id never equals `activeTarget` (`pid:window` once the app is up), so
  // every verb re-binds it through `launch` — which must not forget the app, or the ref the
  // caller just observed is refused as stale on the first click.
  {
    const st = stubTransport();
    const drv = new MacosDriver({ transport: st.transport, env: { COMPUTER_USE_MACOS_FALLBACK_APPS: "com.apple.Notes" } });
    const h = createHarness(drv);
    await h.api.focus("com.apple.Notes"); // not running: this launches it
    const ref = (await h.api.observe()).elements[0]?.ref;
    await h.api.focus("com.apple.Notes"); // the re-bind a by-bundle handle causes on every verb
    const acted = await h.api.click(String(ref)).then((r) => r, (e: Error) => e.message);
    check("a ref survives the re-bind of a by-bundle handle (launch only forgets a DIFFERENT app)",
      !!ref && !/not among the refs/.test(acted), `${ref}: ${acted.split("\n")[0]}`);
    check("…and the driver says it is already there rather than launching again",
      await drv.isActiveTarget("com.apple.Notes"), "isActiveTarget(bundle)");
  }

  console.log(`\nmacos-windows: ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
