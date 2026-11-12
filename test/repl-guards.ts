/**
 * What the repl CHECKS and what it SAYS about it — `node scripts/test.mjs repl-guards`.
 *
 * Hermetic, over the stubbed macOS helper, because every contract here belongs to the shared
 * layers (`tools/`, `driver.ts`) and only needs a driver that answers:
 *
 *   · a verb argument outside its own schema is refused, never reinterpreted;
 *   · `find` says what else carried the name when it picks one of many same-named controls;
 *   · a CONTROL can be waited for, instead of a hand-rolled poll of five observations per call;
 *   · reading a long document in slices does not earn "you keep looking without acting";
 *   · a streaming transcript does not bury two control changes under sixty churned text lines.
 */

import { createHarness } from "./harness.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";
import { anchorBox, coveredMiss, nearMiss, nearMissNote, rankByName } from "../src/platform/tools/find-target.ts";
import { apiReference } from "../src/platform/tools/repl-docs.ts";
import { createComputerUseTools } from "../src/platform/tools/index.ts";
import { ElectronDriver } from "../src/platform/electron/driver.ts";
import type { OwnershipResource } from "../src/platform/types.ts";
import { expectVerb } from "../src/platform/tools/api-expect.ts";
import type { RunLedger } from "../src/platform/tools/api-contract.ts";
import type { ComputerUseDriver } from "../src/platform/driver.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";

