/**
 * The macOS mouse, hermetically — `node scripts/test.mjs macos-mouse`.
 *
 * Same stubbed helper as `test/macos-ui.ts` (a Calculator that honours AXPress by moving its display,
 * or ignores it when `pressInert` is set — the Electron case measured on ChatGPT), driven
 * through the repl's API. What is pinned is the DECISION in click-verb.ts: an honoured press is never
 * followed by a mouse click; an ignored one is, at the element's centre in screen points; right,
 * middle, double and drag are mouse-only; a point another app's window covers is activated past,
 * never clicked into that app. Keep it ONE file: every block runs on the SAME driver and
 * PressMemory, and several check what that memory learned from the blocks before (two ignored
 * presses put the mouse first; a redo is armed by the click before it) — split, they would pass
 * against a memory that never learned anything. The session IS the fixture here.
 * Repeat-safe fallback cases explicitly pass retry:true; the default does not replay an
 * uncertain AX press.
 */

import { createHarness } from "./harness.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { findCall, ONE_APP, stubTransport } from "./macos-fixtures.ts";
import { WINDOW } from "./macos-stub-app.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";

/**
 * The user is at the keyboard: the FALLBACK waits for them, what the model asked for does not.
 *
 * A tap-posted click raises the app, so the human's next keystrokes would land in the window we
 * just brought forward (mouse.ts `yieldToHuman`).
 *
 * Its own driver, and so its own {@link PressMemory}: the ignored presses these checks leave
 * would skew the shared session's redo and mouse-goes-first checks.
 */
async function humanAtTheKeyboard() {
  const stub = stubTransport();
  const h = createHarness(new MacosDriver({ transport: stub.transport, ...ONE_APP }));
  await h.observe({});

  stub.pressInert = true;
  stub.humanIdle = 0.2;
  stub.calls.length = 0;
  const busy = firstText(await h.act("click", { ref: "e3", retry: true }));
  check("a mouse FALLBACK is held back while the user is typing — nothing is posted, and nothing changed",
    !findCall(stub.calls, "mouse") && /No mouse event was posted/.test(busy), busy.split("\n")[0]);
  check("…and the refusal carries BOTH halves: why the mouse was next, and how long ago the user touched the machine",
    /accepted but nothing in the window changed/.test(busy) && /0\.2 s ago/.test(busy) && /activate first/.test(busy),
    busy.split("\n")[0]);
  check("…the press itself still ran: the rungs that cost the user nothing are never what gets skipped",
    !!findCall(stub.calls, "press"), stub.calls.map((c) => c.op).join(","));

  // An app that HAS honoured presses, whose press is now accepted-and-inert, and no mouse to
  // check with: the action most likely landed with nothing to do (clearing an already-clear
  // Calculator), so it must not be reported as a failure.
  stub.pressInert = false;
  stub.humanIdle = 30;
  await h.act("click", { ref: "e3", retry: true });            // this one takes effect → honoured
  stub.pressInert = true;
  stub.humanIdle = 0.2;
  stub.calls.length = 0;
  const honoured = await h.act("click", { ref: "e3", retry: true });
  check("an accepted press on an app that has honoured presses is not reported as a failure when the mouse cannot check",
    honoured.ok && !findCall(stub.calls, "mouse"), firstText(honoured).split("\n")[0].slice(0, 120));
  check("…and the note claims only what is known: the press landed, the confirmation did not happen",
    /HAS honoured AXPress/.test(firstText(honoured)) && /Observe before/.test(firstText(honoured)),
    firstText(honoured).slice(-120));
  stub.pressInert = true;
  stub.humanIdle = 0.2;

  stub.calls.length = 0;
  const asked = await h.act("click", { ref: "e3", button: "right" });
  check("a right click is the model asking for the one thing only the mouse does — the guard does not touch it",
    asked.ok && !!findCall(stub.calls, "mouse"), asked.note);

  // A helper too old to answer must leave the fallback as if the guard did not exist: that is a
  // host app still on an older helper, and failing closed there would break clicking.
  stub.frontmost = false;
  stub.noHumanIdle = true;
  stub.calls.length = 0;
  const oldHelper = await h.act("click", { ref: "e3", retry: true });
  check("a helper that predates the op fails OPEN — the mouse fallback runs as it did before the guard",
    !!findCall(stub.calls, "mouse"), oldHelper.note);
}

