/** Hermetic macOS DRIVER coverage — no helper process, no app. A canned transport stands in
 * for the Swift helper (through its exec seam) and answers with a Calculator-shaped tree; the
 * assertions pin what the driver must do with it:
 * window-local rects, refs → helper keys, AXPress by ref, hit-test-then-press for a point with
 * screenshot scaling applied, AXSetValue for set_text, chords to the pid, stale refs refused
 * before any call, targets as windows, `not_trusted` worded with the pane. */

import { createHarness } from "./harness.ts";
import { checkMacosFieldIdentity } from "./macos-field-identity.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { findCall, ONE_APP, stubTransport } from "./macos-fixtures.ts";
import { WINDOW } from "./macos-stub-app.ts";
import { apiReference } from "../src/platform/tools/repl-docs.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";
async function main() {
  // ── The driver over a stubbed helper, through the harness ──────────────────
  const stub = stubTransport();
  // The stub lists the agent's host app among the running apps; as the host it names itself, so it is never a target.
  const driver = new MacosDriver({ transport: stub.transport, ...ONE_APP, env: { ...process.env, COMPUTER_USE_HOST_APPS: "com.example.agenthost" } });
  const h = createHarness(driver);

  const targets = firstText(await h.targets());
  check("targets are windows named app + bundle + title", /window/.test(targets) && /com\.apple\.calculator/.test(targets) && /计算器/.test(targets), targets.split("\n")[0]);
  check("the host app (COMPUTER_USE_HOST_APPS) is never offered as a target", !/agenthost/.test(targets));
  check("a window without a window-server row is never offered as <pid>:-1", !/49403:-1/.test(targets), targets);

  const seen = firstText(await h.observe({}));
  check("the default target skips the host app and picks the frontmost other app (the helper lists front-to-back)", /Title: 计算器/.test(seen), seen.split("\n")[0]);
  check("observe lists the button with its ref", /e2: button "全部清除"/.test(seen));
  check("observe lists the textbox as empty", /textbox "Expression" \[empty\]/.test(seen));
  const treeCall = findCall(stub.calls, "tree");
  check("the walk carries a node budget", typeof treeCall?.params.max === "number" && (treeCall.params.max as number) > 0, JSON.stringify(treeCall?.params));

  stub.calls.length = 0;
  const clicked = await h.act("click", { ref: "e3" });
  check("click by ref dispatches", clicked.ok, clicked.note);
  check("click by ref is AXPress on the element's key", String(findCall(stub.calls, "press")?.params.key).startsWith("k6g"));

  // ── The click is whatever action the element actually has ────────────────────────
  // AXPress is not the only one, and a whole surface can be listed without it: TextEdit's Open
  // dialog gives its rows AXShowDefaultUI/AXShowAlternateUI and its cells an AXOpen.
  stub.sourceList = true;
  const listing = firstText(await h.observe({}));
  // The observation may come back as a delta ("+ eN: row"), so match the ref, not the line start.
  const refOf = (role: string) => listing.split("\n").find((l) => new RegExp(`e\\d+: ${role}\\b`).test(l))?.match(/(e\d+)/)?.[1] ?? "";
  const rowRef = refOf("row");
  const cellRef = refOf("cell");
  check("the source-list pair is listed", !!rowRef && !!cellRef, listing.split("\n").slice(-6).join(" | "));
  stub.calls.length = 0;
  const rowRefusal = firstText(await h.act("click", { ref: rowRef, retry: true }));
  // A control with no click-like action gets a real mouse click at its centre (mouse.ts), and the
  // note says what it offered and that the app came forward — the row is 180×24 at window-local
  // (10,361) in the fixture plus the window frame.
  check("a control with no click-like action names what it offers, then is clicked with the mouse",
    /no action that can stand in for a click/.test(rowRefusal) && /AXShowDefaultUI, AXShowAlternateUI/.test(rowRefusal)
      && /clicked row .* with a mouse event at its centre/.test(rowRefusal) && /can bring 计算器 to the front/.test(rowRefusal),
    rowRefusal.split("\n")[0]);
  check("…and it still went to the helper first, so an ungranted machine hears about the GRANT instead",
    findCall(stub.calls, "press")?.params.action === undefined, JSON.stringify(findCall(stub.calls, "press")?.params));
  const rowMouse = findCall(stub.calls, "mouse");
  check("the mouse event is posted at the row's centre in screen points, left button, once",
    rowMouse?.params.x === WINDOW.x + 100 && rowMouse?.params.y === WINDOW.y + 373 && rowMouse?.params.button === "left" && rowMouse?.params.count === 1,
    JSON.stringify(rowMouse?.params));
  stub.frontmost = false; // the mouse raised the app; the user switches back

  stub.calls.length = 0;
  const opened = firstText(await h.act("click", { ref: cellRef }));
  check("a cell with AXOpen and no AXPress is pressed with AXOpen",
    findCall(stub.calls, "press")?.params.action === "AXOpen", JSON.stringify(findCall(stub.calls, "press")?.params));
  check("…and the substitute is named, because an open is not a click", /no AXPress, so its AXOpen ran instead/.test(opened),
    opened.split("\n").slice(0, 2).join(" | "));
  stub.sourceList = false;

  // ── The actions BESIDE the click (ax_action) ────────────────────────────────────
  // A stepper's increment and a popup's menu are actions a click cannot reach. The element LINE
  // says which ones it offers (an unseen target is a verb never used), and an action the element
  // does not advertise is refused HERE, naming what it does offer, not sent for a bare -25206.
  stub.secondary = true;
  const withActions = firstText(await h.observe({}));
  const stepperRef = withActions.split("\n").find((l) => /"Repeat"/.test(l))?.match(/(e\d+)/)?.[1] ?? "";
  const popupRef = withActions.split("\n").find((l) => /"Base"/.test(l))?.match(/(e\d+)/)?.[1] ?? "";
  check("an element's notable actions are marked on its line",
    /"Repeat".*\+increment,decrement/.test(withActions) && /"Base".*\+menu/.test(withActions),
    withActions.split("\n").filter((l) => /Repeat|Base/.test(l)).join(" | "));
  // That an ORDINARY control carries no mark is pinned with the pure mapping in macos-elements.ts.
  stub.calls.length = 0;
  const stepped = firstText(await h.act("ax_action", { ref: stepperRef, action: "increment" }));
  check("ax_action runs the AX action the short name means",
    findCall(stub.calls, "press")?.params.action === "AXIncrement", JSON.stringify(findCall(stub.calls, "press")?.params));
  check("…and says what ran on what", /ran AXIncrement on "Repeat"/.test(stepped), stepped.split("\n")[0]);
  stub.calls.length = 0;
  const axSpelled = firstText(await h.act("ax_action", { ref: popupRef, action: "AXShowMenu" }));
  check("the AX spelling works too — both appear in what the model reads",
    findCall(stub.calls, "press")?.params.action === "AXShowMenu", axSpelled.split("\n")[0]);
  stub.calls.length = 0;
  const notOffered = firstText(await h.act("ax_action", { ref: popupRef, action: "increment" }));
  check("an action the element does not offer is refused with the ones it has, before any call",
    /does not offer AXIncrement/.test(notOffered) && /AXPress, AXShowMenu/.test(notOffered) && !findCall(stub.calls, "press"),
    notOffered.split("\n")[0]);
  const nonsense = firstText(await h.act("ax_action", { ref: popupRef, action: "double-click" }));
  check("a string that is no AX action at all is named as such, with the vocabulary",
    /is not an accessibility action/.test(nonsense) && /menu, increment/.test(nonsense), nonsense.split("\n")[0]);
  // An error the APP returns is not a verdict on the effect: Chrome's address bar answers AXError
  // -25204 to AXShowMenu and opens the menu anyway, sometimes ~800 ms later. A plain failure would
  // carry no observation, leaving an opened menu invisible.
  stub.refuseAction = "AXShowMenu";
  const refusedAct = await h.act("ax_action", { ref: popupRef, action: "menu" });
  const refused = firstText(refusedAct);
  check("an error the app returns after the call is observed anyway — it may still have acted",
    !refusedAct.ok && /AXError -25204/.test(refusedAct.note) && /^Title: /m.test(refused),
    refused.split("\n").at(-1));
  check("…and it no longer claims the app will not perform it",
    !/will not perform it here/.test(refusedAct.note));
  stub.refuseAction = null;
  // (The harness reads an observation after every verb, so "a refusal decided before the call
  // carries none" has no expression here.)
  stub.secondary = false;
  await h.observe({});

  // ── select_text: the one partial write this platform has ────────────────────────
  // set_text replaces a field outright (AXSetValue). The offsets must come from the app's REAL
  // value, not the walk's 400-char preview, or an offset past the cap lands somewhere else.
  stub.cutValue = true;
  const doc = firstText(await h.observe({}));
  const areaRef = doc.split("\n").find((l) => /e\d+: textbox \[filled:line 1/.test(l))?.match(/(e\d+)/)?.[1] ?? "";
  check("the long-valued text area is listed", !!areaRef, doc.split("\n").slice(-3).join(" | "));
  stub.calls.length = 0;
  const sel = firstText(await h.act("select_text", { ref: areaRef, text: "quick", near: "line 12" }));
  const range = findCall(stub.calls, "selectrange")?.params ?? {};
  // LONG_VALUE repeats the phrase on all 12 lines; "line 12" is only on the last, so the
  // occurrence nearest it is the twelfth — offset 11 lines in, never the first match.
  check("the offset comes from the app's full value and `near` picks the occurrence",
    range.length === 5 && (range.start as number) > 500, JSON.stringify(range));
  check("...and the note says which match, so the model can tell it picked the right one",
    /match 12 of 12, the one nearest "line 12"/.test(sel), sel.split("\n")[0]);
  stub.calls.length = 0;
  const caretAt = firstText(await h.act("select_text", { ref: areaRef, text: "line 2:", caret: "after" }));
  check("a caret is a zero-length range placed after the match",
    findCall(stub.calls, "selectrange")?.params.length === 0 && /caret placed after "line 2:"/.test(caretAt),
    caretAt.split("\n")[0]);
  const missing = firstText(await h.act("select_text", { ref: areaRef, text: "not in there" }));
  check("text that is not in the field is refused with how to read the real value",
    /is not in/.test(missing) && /text\(\)/.test(missing), missing.split("\n")[0]);
  const notText = firstText(await h.act("select_text", { ref: "e2", text: "x" }));
  check("a control with no text value says so instead of failing at the app",
    /has no readable text value/.test(notText), notText.split("\n")[0]);
  // ── There is no `paste` on this platform, and that is a RULING ─────────────────
  // Paste is a COMMAND routed to the key window's first responder, so a `ref` cannot be a
  // destination (the paste would land in whatever document holds the focus). `ref` is an
  // EXPECTATION checked against what the app reports, and every refusal below happens BEFORE the
  // clipboard is touched — the one side effect here that cannot be taken back.
  stub.calls.length = 0;
  const behindPaste = firstText(await h.act("paste", { text: "hello" }));
  check("a background app is refused: no key window means no destination, and no clipboard write",
    /has no key window/.test(behindPaste) && !findCall(stub.calls, "clipboardstash"), behindPaste.split("\n")[0]);

  stub.frontmost = true;
  stub.calls.length = 0;
  const noFocus = firstText(await h.act("paste", { text: "hello" }));
  check("frontmost but nothing focused is refused too — a paste needs somewhere to land",
    /reports nothing focused/.test(noFocus) && !findCall(stub.calls, "clipboardstash"), noFocus.split("\n")[0]);

  // The focus is in ANOTHER window (a write would land in the user's document). The verb
  // cannot move it, but it says where it is, every time.
  stub.focusOn = "elsewhere";
  stub.calls.length = 0;
  const otherWindow = firstText(await h.act("paste", { text: "hello" }));
  check("a focus in another window is named in the result — never silent about where it went",
    /note\.txt/.test(otherWindow), otherWindow.split("\n")[0]);

  // With a `ref` the model states its expectation, and a mismatch is a refusal rather than a
  // paste into the wrong control. This is the check the field's own convention does not make.
  stub.focusOn = "k12";
  stub.calls.length = 0;
  const mismatch = firstText(await h.act("paste", { ref: "e2", text: "hello" }));
  check("a ref that is not where focus is refuses, names the holder, and writes no clipboard",
    /focus is on e\d+/.test(mismatch) && /not e2/.test(mismatch) && !findCall(stub.calls, "clipboardstash"),
    mismatch.split("\n")[0]);

  stub.calls.length = 0;
  const pasted = firstText(await h.act("paste", { text: "hello", html: "<b>hello</b>" }));
  const clip = findCall(stub.calls, "clipboardstash")?.params ?? {};
  check("when it runs: both flavours staged, the menu item pressed, the clipboard put back",
    clip.text === "hello" && clip.html === "<b>hello</b>"
      && findCall(stub.calls, "press")?.params.key === "m7" && !!findCall(stub.calls, "clipboardrestore"),
    stub.calls.map((c) => c.op).join(","));
  check("...and the note says where it landed and that the clipboard was restored",
    /at the app's focus/.test(pasted) && /put back afterwards/.test(pasted), pasted.split("\n")[0]);
  stub.focusOn = "none";
  stub.frontmost = false;

  // ── A key-window command disabled only because AppKit has not caught up ────────
  // `activate` returns before AppKit re-validates the menu (TextEdit: Select All and Paste still
  // disabled at 800 ms, enabled by 2.8 s). A FRONTMOST app is polled until its menu catches up; a
  // background chord uses the helper's guarded window delivery without polling the cached flag.
  stub.frontmost = true;
  stub.menuLag = 2;
  stub.calls.length = 0;
  const lagged = firstText(await h.act("keys", { chord: "cmd+a" }));
  check("a frontmost app is given time to re-validate its menu, then the command runs",
    /ran 编辑 › 全选/.test(lagged) && /finished coming forward/.test(lagged)
      && stub.calls.filter((c) => c.op === "menu").length > 1,
    `${lagged.split("\n")[0]} · menu reads: ${stub.calls.filter((c) => c.op === "menu").length}`);
  stub.frontmost = false;
  stub.menuLag = 0;
  stub.calls.length = 0;
  const behind = firstText(await h.act("keys", { chord: "cmd+s" }));
  check("a background shortcut reaches the bound window without menu polling",
    !!findCall(stub.calls, "backgroundkey") && stub.calls.filter((c) => c.op === "menu").length === 1,
    `${behind.split("\n")[0]} · menu reads: ${stub.calls.filter((c) => c.op === "menu").length}`);

  stub.cutValue = false;
  await h.observe({});

  // ── A window the app did not have is SAID, not left to be noticed ───────────────
  // The read is pinned to one window, and a modal sheet is a window of its own that blocks its
  // parent, so every later act would do nothing. Both signals are here because the window server
  // numbers a window later than AX reports it — the unnumbered one makes the warning land on the
  // action that raised the dialog rather than the call after it.
  stub.calls.length = 0;
  await h.observe({});                 // baseline: one window
  stub.extraWindow = "unnumbered";
  const raised = firstText(await h.observe({}));
  check("a window with no id yet is still reported",
    /opened a window it did not have before — macOS has not numbered it yet/.test(raised),
    raised.split("\n")[0].slice(0, 90));
  check("...and it says the sheet blocks the window being read", /BLOCKS the window you are reading/.test(raised));
  const settled = firstText(await h.observe({}));
  check("the note is one-shot — an unchanged window set says nothing",
    !/opened a window it did not have before/.test(settled), settled.split("\n")[0].slice(0, 60));
  stub.extraWindow = "numbered";
  const named = firstText(await h.observe({}));
  check("once macOS numbers it, the note names it with a focus target",
    /"选择行" \(focus \d+:9911\)/.test(named), named.split("\n")[0].slice(0, 110));
  stub.extraWindow = false;
  await h.observe({});

  // ── what:'text' completes what the walk previewed ───────────────────────────────
  // The helper caps each value at 400 chars so one screen of long values cannot blow up a
  // response. `what:'text'` is the "give me everything" call, so it pays one op per flagged
  // element — and when that op cannot answer, the preview keeps its receipt rather than passing
  // for the whole value.
  stub.cutValue = true;
  stub.calls.length = 0;
  const beforeRefs = firstText(await h.observe({}));
  const full = firstText(await h.observe({ what: "text" }));
  check("the full-text read completes a previewed value", full.includes("line 12: the quick brown fox"),
    JSON.stringify(full.slice(-60)));
  check("...by asking for it, one element at a time", findCall(stub.calls, "value") !== undefined,
    JSON.stringify(stub.calls.map((c) => c.op)));
  check("...and a completed value carries no cut receipt", !/cut at \d+ chars/.test(full));
  const afterRefs = firstText(await h.observe({}));
  check("a text read never re-mints a ref — its own name would have changed under it",
    !/^[+-] e\d+: /m.test(afterRefs), afterRefs.split("\n").slice(-3).join(" | "));
  void beforeRefs;

  stub.valueUnavailable = true;
  const stillCut = firstText(await h.observe({ what: "text" }));
  check("an uncompletable value keeps its preview AND says it was cut",
    /cut at 400 chars — the app has the full value/.test(stillCut),
    JSON.stringify(stillCut.split("\n").find((l) => /cut at/.test(l))?.slice(-70)));
  stub.valueUnavailable = false;
  stub.cutValue = false;

  // A text read walks the tree too, and the helper's key table moves with it — the ref map must follow.
  stub.calls.length = 0;
  await h.observe({ what: "text" });
  const afterText = await h.act("click", { ref: "e3" });
  check("a click by ref still lands after a what:'text' read re-walked the tree", afterText.ok, afterText.note);
  check("no synthetic input is ever posted for a click", !stub.calls.some((c) => c.op === "type" || c.op === "key"));

  // A point: the capture is one pixel per point (ax-shot.swift), so an image pixel IS a window
  // point and (48, 187) is screen (1650, 66) — a hit test there, then a press on what it finds.
  // The screenshot first supplies the scale; without one the verb refuses rather than guessing.
  stub.calls.length = 0;
  await h.observe({ what: "screenshot" });
  stub.calls.length = 0;
  const pointed = firstText(await h.act("click", { x: 48, y: 187 }));
  const at = findCall(stub.calls, "at");
  check("a point click hit-tests in screen points, an image pixel being a window point", at?.params.x === 1650 && at?.params.y === 66, JSON.stringify(at?.params));
  // The stub hit-tests for real (macos-fixtures.ts `at`): screen (1650, 66) is inside the "7" at
  // (1612, 66) 48 × 48.
  check("…then presses the element it found", String(findCall(stub.calls, "press")?.params.key).startsWith("k6g") && /pressed button "7"/.test(pointed), pointed.split("\n")[0]);

  // A result row appears above the keypad: every position shifts by one, every ref must NOT.
  stub.resultRow = true;
  const shifted = firstText(await h.observe({}));
  check("a row appearing above the keypad is reported as the ONLY change", /text "12×34"/.test(shifted) && !/button "7"/.test(shifted), shifted.split("\n").slice(2, 5).join(" / "));
  stub.calls.length = 0;
  const kept = await h.act("click", { ref: "e3", name: "7" });
  check("…so the old ref still presses the same control", kept.ok && String(findCall(stub.calls, "press")?.params.key).startsWith("k6g"), kept.note);
  stub.calls.length = 0;
  const wrongName = firstText(await h.act("click", { ref: "e3", name: "乘" }));
  check("a ref whose control does not carry the given name is refused, naming the ref that does", /is now "7", not "乘"/.test(wrongName) && /"乘" is e4/.test(wrongName) && !findCall(stub.calls, "press"), wrongName.split("\n")[0]);
  stub.calls.length = 0;
  const lenient = await h.act("click", { ref: "e2", name: "全部" });
  check("the identity check is the lenient one every platform applies (a substring of the name agrees)", lenient.ok && !!findCall(stub.calls, "press"), lenient.note);
  stub.resultRow = false;

  stub.calls.length = 0;
  await h.act("set_text", { ref: "e5", text: "12+30" });
  const sv = findCall(stub.calls, "setvalue");
  check("set_text by ref is AXSetValue on the field's key", String(sv?.params.key).startsWith("k12g") && sv?.params.text === "12+30", JSON.stringify(sv?.params));

  stub.calls.length = 0;
  await h.act("set_text", { text: "abc" });
  check("set_text without a ref uses the guarded background typing route", findCall(stub.calls, "backgroundtype")?.params.pid === 49403);

  stub.calls.length = 0;
  await h.act("keys", { chord: "Enter" });
  check("plain background keys use the guarded window route", findCall(stub.calls, "backgroundkey")?.params.chord === "Enter" && findCall(stub.calls, "backgroundkey")?.params.pid === 49403);

  // ── Background chords use guarded window delivery or an AX equivalent ──────
  stub.calls.length = 0;
  const newDoc = firstText(await h.act("keys", { chord: "cmd+n" }));
  check("a background chord uses guarded window delivery even when its menu item is enabled", findCall(stub.calls, "backgroundkey")?.params.chord === "cmd+n" && !findCall(stub.calls, "press") && /background/.test(newDoc), newDoc.split("\n")[0]);
  stub.calls.length = 0;
  const selAll = firstText(await h.act("keys", { chord: "cmd+a" }));
  check("cmd+a on the background-disabled item falls back to AXSelectedTextRange over the focused element", findCall(stub.calls, "selectall")?.params.pid === 49403 && !findCall(stub.calls, "press") && !findCall(stub.calls, "key"), selAll.split("\n")[0]);
  stub.calls.length = 0;
  const closeWin = firstText(await h.act("keys", { chord: "cmd+w" }));
  check("cmd+w on the background-disabled item falls back to the window's close button", !!findCall(stub.calls, "closewindow") && /save sheet/.test(closeWin), closeWin.split("\n")[0]);
  stub.calls.length = 0;
  const save = await h.act("keys", { chord: "cmd+s" });
  check("cmd+s uses background delivery pinned to the driven window", findCall(stub.calls, "backgroundkey")?.params.window === WINDOW.id && !findCall(stub.calls, "press") && !findCall(stub.calls, "activate"), firstText(save).split("\n")[0]);
  stub.calls.length = 0;
  const shiftSave = firstText(await h.act("keys", { chord: "cmd+shift+s" }));
  check("background delivery preserves every shortcut modifier", findCall(stub.calls, "backgroundkey")?.params.chord === "cmd+shift+s" && !findCall(stub.calls, "press"), shiftSave.split("\n")[0]);

  // ── menu without a path is a LISTING, and it reaches the script whole ────────
  // The journal keeps one line per verb, so the list must be the verb's return value, or the
  // model cannot learn that Undo is titled "Undo Paste".
  const bgListing = String(await h.api.act("menu", {}));
  check("menu with no path returns the whole listing, first line self-standing",
    /^\d+ menu commands runnable with the app in the background/.test(bgListing) && bgListing.split("\n").slice(1).some((l) => /文件 › 新建/.test(l)),
    bgListing.split("\n").slice(0, 2).join(" | "));
  // ── a command that ran on a FRONTMOST app is not reported as background ───────
  stub.frontmost = true;
  stub.calls.length = 0;
  const frontRun = firstText(await h.act("menu", { path: "文件 › 新建" }));
  check("a menu command run with the app frontmost says so, not 'in the background'",
    /文件 › 新建/.test(frontRun) && /frontmost/.test(frontRun) && !/in the background/.test(frontRun), frontRun.split("\n")[0]);
  stub.frontmost = false;

  stub.calls.length = 0;
  const quit = firstText(await h.act("keys", { chord: "cmd+q" }));
  check("cmd+q never runs Quit through the menu", /quit/i.test(quit) && !findCall(stub.calls, "press") && !findCall(stub.calls, "key"), quit.split("\n")[0]);
  stub.calls.length = 0;
  const unbound = firstText(await h.act("keys", { chord: "cmd+k" }));
  check("an unbound background chord uses the same guarded window delivery", findCall(stub.calls, "backgroundkey")?.params.chord === "cmd+k" && /background/.test(unbound), unbound.split("\n")[0]);

  stub.calls.length = 0;
  // The listing is the verb's multi-line note; the harness keeps a note's first line only, so this
  // one check reads the driver's answer directly.
  const menuList = (await driver.perform("menu", {})).note ?? "";
  check("menu without a path lists the runnable commands (never Quit) and how many wait for activate", /文件 › 新建 \(⌘N\)/.test(menuList) && !/退出/.test(menuList) && !/保存…/.test(menuList.split("(")[0]) && /5 more need/.test(menuList), menuList.split("\n").slice(0, 3).join(" | "));
  stub.calls.length = 0;
  const byPath = firstText(await h.act("menu", { path: "文件 > 新建" }));
  check("menu with a path runs that command (any separator)", findCall(stub.calls, "press")?.params.key === "m1" && /ran 文件 › 新建/.test(byPath), byPath.split("\n")[0]);
  stub.calls.length = 0;
  const byTitle = firstText(await h.act("menu", { path: "新建" }));
  check("…and the last segment alone also resolves", findCall(stub.calls, "press")?.params.key === "m1", byTitle.split("\n")[0]);

  // The two kinds of element an observation does not list (control cap / text budget): see test/macos-budgets.ts.

  stub.calls.length = 0;
  const stale = await h.act("click", { ref: "e42" });
  check("a ref outside the latest observation is refused before any helper call",
    (stale.details as { error?: string }).error === "stale_ref" && !stub.calls.some((c) => c.op === "press"));
  // A window has no navigation, no reload and no tabs, so it must not be told it lost a page
  // it never had — the refusal names THIS platform's mechanism.
  check("...in the window's own terms, not a browser's",
    /the control it named is gone from the window, or the target window changed/.test(firstText(stale))
    && !/navigation|reload|tab switch/.test(firstText(stale)), firstText(stale));

  stub.calls.length = 0;
  const focused = firstText(await h.act("focus", { target: "49403:62106" }));
  check("focusing a window target switches without activating the app", /now driving/.test(focused) && !stub.calls.some((c) => c.op === "activate"), focused.split("\n")[0]);

  stub.calls.length = 0;
  const activated = firstText(await h.act("activate"));
  check("activate is explicit and says the user lost the keyboard", findCall(stub.calls, "activate")?.params.pid === 49403 && /keyboard/.test(activated));

  // ── The surfaces list is said once, not on every observation ─────────────────
  // The full list (~470 characters on a nine-surface desktop) need not repeat: the ids are how a
  // model switches surface, and computer.surfaces() hands the same list back on demand.
  {
    const many = stubTransport();
    const manyH = createHarness(new MacosDriver({ transport: many.transport, ...ONE_APP }));
    const first = firstText(await manyH.observe({}));
    check("the first observation carries the whole list", /Targets: .*switch with focus\(id\)/.test(first),
      (first.match(/Targets:[^\n]{0,60}/) ?? ["(none)"])[0]);
    const second = firstText(await manyH.observe({}));
    check("…the next one says it is the same list instead of repeating it",
      /Targets: \d+ surfaces, the same list as the last observation/.test(second) && !/switch with focus\(id\)/.test(second),
      (second.match(/Targets:[^\n]{0,70}/) ?? ["(none)"])[0]);
    // The short form carries NO ids, so its length does not grow with the surface count.
    const shortLine = (second.match(/Targets:[^\n]*/) ?? [""])[0];
    check("…and the short form carries no ids, so it does not grow with the surface count",
      shortLine.length < (first.match(/Targets:[^\n]*/) ?? [""])[0].length && !/\d+:\d+:/.test(shortLine),
      `${(first.match(/Targets:[^\n]*/) ?? [""])[0].length} → ${shortLine.length} chars`);
    // ANY change brings it back whole — a window opening, a title edited, the active marker moving.
    many.extraWindow = "numbered";
    const third = firstText(await manyH.observe({}));
    check("a list that CHANGED is said in full again", /switch with focus\(id\)/.test(third),
      (third.match(/Targets:[^\n]{0,60}/) ?? ["(none)"])[0]);
  }

  // ── What a read CONTAINS: the window, AND what it does not show ──────────────
  // The shared reference promises every platform the "whole surface", so the walk lists off-screen
  // subtrees apart and descends into them — a pruning walk would leave `find` the viewport alone.
  {
    const off = stubTransport();
    off.scrolledAway = true;
    const offH = createHarness(new MacosDriver({ transport: off.transport, ...ONE_APP }));

    const hidden = await offH.api.find("报告 2025.pdf");
    check("find names a row the window does not show", !!hidden && typeof (hidden as { ref: string }).ref === "string",
      JSON.stringify(hidden ?? null));
    const listed = (await offH.api.observe()).elements;
    const marked = listed.filter((e) => e.offscreen);
    check("…observe carries it too, marked offscreen rather than silently mixed in",
      marked.length === 2 && marked.some((e) => e.name.includes("报告")), `${marked.length} marked of ${listed.length}`);
    check("…and the visible list is NOT padded with it — the element line budget is priced over what is shown",
      listed.filter((e) => !e.offscreen).length === listed.length - 2);
    const onlyVisible = await offH.api.find("报告 2025.pdf", { visible: true });
    check("visible:true means something again: it excludes what the window does not show", onlyVisible === null);

    const ref = apiReference(new MacosDriver({ transport: stubTransport().transport, ...ONE_APP }));
    check("the reference promises the whole surface again, because it is now true", /whole surface/.test(ref) && /visible \(on screen only\)/.test(ref));

    // The header note is an INSTRUCTION: it must not send the model scrolling to "reveal"
    // controls that the walk already carries.
    const header = firstText(await offH.observe({}));
    check("the off-screen note says they are already reachable, not that a scroll reveals them",
      /NOT unreachable/.test(header) && /act on it by ref without scrolling/.test(header) && !/reveals CONTROLS/.test(header),
      (header.match(/\d+ outside the window[^\n]{0,80}/) ?? ["(no note)"])[0]);
    check("…and it still says what only the POINTER needs", /click\/hover refuse a ref the window does not show/.test(header));
    check("…with no exception named where every row past the window has its name", !/EXCEPT/.test(header));
  }

  // ── A list that builds its rows as they scroll in ────────────────────────────
  // System Settings' sidebar: the rows past the window are bare frames, so "find returns one
  // without scrolling" is false for the very pane being looked for. Its own driver: the note is
  // said when its kind changes.
  {
    const lazy = stubTransport();
    lazy.scrolledAway = true;
    lazy.lazyRows = 3;
    const lazyH = createHarness(new MacosDriver({ transport: lazy.transport, ...ONE_APP }));
    const header = firstText(await lazyH.observe({}));
    check("rows past the window with no name yet are counted apart, and the note says find() cannot see into them",
      /EXCEPT 3 of them/.test(header) && /find\(\) cannot return what those rows will hold/.test(header),
      (header.match(/EXCEPT[^\n]{0,90}/) ?? ["(no exception named)"])[0]);
    check("…and names the way through: page that list by ref, then find again",
      /scroll\(\{direction:'down', ref:/.test(header) && /then find again/.test(header));
    check("…while a NAMED row past the window is not counted among them", /\b8 outside the window/.test(header),
      (header.match(/\d+ outside the window/) ?? ["(no count)"])[0]);
  }


  // ── value(ref): ONE element's whole value, where text() is the whole window ──────────
  // The listing clips a value to what a line holds; `text()` is a walk of the entire window, which
  // on an app holding the user's own content IS that content. `value` reads just the one element.
  {
    const vs = stubTransport();
    vs.cutValue = true;
    const vh = createHarness(new MacosDriver({ transport: vs.transport, ...ONE_APP }));
    const listed = (await vh.api.observe()).elements;
    const clipped = listed.find((e) => (e.state ?? "").includes("line 1: the quick brown fox"));
    check("the listing shows a long value clipped to what one line holds", !!clipped && (clipped.state ?? "").length < 200,
      JSON.stringify(clipped?.state ?? listed.map((e) => e.state)));

    vs.calls.length = 0;
    const whole = await vh.api.value(clipped!.ref);
    check("value(ref) answers with the WHOLE value, not the preview",
      whole.includes("line 12: the quick brown fox") && whole.length > 400, `${whole.length} chars`);
    const ops = vs.calls.map((c) => c.op);
    check("…for one round trip, and no walk — that is the whole point against text()",
      ops.length === 1 && ops[0] === "value", JSON.stringify(ops));

    // Same refusal the verbs give, from the same gate (the tool layer's ref check): a ref the
    // latest observation does not carry is one the model must stop using. (The driver checks again
    // for an element that leaves the tree BETWEEN the walk and this read.)
    let refused = "";
    try { await vh.api.value("e999"); } catch (e) { refused = (e as Error).message; }
    check("a ref the latest observation does not carry is the ordinary stale refusal",
      /e999/.test(refused) && /Re-observe/i.test(refused), JSON.stringify(refused));

    const ref = apiReference(new MacosDriver({ transport: stubTransport().transport, ...ONE_APP }));
    check("the reference offers it where the driver can answer for one element", /value\(t\)/.test(ref));
  }

  // ── observe({screenshot}) — the list and the picture in one call ────────────────────
  // The pairing a caller would otherwise make in two actions: read the screen, then look at it —
  // click({x,y}) takes its coordinates off a picture.
  {
    const ps = stubTransport();
    const ph = createHarness(new MacosDriver({ transport: ps.transport, ...ONE_APP }));
    ph.attached.length = 0;
    const both = await ph.api.observe({ screenshot: true });
    check("observe({screenshot:true}) still answers with the element list",
      Array.isArray(both.elements) && both.elements.length > 0, `${both.elements?.length} elements`);
    check("…and attaches the picture of the same screen",
      ph.attached.filter((c) => c.type === "image").length === 1, JSON.stringify(ph.attached.map((c) => c.type)));

    ph.attached.length = 0;
    await ph.api.observe();
    check("a bare observe() attaches nothing — the picture is asked for, never volunteered",
      ph.attached.length === 0, JSON.stringify(ph.attached.map((c) => c.type)));

    // An option this read does not act on is refused BY NAME; silently dropping one misleads.
    let complaint = "";
    try { await ph.api.observe({ all: true } as never); } catch (e) { complaint = (e as Error).message; }
    check("an option observe does not act on is still refused, and names itself",
      /does not take all/.test(complaint) && /filtering the array/.test(complaint), JSON.stringify(complaint));
  }

  await checkMacosFieldIdentity(check);

  console.log(`\nmacos-ui: ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