async function main() {
  const stub = stubTransport();
  const driver = new MacosDriver({ transport: stub.transport, ...ONE_APP });
  const h = createHarness(driver);
  await h.observe();

  // ── A verb's own schema is applied to what the SCRIPT passed ──────────────────────────
  const badEnum = await h.act("select_text", { ref: "e2", caret: "end" });
  check("a value outside a verb's enum is refused, and the refusal lists the values that are not",
    !badEnum.ok && /must be one of select, before, after/.test(badEnum.note), badEnum.note);
  const badType = await h.act("ax_action", { ref: "e2", action: 7 });
  check("a wrong type is refused by the verb's schema too", !badType.ok && /invalid arguments for axAction/.test(badType.note), badType.note);
  const fine = await h.act("ax_action", { ref: "e2", action: "AXPress" });
  check("a call that fits its schema is dispatched as before", fine.ok, fine.note);

  // ── An options-object verb given a string reinterprets nothing; it refuses ────────────
  // `page('<a URL>')` must not read the current tab and report "complete" as if it had
  // gone to the URL.
  const loose = h.api as unknown as Record<string, (a: unknown) => Promise<unknown>>;
  const shapes: Array<[string, string, unknown, RegExp]> = [
    ["page", "page", "https://example.com/profile", /page takes an options object, not "https:\/\/example\.com\/profile".*openUrl\(\{url\}\)/],
    ["scroll", "scroll", "down", /scroll takes an options object, not "down".*scroll\(\{direction:'down'\}\)/],
    ["wait", "wait", 2000, /wait takes an options object, not 2000.*wait\(\{ms:2000\}\)/],
    ["screenshot", "screenshot", "full", /screenshot takes an options object, not "full"/],
    ["diagnostics", "diagnostics", "console", /diagnostics takes an options object, not "console"/],
    ["a platform verb", "axAction", "AXPress", /axAction takes an options object, not "AXPress"/],
  ];
  for (const [label, verb, arg, want] of shapes) {
    let note = "(no throw — the argument was swallowed)";
    try { await loose[verb]!(arg); } catch (e) { note = (e as Error).message; }
    check(`${label} given a string is refused, and the refusal shows the object it wanted`, want.test(note), note);
  }
  check("an options verb with no argument at all still runs", (await h.api.wait({ ms: 1 })) === true);

  // ── find: the pick is still one control, but the pile is named ────────────────────────
  stub.crowded = true;
  await h.observe();
  const many = await h.api.find("control") as { ref: string; matches?: number; others?: Array<{ ref: string }> } | null;
  check("find on an ambiguous name reports how many controls carried it and names runners-up",
    !!many && many.matches === 80 && (many.others ?? []).length === 3, JSON.stringify(many));
  const one = await h.api.find("全部清除") as { matches?: number } | null;
  check("an unambiguous name reports one match", one?.matches === 1, JSON.stringify(one));

  // ── A TIE is refused where it would be WRITTEN, not where it is found ─────────────────
  // find and click live in ONE script, so `1 of 2` in the journal arrives after the click
  // (two cards with a "Pause" button each would be clicked on position alone).
  // The name is the fixture's own (e2), because a handle also has to pass the dispatch-time
  // agreement check — a synthetic name would be refused for the OTHER reason and prove nothing.
  const tie = { ref: "e2", name: "全部清除", role: "button", matches: 2,
    others: [{ ref: "e3", name: "全部清除", role: "button", id: "ClearB" }] };
  const wrote = await h.api.click(tie).then(() => "", (e: Error) => e.message);
  check("a write on a same-name same-role tie is refused, naming the candidates and the ways out",
    /names 2 controls of the same role/.test(wrote) && /e3 \(ClearB\)/.test(wrote)
      && /within/.test(wrote) && /act by ref/.test(wrote), wrote);
  const read = await h.api.hover(tie).then(() => "ok", (e: Error) => e.message);
  check("...while a READ on the same handle still takes the pick", read === "ok", read);
  const scoped = await h.api.click({ ...tie, scope: { within: "e9" } }).then(() => "ok", (e: Error) => e.message);
  check("...and a filter that left two identical candidates still refuses the write",
    /names 2 controls of the same role/.test(scoped), scoped);
  const ranked = { ref: "e2", name: "全部清除", role: "button", matches: 2,
    others: [{ ref: "e3", name: "全部清除吧", role: "button" }] };
  const notTie = await h.api.click(ranked).then(() => "ok", (e: Error) => e.message);
  check("...and an ambiguity the ranking DID have a reason for still acts", notTie === "ok", notTie);

  // ── A miss says whether the name is on the surface as TEXT ────────────────────────────
  // Two misses that need opposite next moves must not read identically: "not here" sends the
  // caller scrolling or waiting, "here but not a control" sends them to text() or to `near`.
  const inText = nearMissNote([], "anything", {}, true);
  check("a miss whose name the surface text carries says so, and points at text()/near",
    /TEXT carries it/.test(inText), inText);
  check("...and a plain miss does not claim it", !/TEXT carries it/.test(nearMissNote([], "anything", {}, false)));

  // ── find(…, {why: true}): the reason as data, from the same branches as the line ─────────
  {
    const rect = { x: 0, y: 0, w: 10, h: 10 };
    const far = [{ ref: "e1", name: "Go", role: "button", offscreen: true, rect }, { ref: "e2", name: "Stop", role: "button", rect }];
    const off = nearMiss(far, "Go", { role: "button", visible: true });
    check("visible:true is what dropped it, with role kept → offscreen, naming the control",
      off.reason === "offscreen" && off.match?.ref === "e1", JSON.stringify(off));
    const byRole = nearMiss(far, "Go", { role: "link", visible: true });
    check("a role excluded it too → filtered, not offscreen: scrolling would not bring it back",
      byRole.reason === "filtered" && byRole.match?.ref === "e1", JSON.stringify(byRole));
    const grouped = nearMiss(far, "Go", { near: "Toolbar" }, false, [{ label: "Toolbar", members: ["e2"] }]);
    check("a near group that left it out → filtered", grouped.reason === "filtered" && grouped.match?.ref === "e1", JSON.stringify(grouped));
    check("text only → text; nothing → absent; neither names a match",
      nearMiss(far, "Quarterly", {}, true).reason === "text" && nearMiss(far, "Quarterly", {}, false).reason === "absent"
        && !nearMiss(far, "Quarterly", {}, false).match);
    const under = coveredMiss({ by: "an overlay", elements: [{ ref: "e5", name: "Save", role: "button", rect, coveredBy: 'button "Chat"', coveredByRef: "e6" }] },
      "Save", {}, true);
    check("a covered control → covered, with its own cover and that cover's ref",
      under?.reason === "covered" && under.match?.ref === "e5" && under.by?.name === 'button "Chat"' && under.by?.ref === "e6",
      JSON.stringify(under));
    check("…and a name no covered control carries is not a covered miss",
      coveredMiss({ by: "an overlay", elements: [] }, "Save", {}, true) === null);

    // Nothing close by name: the miss names what IS there, so the next call need not look first.
    const lost = nearMiss(far, "Quarterly", {}).note;
    check("a miss with nothing close lists the controls there are, with their refs",
      /what is here: button "Go" \(e1\), button "Stop" \(e2\)|what is here: button "Stop" \(e2\), button "Go" \(e1\)/.test(lost), lost);
    check("...on screen before off screen", lost.indexOf('"Stop"') < lost.indexOf('"Go"'), lost);
    const many = Array.from({ length: 12 }, (_, i) => ({ ref: `e${i}`, name: `Row ${i}`, role: i % 2 ? "link" : "button", rect }));
    const capped = nearMiss(many, "Quarterly", {}).note;
    check("...a long list is cut, and says how many more", /\+4 more/.test(capped) && !/Row 9/.test(capped), capped);
    const roleOnly = nearMiss(many, "Quarterly", { role: "link" }).note;
    check("...under a role it lists that role's controls only", /the link controls here: "Row 1" \(e1\)/.test(roleOnly) && !/Row 0/.test(roleOnly), roleOnly);
    const noRole = nearMiss(many, "Quarterly", { role: "checkbox" }).note;
    check("...and says when no control of that role is listed", /no checkbox is listed here at all/.test(noRole), noRole);

    const missed = await h.api.find("no such control anywhere", { why: true });
    check("on macOS a miss with why answers {ref: null, reason, note}",
      missed.ref === null && missed.reason === "absent" && /no match/.test(missed.note), JSON.stringify(missed));
    check("…and without why it is still null", await h.api.find("no such control anywhere") === null);
    const refText = apiReference(driver);
    check("the macOS reference says a covered control reads as absent there, and offers no 'covered'",
      /never reports what an overlay covers/.test(refText) && !/'covered' \(/.test(refText));
  }

  const before = stub.calls.length;
  await h.api.find("no such control anywhere");
  check("a miss consults the surface text — one extra read, paid only on the miss",
    stub.calls.length > before, `${stub.calls.length - before} extra calls`);

  // ── …and the pile can be narrowed: role, a box to search inside, on-screen only ───────
  const byRole = await h.api.find("control 1", { role: "textbox" }) as { ref: string } | null;
  check("find scoped to a role that nothing matches answers null rather than the wrong kind", byRole === null, JSON.stringify(byRole));
  const all = await h.api.observe();
  const anchor = all.elements.find((e) => e.name === "control 5")!;
  const inBox = await h.api.find("control", { within: anchor.ref }) as { ref: string; matches?: number } | null;
  check("find within a box searches only what sits inside it",
    inBox?.ref === anchor.ref && inBox?.matches === 1, JSON.stringify(inBox));
  // ── …and `near` ranks by distance, which is what a same-named pile really needs ───────
  const far = all.elements.find((e) => e.name === "control 70")!;
  const nearFar = await h.api.find("control", { near: "control 70" }) as { ref: string; matches?: number } | null;
  check("find near an anchor picks the closest match and keeps the count",
    nearFar?.ref === far.ref && nearFar?.matches === 80, JSON.stringify(nearFar));
  let badNear = "";
  try { await h.api.find("control", { near: "nothing is called this" }); } catch (e) { badNear = (e as Error).message; }
  check("an anchor that is nowhere is refused rather than falling back to the first match",
    /nothing on the surface is named/.test(badNear), badNear);

  check("...and names the matches it could not pick between, each with its ref and where it is",
    /e8 button "control 0" at x \d+, y \d+/.test(badNear) && /\+76 more/.test(badNear) && /by its ref/.test(badNear), badNear.slice(0, 400));
  // `near` also takes the control itself — a ref, or the handle a find answered with.
  const nearRef = await h.api.find("control", { near: far.ref }) as { ref: string } | null;
  check("find near a ref measures from that element", nearRef?.ref === far.ref, JSON.stringify(nearRef));
  const nearHandle = await h.api.find("control", { near: nearFar }) as { ref: string; scope?: { near?: string; nearBox?: unknown } } | null;
  check("find near a handle measures from the control the handle names",
    nearHandle?.ref === far.ref && nearHandle?.scope?.near === far.ref && !nearHandle?.scope?.nearBox, JSON.stringify(nearHandle));
  let badNearKind = "";
  try { await h.api.find("control", { near: { nope: true } }); } catch (e) { badNearKind = (e as Error).message; }
  check("a near that is none of them is named, not ignored", /must be a name, a ref string or a find\(\) handle/.test(badNearKind), badNearKind);
  {
    // What `near` names when it is not a control: a heading of that name, found in the read.
    const at = (x: number, y: number) => ({ x, y, w: 10, h: 10 });
    const cards = [
      { ref: "e1", name: "Share", role: "button", rect: at(300, 0) },
      { ref: "e2", name: "Share", role: "button", rect: at(300, 400) },
      { ref: "e3", name: "Export revenue by day", role: "button", rect: at(0, 800) },
    ];
    const titles = [{ name: "Orders by region", rect: at(0, 0) }, { name: "Revenue by day", rect: at(0, 400) }];
    const box = anchorBox(cards, [], titles, "Revenue by day");
    check("near resolves to a heading of that name, ahead of a control that only contains it",
      box !== null && box !== "named" && box.y === 400, JSON.stringify(box));
    const picked = box && box !== "named" ? rankByName(cards, "Share", { near: "Revenue by day", nearBox: box }) : null;
    check("...and the ranking measures from it", picked?.ref === "e2" && picked?.matches === 2, JSON.stringify(picked));
    check("...without keeping the box on the handle", !!picked?.scope?.near && !picked?.scope?.nearBox, JSON.stringify(picked?.scope));
    check("a control or a group of that exact name is left to the ranking",
      anchorBox(cards, [], titles, "Export revenue by day") === "named"
        && anchorBox(cards, [{ label: "Revenue by day", members: ["e2"] }], titles, "Revenue by day") === "named");
    check("a ref is that element's box", (anchorBox(cards, [], titles, "e2") as { y: number }).y === 400);
    check("a name nothing carries resolves to nothing", anchorBox(cards, [], titles, "Refunds") === null);
  }

  let badScope = "";
  try { await h.api.find("control", { within: { nope: true } }); } catch (e) { badScope = (e as Error).message; }
  check("a within that is neither a ref nor a handle is named, not ignored", /must be a ref string or a find\(\) handle/.test(badScope), badScope);

  // ── A handle that was unambiguous and is ambiguous now refuses to re-resolve ──────────
  const wasUnique = await h.api.find("全部清除") as { ref: string; name: string; matches?: number };
  stub.sameNames = true;      // two more controls take the same name
  await h.observe();
  let drifted = "";
  try { await h.api.click({ ...wasUnique, ref: "e999" }); } catch (e) { drifted = (e as Error).message; }
  check("a handle whose ref died and whose name now matches several is refused, with the way out",
    /now matches 3 controls/.test(drifted) && /find\('全部清除', \{role, within, visible\}\)/.test(drifted), drifted);
  stub.sameNames = false;
  stub.crowded = false;
  await h.observe();

  // ── keys can REQUIRE the focus be where the script thinks it is ───────────────────────
  stub.elementFocused = "k12";                     // AX marks the text field as focused
  const field = (await h.api.observe()).elements.find((e) => /focused/.test(e.state ?? ""))!;
  const okKeys = await h.act("keys", { chord: "Enter" });
  check("a plain keys is unchanged", okKeys.ok, okKeys.note);
  await h.api.keys("Enter", { focus: field.ref });
  check("keys with focus: on the focused control goes out", true);
  const other = (await h.api.observe()).elements.find((e) => e.ref !== field.ref && e.role === "button")!;
  let refused = "";
  try { await h.api.keys("Enter", { focus: other.ref }); } catch (e) { refused = (e as Error).message; }
  check("keys with focus: elsewhere presses nothing and names what holds the keyboard",
    /the keyboard focus is on/.test(refused) && /nothing was pressed/.test(refused), refused);
  stub.elementFocused = "";

  // ── wait for a CONTROL, not for the word appearing in the text ────────────────────────
  const there = await h.act("wait", { control: "全部清除" });
  check("wait({control}) answers as soon as a control with that name is listed",
    there.ok && /the control "全部清除" is there/.test(there.note), there.note);
  // A wait ANSWERS false rather than throwing — it is a condition, not a dispatch.
  const neverOk = await h.api.wait({ control: "Nonexistent", ms: 200 });
  const never = await h.act("wait", { control: "Nonexistent", ms: 200 });
  check("a control that never appears times out, answers false, says how long it waited, and does not advise another element",
    neverOk === false && /no control named "Nonexistent" appeared/.test(never.note) && !/different element/.test(never.note), never.note);
  const gone = await h.act("wait", { control_gone: "全部清除", ms: 200 });
  check("control_gone times out while the control is still listed", /is still listed/.test(gone.note), gone.note);

  // ── Reading CONTENT is not "looking without acting" ───────────────────────────────────
  await h.observe();
  await h.observe();
  const third = firstText(await h.observe());
  check("three plain observations in a row still earn the nudge", /observations in a row without acting/.test(third),
    third.split("\n").find((l) => l.startsWith("NOTE:")) ?? "");
  await h.api.text();
  const afterRead = firstText(await h.observe());
  check("…but a round that read the surface's TEXT does not", !/observations in a row without acting/.test(afterRead),
    afterRead.split("\n").find((l) => l.includes("without acting")) ?? "(no nudge)");

  // ── A streaming transcript's text churn is counted, not printed ───────────────────────
  stub.chatty = true;
  const grew = await h.observe();          // 120 rows arriving is a rewrite: rendered in full
  check("a transcript arriving at once is rendered in full, not as a diff", grew.details.obsKind === "full", String(grew.details.obsKind));
  stub.chattyChurn = 1;
  const small = firstText(await h.observe());
  check("a few changed text lines are still printed one by one",
    /Changes since last observation/.test(small) && /^[-+] /m.test(small) && !/text lines changed too/.test(small),
    small.split("\n").filter((l) => /^[-+] /.test(l)).length + " diff lines");
  stub.chattyChurn = 5;
  const big = firstText(await h.observe());
  const churnLine = big.split("\n").find((l) => /text lines changed too/.test(l)) ?? "";
  check("past the churn threshold they are summarized and the model is pointed at text()",
    !!churnLine && /read it with text\(\)/.test(churnLine) && !/^[-+] /m.test(big), churnLine);

  // ── A read that takes nothing says so, instead of dropping what it was handed ─────────
  {
    let refused = "";
    try { await (h.api.observe as (o: unknown) => Promise<unknown>)({ all: true }); }
    catch (e) { refused = (e as Error).message; }
    check("observe() refuses an option it does not act on rather than ignoring it",
      /observe\(\) does not take all/.test(refused) && /offscreen/.test(refused), refused || "(accepted it)");
    let ok = true;
    try { await h.api.observe(); } catch { ok = false; }
    check("…and the bare call is untouched", ok);
  }

  // ── An action answers with what it did ────────────────────────────────────────────────
  {
    const listed = (await h.api.observe()).elements;
    const target = listed.find((e) => e.role === "button");
    const said = target ? await h.api.click(target.ref) : undefined;
    // A press that simply worked has nothing to report, so the string may be empty — but it IS a
    // string: `undefined` would make `const r = await w.click(x); r.note` throw AFTER the click.
    check("click answers with what it did, as a string rather than undefined",
      typeof said === "string", said === undefined ? "undefined" : `"${said.slice(0, 60)}"`);
  }

  // ── A handle bound to an APP survives the app opening a window ─────────────────────────
  // TextEdit bound by bundle id, then File › New: the app-level claim becomes a window claim
  // under the same app. That is the same target, not "a different target".
  {
    const st = stubTransport();
    st.windowsGone = true;
    const appDriver = new MacosDriver({ transport: st.transport, ...ONE_APP });
    const claims: string[] = [];
    const ownership = {
      claim: async (group: string, rs: OwnershipResource[]) => { claims.push(`claim ${group} ${rs.map((r) => r.key).join(",")}`); },
      release: async (group: string) => { claims.push(`release ${group}`); },
      releaseAll: async () => {},
    };
    const tools = Object.fromEntries(createComputerUseTools([{ driver: appDriver }], { ownership }).map((t) => [t.name, t]));
    const run = async (code: string) => firstText(await tools.computer_repl!.execute({ code, observation: "brief" }) as never);
    await run("w = await computer.surface('49403'); try { await w.observe(); } catch {} return 1");
    st.windowsGone = false;
    await run("await w.observe(); return 1");
    const acted = await run("await w.click('e2'); return 'clicked'");
    check("an app-level handle keeps working once the app opens a window",
      /Returned: clicked/.test(acted) && !/different target/.test(acted), acted.replace(/\n/g, " ⏎ ").slice(0, 300));
    check("…and its lease moves from the app to the window",
      claims.some((c) => c.startsWith("claim macos:window:49403:")) && claims.includes("release macos:app:49403"), claims.join(" | "));
    await appDriver.close();
  }

  // ── Several platforms mounted: the Targets line names surfaces the way surface() takes them ─
  {
    const st = stubTransport();
    st.extraWindow = "numbered";
    const appDriver = new MacosDriver({ transport: st.transport, ...ONE_APP });
    // Never reached: a call scoped to macOS lists only macOS surfaces.
    const electron = new ElectronDriver({ cdpUrl: "http://127.0.0.1:9" });
    const ownership = { claim: async () => {}, release: async () => {}, releaseAll: async () => {} };
    const tools = Object.fromEntries(createComputerUseTools([{ driver: appDriver }, { driver: electron }], { ownership }).map((t) => [t.name, t]));
    const seen = firstText(await tools.computer_repl!.execute({ code: "w = await computer.surface('macos/49403:62106'); await w.observe(); return 1", platform: "macos" }) as never);
    const line = seen.split("\n").find((l) => l.startsWith("Targets:")) ?? "";
    check("with several platforms mounted, the Targets line carries the platform prefix",
      /\*macos\/49403:62106:/.test(line) && !/(^|\s)\*?49403:/.test(line.slice("Targets:".length)), line.slice(0, 160) || seen.split("\n")[0]);
    await appDriver.close();
  }

  // ── expect({value}): a read still in flight when the budget ends ──────────────────────
  // The poll pauses until the deadline, so its last read often has no time left. That read
  // timing out must not replace what an earlier read already found.
  const ledgerStub = { charge() {}, push() {}, attach() {} } as unknown as RunLedger;
  const driverStub = { noteContentRead() {}, valueMatches: (a: string, b: string) => a === b } as unknown as ComputerUseDriver;
  const expectMessage = async (read: () => Promise<string>) => {
    try { await expectVerb(driverStub, () => ledgerStub, read)({ value: "e1", equals: "SPRING-20", ms: 150 }); return "no failure"; }
    catch (e) { return (e as Error).message; }
  };
  let reads = 0;
  const heldThenHung = await expectMessage(() => (reads++ === 0 ? Promise.resolve("SPRING-10") : new Promise<string>(() => {})));
  check("a value expect whose last read ran out of time still says what the field held",
    /Expectation failed/.test(heldThenHung) && /SPRING-10/.test(heldThenHung) && reads > 1, `${reads} reads: ${heldThenHung.slice(0, 120)}`);
  const neverRead = await expectMessage(() => new Promise<string>(() => {}));
  check("...and one that never read the field says the read timed out", /value read timed out/.test(neverRead), neverRead);

  await driver.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall repl guard checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