async function main() {
  const stub = stubTransport();
  const driver = new MacosDriver({ transport: stub.transport, ...ONE_APP });
  const h = createHarness(driver);
  await h.observe({});

  // ── An honoured press is the click; nothing is posted after it ─────────────────────────
  stub.calls.length = 0;
  const honoured = await h.act("click", { ref: "e3", retry: true });
  check("a press the app honoured is the click — AXPress on the element's key, no mouse event after it",
    honoured.ok && String(findCall(stub.calls, "press")?.params.key).startsWith("k6g") && !findCall(stub.calls, "mouse"), honoured.note);
  check("the walk before the press is the baseline, the walk after is the evidence (two walks around one press)",
    stub.calls.filter((c) => c.op === "tree").length >= 2 && stub.calls.findIndex((c) => c.op === "press") > stub.calls.findIndex((c) => c.op === "tree") && stub.calls.findIndex((c) => c.op === "press") < stub.calls.map((c) => c.op).indexOf("tree", stub.calls.findIndex((c) => c.op === "tree") + 1),
    stub.calls.map((c) => c.op).join(","));

  // ── An accepted-and-ignored press falls back to the mouse at the element's centre ──────
  // Button 7 is 48×48 at screen (1612,66) in the fixture: centre (1636,90) = window frame + (34,211).
  stub.pressInert = true;
  stub.calls.length = 0;
  const inert = firstText(await h.act("click", { ref: "e3", retry: true }));
  const inertMouse = findCall(stub.calls, "mouse");
  check("an AXPress the app accepted but ignored falls back to a mouse click, and the note says why and what it cost",
    !!findCall(stub.calls, "press") && !!inertMouse && /accepted but nothing in the window changed within 800 ms/.test(inert) && /can bring 计算器 to the front/.test(inert),
    inert.split("\n")[0]);
  check("…posted at the element's centre in screen points, left button, once",
    inertMouse?.params.x === WINDOW.x + 34 && inertMouse?.params.y === WINDOW.y + 211 && inertMouse?.params.button === "left" && inertMouse?.params.count === 1,
    JSON.stringify(inertMouse?.params));
  stub.pressInert = false;
  stub.frontmost = false;

  await humanAtTheKeyboard();

  // ── A press whose whole effect is a new window is honoured: the window list is evidence too ──
  await h.act("click", { ref: "e3", retry: true }); // honoured: the ignored count above goes back to zero
  stub.pressInert = true;
  stub.pressOpensSheet = true;
  stub.calls.length = 0;
  const sheet = await h.act("click", { ref: "e3", retry: true });
  check("a press that changes nothing in the walked window but opens a sheet is honoured — no mouse click follows it",
    sheet.ok && !!findCall(stub.calls, "windows") && !findCall(stub.calls, "mouse"), sheet.note);
  stub.pressOpensSheet = false;
  stub.extraWindow = false;
  stub.pressInert = false;

  // ── An irreversible control is never redone unasked; the model's second click is the decision ──
  stub.sendButton = true;
  const withSend = firstText(await h.observe({}));
  const sendRef = withSend.split("\n").find((l) => /button "Send"/.test(l))?.match(/(e\d+)/)?.[1] ?? "";
  stub.pressInert = true;
  stub.calls.length = 0;
  const sendOnce = firstText(await h.act("click", { ref: sendRef }));
  check("an accepted-and-ignored press on button \"Send\" is NOT followed by a mouse click, and the note says why and what a second click means",
    !!findCall(stub.calls, "press") && !findCall(stub.calls, "mouse") && /twice could act twice/.test(sendOnce) && /click it again/.test(sendOnce), sendOnce.split("\n")[0]);
  stub.calls.length = 0;
  const sendTwice = firstText(await h.act("click", { ref: sendRef }));
  check("the second click on the same control goes straight to the mouse — no press, and the note names the decision",
    !findCall(stub.calls, "press") && !!findCall(stub.calls, "mouse") && /second click is the decision/.test(sendTwice), sendTwice.split("\n")[0]);
  stub.frontmost = false;
  // The per-app count stands at one (the ignored Send); a honoured press first, or the next ignored
  // press would make the app remembered and no press would be attempted again this session.
  stub.pressInert = false;
  await h.act("click", { ref: "e3", retry: true });
  stub.pressInert = true;
  await h.act("click", { ref: sendRef }); // armed again…
  stub.pressInert = false;
  await h.act("click", { ref: "e3", retry: true }); // …and a click elsewhere drops it (and, honoured, resets the count)
  stub.pressInert = true;
  stub.calls.length = 0;
  const sendAgain = firstText(await h.act("click", { ref: sendRef }));
  check("a click elsewhere in between drops the redo: the next click on \"Send\" is measured afresh, not sent to the mouse",
    !!findCall(stub.calls, "press") && !findCall(stub.calls, "mouse") && /twice could act twice/.test(sendAgain), sendAgain.split("\n")[0]);
  stub.pressInert = false;
  stub.sendButton = false;
  await h.observe({});

  // ── A helper that predates the mouse: the AX result stands, the note names what is missing ──
  await h.act("click", { ref: "e3", retry: true }); // honoured: count back to zero
  stub.noMouse = true;
  stub.pressInert = true;
  stub.calls.length = 0;
  const oldFallback = await h.act("click", { ref: "e3", retry: true });
  check("an ignored press on an old helper is not an exception: the press's result stands and the note says the helper predates mouse events",
    oldFallback.ok && /predates mouse events/.test(oldFallback.note ?? "") && /accepted but nothing/.test(oldFallback.note ?? ""), oldFallback.note);
  const oldRight = firstText(await h.act("click", { ref: "e3", button: "right" }));
  check("a right click on an old helper is refused with the same note, no exception", /predates mouse events/.test(oldRight) && /right click/.test(oldRight), oldRight.split("\n")[0]);
  const oldDrag = firstText(await h.act("drag", { ref: "e3", toRef: "e2" }));
  check("drag likewise", /predates mouse events/.test(oldDrag) && /drag/.test(oldDrag), oldDrag.split("\n")[0]);
  stub.noMouse = false;
  stub.pressInert = false;
  await h.act("click", { ref: "e3", retry: true }); // honoured: the count is back to zero for the blocks below
  stub.frontmost = false;

  // ── A substitute action (AXOpen) is never followed by a click: it may have done more ───
  stub.sourceList = true;
  const listing = firstText(await h.observe({}));
  const cellRef = listing.split("\n").find((l) => /e\d+: cell\b/.test(l))?.match(/(e\d+)/)?.[1] ?? "";
  stub.calls.length = 0;
  const opened = firstText(await h.act("click", { ref: cellRef }));
  check("a cell whose click is AXOpen runs AXOpen and is not clicked again", findCall(stub.calls, "press")?.params.action === "AXOpen" && !findCall(stub.calls, "mouse") && /AXOpen ran instead/.test(opened), opened.split("\n")[0]);
  stub.sourceList = false;
  await h.observe({});

  // ── Right, middle, double: mouse from the start ─────────────────────────────────────────
  stub.calls.length = 0;
  const right = firstText(await h.act("click", { ref: "e3", button: "right" }));
  check("a right click is a mouse event from the start — AXPress cannot say it — and no press is sent",
    findCall(stub.calls, "mouse")?.params.button === "right" && !findCall(stub.calls, "press") && /right-clicked button "7"/.test(right), right.split("\n")[0]);
  stub.calls.length = 0;
  const middle = firstText(await h.act("click", { ref: "e3", button: "middle" }));
  check("a middle click likewise", findCall(stub.calls, "mouse")?.params.button === "middle" && /middle-clicked/.test(middle), middle.split("\n")[0]);
  stub.calls.length = 0;
  const twice = firstText(await h.act("click", { ref: "e3", count: 2 }));
  check("a double click is one mouse op with count 2", findCall(stub.calls, "mouse")?.params.count === 2 && /2× clicked/.test(twice), twice.split("\n")[0]);
  stub.calls.length = 0;
  const wrongName = firstText(await h.act("click", { ref: "e3", name: "乘", button: "right" }));
  check("a ref checked against the wrong name is refused before anything is posted, mouse route included",
    !findCall(stub.calls, "mouse") && /乘/.test(wrongName), wrongName.split("\n")[0]);
  stub.frontmost = false;

  // ── Drag ────────────────────────────────────────────────────────────────────────────────
  stub.calls.length = 0;
  const dragged = firstText(await h.act("drag", { ref: "e3", toRef: "e2" }));
  const drag = findCall(stub.calls, "drag");
  check("drag goes from one element's centre to the other's, in screen points",
    drag?.params.x === WINDOW.x + 34 && drag?.params.y === WINDOW.y + 211 && drag?.params.toX === 1666 + 24 && drag?.params.toY === 12 + 24 && /dragged button "7" to button "全部清除"/.test(dragged),
    JSON.stringify(drag?.params) + " · " + dragged.split("\n")[0]);
  stub.calls.length = 0;
  const halfDrag = firstText(await h.act("drag", { ref: "e3" }));
  check("a drag without a destination is refused, nothing posted", !findCall(stub.calls, "drag") && /needs a destination/.test(halfDrag), halfDrag.split("\n")[0]);
  stub.frontmost = false;

  // ── A covered point: activate first, then the click; never into the other app ─────────
  stub.covered = true;
  stub.calls.length = 0;
  const coveredRight = firstText(await h.act("click", { ref: "e3", button: "right" }));
  check("a point another app's window covers is never clicked into that app: the app is activated first, then the click goes through",
    stub.calls.map((c) => c.op).filter((op) => op === "mouse" || op === "activate").join(",") === "mouse,activate,mouse"
      && /requested to come to the front first/.test(coveredRight) && /right-clicked button "7"/.test(coveredRight),
    coveredRight.split("\n")[0]);
  stub.covered = false;
  stub.frontmost = false;

  // ── An AXError is a report about the CALL, not a verdict on the EFFECT ────────────────
  // Word's start gallery: AXPress answers -25205 and opens the document anyway. Trusting the
  // error would cost the user their front window for a press that landed; the baseline shows it.
  stub.pressErrorsButActs = true;
  stub.calls.length = 0;
  const erredButActed = await h.act("click", { ref: "e3", retry: true });
  check("a press that ERRORS but changes the window is not redone with the mouse — the app stays where it was",
    erredButActed.ok && !findCall(stub.calls, "mouse"), stub.calls.map((c) => c.op).join(","));
  check("…and the note says which of the two the error was about",
    /the error was about the call, not about the effect/.test(firstText(erredButActed)),
    firstText(erredButActed).split("\n")[0]);
  stub.pressErrorsButActs = false;

  // The other half, unchanged: an error with nothing behind it is still the mouse's.
  stub.calls.length = 0;
  stub.refuseAction = "AXPress";
  const erredAndDidNothing = firstText(await h.act("click", { ref: "e3", retry: true }));
  check("a press that errors and changes NOTHING still falls through to the mouse",
    !!findCall(stub.calls, "mouse"), erredAndDidNothing.split("\n")[0]);
  stub.refuseAction = null;
  stub.frontmost = false;

  // ── A hit test that ERRORS is no information, not a refusal ───────────────────────────
  // Excel's grid answers AXError -25208 to `at` for every point in the sheet, and a self-drawn
  // area with no node of its own is exactly what a point click exists to reach.
  stub.hitTestErrors = true;
  // A point is a pixel of the LAST SCREENSHOT, so a session that never took one has no scale to
  // map it with and the verb refuses rather than guessing (driver.ts `toScreen`). Taking one is
  // what a caller does before reading coordinates off a picture.
  await h.api.screenshot({});
  stub.calls.length = 0;
  const hitErr = await h.act("click", { x: 20, y: 30 });
  check("a point whose hit test ERRORS still gets the mouse event — the verb's whole purpose",
    hitErr.ok && !!findCall(stub.calls, "mouse"), stub.calls.map((c) => c.op).join(","));
  check("…and the note says the tree could not answer, not that nothing was there",
    /could not say what is under the point/.test(firstText(hitErr)), firstText(hitErr).split("\n")[0]);
  stub.hitTestErrors = false;
  stub.frontmost = false;

  // ── Ungranted: the press names the grant, the baseline walk that failed says nothing ───
  stub.trusted = false;
  stub.calls.length = 0;
  const ungranted = await h.act("click", { ref: "e3", retry: true }).catch((e: Error) => ({ ok: false, note: e.message, content: [] as Array<{ type: string; text?: string }> }));
  check("without Accessibility the click names the ACT grant, not a tree that could not be read, and posts no mouse event",
    /nothing can be pressed, typed or scrolled/.test(firstText(ungranted) || ungranted.note) && !findCall(stub.calls, "mouse"),
    (firstText(ungranted) || ungranted.note).split("\n")[0]);
  stub.trusted = true;

  // ── Per-app memory: two ignored presses in a row, and the mouse goes first ─────────────
  // The inert click above was one and nothing since was a HONOURED press (substitutes and mouse routes
  // do not count either way), so clear it with one honoured press and start the count from zero.
  stub.pressInert = false;
  await h.act("click", { ref: "e3", retry: true });
  stub.pressInert = true;
  await h.act("click", { ref: "e3", retry: true });
  stub.calls.length = 0;
  await h.act("click", { ref: "e3", retry: true });
  check("the second ignored press still tried AXPress (one miss could be the settle racing a redraw)", !!findCall(stub.calls, "press"), stub.calls.map((c) => c.op).join(","));
  stub.calls.length = 0;
  const remembered = firstText(await h.act("click", { ref: "e3", retry: true }));
  check("the third click on that app goes to the mouse first: no baseline walk, no press, and the note says on what evidence",
    !findCall(stub.calls, "press") && !!findCall(stub.calls, "mouse") && stub.calls.filter((c) => c.op === "tree").length <= 1
      && /has ignored AXPress 2 times this session, so the mouse goes first/.test(remembered),
    remembered.split("\n")[0] + " · " + stub.calls.map((c) => c.op).join(","));
  stub.pressInert = false;
  stub.calls.length = 0;
  const heldEvenIfFixed = firstText(await h.act("click", { ref: "e3", retry: true }));
  check("the memory holds for the session — an app that starts honouring AXPress is measured again next session, not this one",
    !findCall(stub.calls, "press") && /mouse goes first/.test(heldEvenIfFixed), heldEvenIfFixed.split("\n")[0]);
  stub.frontmost = false;

  // ── the point the tree gives may not be the control's ─────────────────────────
  // A hover-gated web control is reported with a COLLAPSED frame, so a by-ref mouse fallback can
  // post its event onto whatever really sits there. A HINT, not a refusal: AX's hit test answers an
  // unnamed AXGroup at the centre of every Chromium control, so nothing tells a collapsed frame
  // from a good one, and a guard built on it would refuse every web button.
  //
  // The hint waits for the VERDICT (the driver's frozen hook): advice for a failure must not ride
  // a click that worked, so it is said only when nothing moved.
  stub.collapsed = true;
  stub.calls.length = 0;
  const collapsedObs = firstText(await h.observe({}));
  const copyRef = collapsedObs.split("\n").find((l) => /"Copy message"/.test(l))?.match(/(e\d+)/)?.[1] ?? "";
  const worked = firstText(await h.act("click", { ref: copyRef }));
  check("a by-ref mouse fallback that CHANGED the window says nothing about collapsed frames",
    !/COLLAPSED/.test(worked), worked.split("\n")[0].slice(-110));
  stub.mouseInert = true;   // the click lands somewhere else and nothing moves
  stub.calls.length = 0;
  const hinted = firstText(await h.act("click", { ref: copyRef }));
  check("...and one that changed NOTHING says what it could not promise — the rect may not be the control's",
    /COLLAPSED/.test(hinted) && /hover it, re-observe/.test(hinted) && /click by x\/y/.test(hinted),
    hinted.split("\n").find((l) => /COLLAPSED/.test(l))?.slice(0, 110) ?? hinted.split("\n")[0]);
  stub.calls.length = 0;
  const byPoint = firstText(await h.act("click", { x: 96, y: 374 }));
  check("...and a click BY COORDINATES does not carry it — there is no ref whose rect could be wrong",
    !/COLLAPSED/.test(byPoint), byPoint.split("\n")[0].slice(0, 90));
  stub.mouseInert = false;
  stub.collapsed = false;
  stub.frontmost = false;

  // ── scroll goes to the point the caller NAMED ─────────────────────────────────
  // The window's centre is another pane in a multi-pane app, and the off-screen note tells the
  // model to "scroll ref:<an element inside that area>", so the verb has to mean it.
  stub.calls.length = 0;
  const scrolledRef = firstText(await h.act("scroll", { ref: "e3", direction: "down" }));
  const wheel = findCall(stub.calls, "scroll");
  check("scroll at a ref wheels at THAT element's centre, not the window's",
    wheel?.params.x === 1636 && wheel?.params.y === 90 && Number(wheel?.params.dy) > 0,
    JSON.stringify(wheel?.params));
  check("...and the note says where it went, so a scroll that moved nothing is diagnosable",
    /at button "7"'s centre/.test(scrolledRef), scrolledRef.split("\n")[0]);
  stub.calls.length = 0;
  await h.act("scroll", { direction: "down" });
  const bare = findCall(stub.calls, "scroll");
  check("scroll with no ref still wheels at the window's centre",
    bare?.params.x === WINDOW.x + WINDOW.w / 2 && bare?.params.y === WINDOW.y + WINDOW.h / 2,
    JSON.stringify(bare?.params));
  const staleScroll = await h.act("scroll", { ref: "e404", direction: "down" });
  check("...and a stale ref is refused rather than wheeling somewhere nothing asked for",
    !staleScroll.ok && /not among the refs currently in play|stale/.test(firstText(staleScroll)), firstText(staleScroll).split("\n")[0]);

  // ── A ref the window does not SHOW: every AX rung reaches it, the pointer cannot ──
  // The walk lists what lies outside the window, so `find` can name a row scrolled out of a
  // list. Its frame is real and off screen: a mouse event there lands on the desktop or another
  // window. Finder rows advertise AXOpen and no AXPress, so this is the path a found row takes.
  {
    const away = stubTransport();
    away.scrolledAway = true;
    const awayH = createHarness(new MacosDriver({ transport: away.transport, ...ONE_APP }));
    const hidden = await awayH.api.find("报告 2025.pdf") as { ref: string } | null;
    check("a row outside the window is findable at all", !!hidden, JSON.stringify(hidden));
    away.calls.length = 0;
    const doubled = await awayH.act("click", { ref: hidden!.ref, count: 2 });
    check("a double click on it is refused before any event is posted",
      !doubled.ok && /not on screen/.test(firstText(doubled)) && !findCall(away.calls, "mouse"), firstText(doubled).split("\n")[0].slice(0, 100));
    check("...and the refusal names the routes that DO work, rather than another element",
      /axAction\(/.test(firstText(doubled)) && /scroll it into view/.test(firstText(doubled)));
    const hovered = await awayH.act("hover", { ref: hidden!.ref });
    check("hover is refused the same way", !hovered.ok && /not on screen/.test(firstText(hovered)) && !findCall(away.calls, "hover"));
  }

  // ── The pointer-free rung: the area's own page action, before the wheel ───────
  // The wheel rides the session tap, so a covering window (a full-screen terminal) stops
  // `scroll` unless the app is raised and the user's keyboard taken.
  stub.calls.length = 0;
  stub.scrollArea = true;   // the stub app has none by default, like the real Calculator window
  stub.scrollAt = 0;
  const byPage = firstText(await h.act("scroll", { direction: "down" }));
  check("scroll turns a page through the app's own area and posts NO wheel",
    !!findCall(stub.calls, "scrollpage") && !findCall(stub.calls, "scroll"),
    JSON.stringify(stub.calls.map((c) => c.op)));
  check("...and says so, because which rung acted is the user's business",
    /1 page down/.test(byPage) && /pointer never moved/.test(byPage), byPage.split("\n")[0]);

  stub.calls.length = 0;
  stub.scrollAt = 0;
  const pagedCount = firstText(await h.act("scroll", { direction: "down", count: 3 }));
  check("count is pages on this rung, in one request", findCall(stub.calls, "scrollpage")?.params.pages === 3 && /3 pages down/.test(pagedCount), pagedCount.split("\n")[0]);

  // `to` is a REAL jump here — the helper turns pages until one moves nothing — where the wheel
  // could only ever be a long burst.
  stub.calls.length = 0;
  stub.scrollAt = 0;
  const toEnd = firstText(await h.act("scroll", { to: "bottom" }));
  check("to:'bottom' asks for every page the rung allows and reports what it really turned",
    Number(findCall(stub.calls, "scrollpage")?.params.pages) > 20 && /to the bottom/.test(toEnd) && /3 pages/.test(toEnd),
    toEnd.split("\n")[0]);
  check("...and no longer claims macOS has no jump", !/no jump-to/.test(toEnd));

  // Already at the end is an ANSWER, not a reason to try the wheel — which would only turn it
  // into a covered-window refusal.
  stub.calls.length = 0;
  const atEnd = await h.act("scroll", { direction: "down" });
  check("an area that cannot move further says so and does not fall through to the wheel",
    atEnd.ok && /already at the end/.test(firstText(atEnd)) && !findCall(stub.calls, "scroll"), firstText(atEnd).split("\n")[0]);

  // Electron exposes no scroll area at all: the wheel is not a worse rung there, it is the only one.
  stub.calls.length = 0;
  stub.scrollArea = false;
  const noArea = firstText(await h.act("scroll", { direction: "down" }));
  check("an app with no scrolling area falls through to the wheel", !!findCall(stub.calls, "scroll") && /at the window's centre/.test(noArea), noArea.split("\n")[0]);
  stub.calls.length = 0;
  stub.scrollArea = true;
  await h.act("scroll", { direction: "right" });
  check("left/right keeps the wheel — the vertical inversion is measured, the horizontal one is not",
    !!findCall(stub.calls, "scroll") && !findCall(stub.calls, "scrollpage"), JSON.stringify(stub.calls.map((c) => c.op)));
  stub.scrollArea = false; // the checks below are about the wheel itself

  // ── count: screens per call, so five screens is not five round trips ──────────
  stub.calls.length = 0;
  const far = firstText(await h.act("scroll", { direction: "down", count: 5 }));
  const farWheel = findCall(stub.calls, "scroll");
  check("scroll count carries that many screens in ONE wheel, not one screen and a dropped argument",
    Number(farWheel?.params.dy) === 5 * Number(bare?.params.dy) && stub.calls.filter((c) => c.op === "scroll").length === 1,
    JSON.stringify(farWheel?.params));
  check("...and the note says how far it was asked to go", /5 screens/.test(far), far.split("\n")[0]);
  const capped = await h.act("scroll", { direction: "down", count: 500 });
  check("an absurd count is capped rather than turned into a seek", capped.ok && /20 screens/.test(firstText(capped)), firstText(capped).split("\n")[0]);
  // Accepted-and-ignored is the failure this refusal exists to prevent: `to` already goes to the
  // end, so honouring one of the two silently would leave the caller believing it asked for both.
  const both = await h.act("scroll", { to: "bottom", count: 3 });
  check("count together with to: is refused by name, never silently dropped",
    !both.ok && /not both/.test(firstText(both)), firstText(both).split("\n")[0]);

  // ── hover: web content gates controls on the pointer ──────────────────────────
  // AX has no hover, but web content in an Electron app gates whole controls on the pointer
  // (ChatGPT's per-message Copy button is not hit-testable until the message is hovered).
  stub.calls.length = 0;
  const hovered = firstText(await h.act("hover", { ref: "e3" }));
  const move = findCall(stub.calls, "hover");
  check("hover reaches the helper as a move to the control's centre, and presses nothing",
    // e3 is the fixture's "7" at global (1612, 66), 48 × 48 — so its centre is (1636, 90).
    move?.params.x === 1636 && move?.params.y === 90 && !findCall(stub.calls, "press") && !findCall(stub.calls, "mouse"),
    JSON.stringify(move?.params));
  check("...and the note reports the real pointer movement without claiming app activation",
    /left it there/.test(hovered) && /user's real pointer/.test(hovered)
      && /no app activation was requested/.test(hovered) && !findCall(stub.calls, "activate"),
    hovered.split("\n")[0]);

  // ── The pointer by POSITION ──────────────────────────────────────────────────────────
  // `clickVerb` branches on x/y, as every driver does; the TOOL layer's `resolve` takes only a
  // ref or a handle, so this is the route for a control none of the three rungs can move.
  {
    await h.api.screenshot({});   // the scale a point is measured in — @see toScreen
    stub.calls.length = 0;
    // Window-local, like a screenshot's own coordinates — one pixel per point, so
    // the two are the same number. The fixture's window sits at (1602, −121).
    const noted = await h.api.click({ x: 34, y: 211 });
    const posted = findCall(stub.calls, "mouse");
    check("click({x, y}) posts a mouse event at that point, in screen coordinates",
      posted?.params.x === 1636 && posted?.params.y === 90, JSON.stringify(posted?.params));
    check("…and it never touched the ref machinery — no tree walk to resolve a ref that was not given",
      !stub.calls.some((c) => c.op === "tree"), JSON.stringify(stub.calls.map((c) => c.op)));
    check("…the note calls it the point, not a control it cannot name",
      /the point/.test(noted), noted.split("\n")[0].slice(0, 90));

    stub.calls.length = 0;
    await h.api.hover({ x: 34, y: 211 });
    check("hover takes one too", findCall(stub.calls, "hover")?.params.x === 1636);

    // A point is NOT a raw mouse event (the grounding text says so): with no ignored-press history
    // the point is hit-tested (`at`) and the element under it PRESSED, so the app stays behind.
    // A fresh stub, because PressMemory above has learned this bundle ignores AXPress.
    const fresh = stubTransport();
    const freshH = createHarness(new MacosDriver({ transport: fresh.transport, ...ONE_APP }));
    await freshH.api.observe();
    await freshH.api.screenshot({});   // the scale a point is measured in — @see toScreen
    fresh.calls.length = 0;
    const byPress = await freshH.api.click({ x: 34, y: 211 });
    check("a point with something pressable under it goes through AXPress, not the mouse",
      !!findCall(fresh.calls, "at") && !!findCall(fresh.calls, "press") && !findCall(fresh.calls, "mouse"),
      JSON.stringify(fresh.calls.map((c) => c.op)));
    check("…and the note names what it found there, rather than calling it a mouse click",
      /under the point/.test(byPress), byPress.split("\n")[0].slice(0, 90));

    // A point is not a way around the ref gate for things that ARE refs: a bad target still names
    // all three shapes, so the model learns the third from the refusal as well as the reference.
    let refused = "";
    try { await h.api.click(42 as never); } catch (e) { refused = (e as Error).message; }
    check("a target that is none of the three is refused, and the refusal names the point",
      /find\(\) handle/.test(refused) && /ref string/.test(refused) && /point \{x, y\}/.test(refused),
      JSON.stringify(refused));
  }

  // ── a press whose whole effect is a readout's value ──────────────────
  // Calculator labels the display ("edit field") and puts the number in the value, so a NAME-only judge
  // would read a repeated digit as ignored and let the mouse enter it twice.
  {
    const stub = stubTransport();
    stub.labelledReadout = true;
    const readoutH = createHarness(new MacosDriver({ transport: stub.transport, ...ONE_APP }));
    await readoutH.api.observe();
    stub.calls.length = 0;
    const note = await readoutH.api.click("e3");
    check("a press that moves only a labelled readout counts as having acted — no mouse, no second press",
      !findCall(stub.calls, "mouse") && stub.calls.filter((c) => c.op === "press").length === 1,
      `${JSON.stringify(stub.calls.map((c) => c.op))} · ${String(note).split("\n")[0].slice(0, 80)}`);
    const shown = (await readoutH.api.observe()).elements.find((e) => e.name === "编辑字段");
    check("…and the value the model reads is on that element's own line",
      shown?.state === "value:56,088·1", `${shown?.name} [${shown?.state}]`);
  }

  // ── a label with no action of its own is clicked through what CONTAINS it ──
  // Finder's sidebar: AXStaticText with no actions, inside a cell offering AXOpen, inside a row
  // whose selection is settable. Accessibility can do this from behind; the mouse would raise the app.
  {
    const stub = stubTransport();
    stub.sidebar = true;
    const sideH = createHarness(new MacosDriver({ transport: stub.transport, ...ONE_APP }));
    const label = (await sideH.api.observe()).elements.find((e) => e.name === "文稿");
    stub.calls.length = 0;
    const note = String(await sideH.api.click(label!.ref));
    const selected = stub.calls.find((c) => c.op === "select");
    check("a control that advertises nothing is acted on through its container — selected, not clicked with the mouse",
      !!selected && !findCall(stub.calls, "mouse"), JSON.stringify(stub.calls.map((c) => c.op)));
    check("…the row is what gets selected, and the cell's AXOpen is never run — opening a file is a double click's meaning",
      String(selected?.params.key).startsWith("kSR")
      && !stub.calls.some((c) => c.op === "press" && c.params.action === "AXOpen"),
      JSON.stringify(stub.calls.filter((c) => c.op === "press" || c.op === "select")));
    check("…and the note says what it acted on and that the app stayed where it was",
      /carries no click of its own/.test(note) && /selection was set/.test(note) && /left 计算器 where it was/.test(note),
      note.split("\n")[0].slice(0, 120));

    // The rung is for a control with NOTHING of its own: an element whose own action the app
    // refused must not be re-aimed at its container, which would act on something else entirely.
    const own = stubTransport();
    own.refuseAction = "AXPress";
    const ownH = createHarness(new MacosDriver({ transport: own.transport, ...ONE_APP }));
    await ownH.api.observe();
    own.calls.length = 0;
    await ownH.api.click("e3").catch(() => {});
    check("…and a control whose OWN action the app refused is never re-aimed at its container",
      !own.calls.some((c) => c.op === "ancestors"), JSON.stringify(own.calls.map((c) => c.op)));
  }

  // ── a control the app itself calls DISABLED never buys the user's front window ──
  // The cheap rungs still run (AXEnabled lies often enough that vetoing them would remove a
  // capability, and they cost the user nothing); only the rung that raises the app is refused.
  // The ENABLED case is pinned by the humanidle/mouse check above.
  {
    const dead = stubTransport();
    dead.pressInert = true; // the press is accepted and ignored — which is what puts the mouse next
    const deadH = createHarness(new MacosDriver({ transport: dead.transport, ...ONE_APP }));
    const off = (await deadH.api.observe()).elements.find((e) => e.name === "Disabled thing");
    dead.calls.length = 0;
    const note = await deadH.api.click(off!.ref, { retry: true }).then((n) => String(n), (e: Error) => e.message);
    check("a disabled control is still pressed, and never clicked with the mouse",
      !!findCall(dead.calls, "press") && !findCall(dead.calls, "mouse"), JSON.stringify(dead.calls.map((c) => c.op)));
    check("…and the refusal names the flag, says nothing changed, and points at the one route past it",
      /reads as disabled/.test(note) && /No mouse event was posted/.test(note) && /click\(\{x, y\}\)/.test(note),
      note.slice(0, 100));
  }

  // ── background-only: the keyboard rung is the last one, never skipped for a mouse it cannot use ──
  // ChatGPT's "Trust folder" dialog: AXPress is ignored and the mouse refused (background), but
  // focus + Space works. Its own driver: background mode, fresh memory.
  {
    const bg = stubTransport();
    const bgH = createHarness(new MacosDriver({ transport: bg.transport, bundle: ONE_APP.bundle, interaction: "background" }));
    const seven = (await bgH.api.observe()).elements.find((e) => e.name === "7")!;
    bg.pressInert = true;
    bg.calls.length = 0;
    const first = await bgH.api.click(seven.ref).then((n) => String(n), (e: Error) => e.message);
    check("background, no retry: the uncertain press names BOTH routes left, the keyboard one first, and says the mouse is out",
      /focusing it and sending one key/.test(first) && /not in a background-only call/.test(first) && !findCall(bg.calls, "mouse"),
      first.slice(0, 160));
    bg.spaceActs = true;
    bg.calls.length = 0;
    const keyed = await bgH.api.click(seven.ref, { retry: true }).then((n) => String(n), (e: Error) => e.message);
    check("background, retry: focus + Space lands the click, and no mouse event is planned or posted",
      /Space was sent/.test(keyed) && !findCall(bg.calls, "mouse") && !!findCall(bg.calls, "key"), keyed.slice(0, 160));
    bg.spaceActs = false;
    bg.calls.length = 0;
    const out = await bgH.api.click(seven.ref, { retry: true }).then((n) => String(n), (e: Error) => e.message);
    check("background, nothing answers: the refusal says the key was tried and the call is background-only — not a bare mouse error",
      /sending one key changed nothing either/.test(out) && /background-only/.test(out) && !findCall(bg.calls, "mouse"),
      out.slice(0, 200));
  }

  // ── scroll in the background: by ref through the area's own page action ───────
  // System Settings' sidebar: its rows past the window are unnamed until scrolled to, the window's
  // centre is another pane, and a background call may not post the wheel. Its own driver.
  {
    const bg = stubTransport();
    const bgH = createHarness(new MacosDriver({ transport: bg.transport, bundle: ONE_APP.bundle, interaction: "background" }));
    const seven = (await bgH.api.observe()).elements.find((e) => e.name === "7")!;
    const scroll = (a: Record<string, unknown>) => bgH.api.scroll(a).then((n) => String(n), (e: Error) => e.message);
    bg.scrollArea = true;
    bg.calls.length = 0;
    const byRef = await scroll({ direction: "down", ref: seven.ref });
    const sentKey = String(findCall(bg.calls, "scrollpage")?.params.key ?? "");
    check("scroll by ref hands the page rung the HELPER's key for that element, never the ref itself",
      !!sentKey && sentKey !== seven.ref && /1 page down/.test(byRef) && /pointer never moved/.test(byRef) && !findCall(bg.calls, "scroll"),
      `${seven.ref} → ${sentKey} · ${byRef.split("\n")[0]}`);

    bg.scrollArea = false;
    bg.calls.length = 0;
    const bare = await scroll({ direction: "down" });
    check("background, no ref and no area under the window's centre: the refusal names scroll({direction, ref}), and no wheel is posted",
      /scroll\(\{direction, ref\}\)/.test(bare) && /no wheel input was posted/.test(bare) && !findCall(bg.calls, "scroll"), bare.slice(0, 160));
    bg.calls.length = 0;
    const noArea = await scroll({ direction: "down", ref: seven.ref });
    check("background, a ref in no scrolling area: said as that, with the keys that still work, and no wheel is posted",
      /sits in no accessibility scrolling area/.test(noArea) && /PageDown/.test(noArea) && !findCall(bg.calls, "scroll"), noArea.slice(0, 160));
    bg.scrollArea = true;
    bg.calls.length = 0;
    const sideways = await scroll({ direction: "right", ref: seven.ref });
    check("background, left/right: refused as a wheel-only direction, never sent to the page rung",
      /only up and down/.test(sideways) && !findCall(bg.calls, "scroll") && !findCall(bg.calls, "scrollpage"), sideways.slice(0, 160));
  }

  await driver.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall macos mouse checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
