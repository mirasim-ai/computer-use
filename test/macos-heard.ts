/**
 * What a click learns from the app's own change notifications, hermetically —
 * `node scripts/test.mjs macos-heard`.
 *
 * The stubbed helper answers `watch` / `settled` (ax/ax-watch.swift) from a script: what the app
 * SAYS after a press is set apart from what the press does to the listing, because the case this
 * exists for is the two disagreeing — System Settings' "Add Other Account…" adds its rows outside
 * the window's frame, so the listing inside the window is identical and the app has posted dozens
 * of changes. Pinned here: the app's word is a second witness, a silent app is judged as before,
 * an app talking on its own is not believed, and an old helper costs one failed ask.
 * One driver per block: the press memory learns from every click.
 */

import { createHarness } from "./harness.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { changeNote } from "../src/platform/macos/press-rungs.ts";
import { findCall, ONE_APP, stubTransport } from "./macos-fixtures.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";
const session = async () => {
  const stub = stubTransport();
  const driver = new MacosDriver({ transport: stub.transport, ...ONE_APP, interaction: "background" });
  const h = createHarness(driver);
  await h.observe({});
  stub.calls.length = 0;
  return { stub, h, driver };
};
const ops = (calls: Array<{ op: string }>) => calls.map((c) => c.op).join(",");

// ── The effect is outside the window: the listing is the same, the app said it changed ──
{
  const { stub, h } = await session();
  stub.pressInert = true;
  stub.saysOnPress = { AXValueChanged: 3, AXLayoutChanged: 1 };
  const r = await h.act("click", { ref: "e3" });
  const note = firstText(r);
  check("a press the app REPORTED changes for is honoured though nothing listed in the window differs",
    r.ok && /计算器 reported changes \(3 value changed, 1 layout changed\) though nothing listed inside the window differs/.test(note)
      && !/nothing in the window changed/.test(note), note.split("\n")[0]);
  check("…the mark is taken after the baseline walk and before the press, and the app is heard before the window is read again",
    (() => {
      const at = (op: string, from = 0) => stub.calls.findIndex((c, i) => i >= from && c.op === op);
      const [tree, watch, press, settled] = [at("tree"), at("watch"), at("press"), at("settled")];
      return tree >= 0 && tree < watch && watch < press && press < settled && at("tree", tree + 1) > settled;
    })(), ops(stub.calls).slice(0, 80));
  check("…and it is not redone by key or mouse", !findCall(stub.calls, "mouse") && !findCall(stub.calls, "key"), ops(stub.calls));
}

// ── The app says nothing and the listing is the same: judged exactly as before ──
{
  const { stub, h } = await session();
  stub.pressInert = true;
  const note = firstText(await h.act("click", { ref: "e3" }));
  check("a press with no change in the listing and no word from the app is still reported as uncertain",
    /accepted but nothing in the window changed within 800 ms/.test(note) && /twice could act twice/.test(note), note.split("\n")[0]);
  check("…having listened for it", !!findCall(stub.calls, "settled"), ops(stub.calls));
}

// ── An app that talks on its own is not believed ──
{
  const { stub, h } = await session();
  stub.pressInert = true;
  stub.talking = true;
  stub.saysOnPress = { AXValueChanged: 5 };
  const note = firstText(await h.act("click", { ref: "e3" }));
  check("an app that would not go quiet before the press cannot vouch for it: its changes are not pinned on the press",
    /accepted but nothing in the window changed within 800 ms/.test(note) && !findCall(stub.calls, "settled"), `${note.split("\n")[0]} | ${ops(stub.calls)}`);
}

// ── …nor is one that was changing on its own a moment ago (playback, a monitor, its user) ──
{
  const { stub, h } = await session();
  stub.pressInert = true;
  stub.unprompted = 3_000;
  stub.saysOnPress = { AXValueChanged: 1 };
  const recent = firstText(await h.act("click", { ref: "e3" }));
  check("an app that posted a change 3 s ago with nothing asked of it is not believed about this press",
    /accepted but nothing in the window changed within 800 ms/.test(recent) && !findCall(stub.calls, "settled"), recent.split("\n")[0]);
  // Its own session: the click above armed a redo on this control (the press memory).
  const later = await session();
  later.stub.pressInert = true;
  later.stub.unprompted = 60_000;
  later.stub.saysOnPress = { AXValueChanged: 1 };
  const old = firstText(await later.h.act("click", { ref: "e3" }));
  check("…and is believed again once that is a minute behind", /reported changes \(1 value changed\)/.test(old), old.split("\n")[0]);
}

// ── A helper that predates the op: one failed ask, then the old judgement ──
{
  const { stub, h } = await session();
  stub.noWatch = true;
  const first = await h.act("click", { ref: "e3" });
  const second = await h.act("click", { ref: "e3" });
  check("a helper without `watch` still clicks, and is asked once for the whole session",
    first.ok && second.ok && stub.calls.filter((c) => c.op === "watch").length === 1 && !findCall(stub.calls, "settled"), ops(stub.calls));
}

// ── An app whose window changes without a word is not listened to for long ──
{
  const { stub, h } = await session();
  for (let i = 0; i < 4; i++) await h.act("click", { ref: "e3" });
  check("after two presses that changed the window in silence the app is taken as mute and no longer waited on",
    stub.calls.filter((c) => c.op === "watch").length === 2, ops(stub.calls));
}

// ── What appeared is named in refs the caller can act on ──
{
  const { stub, h } = await session();
  stub.pressReveals = true;
  stub.saysOnPress = { AXCreated: 1 };
  const r = await h.act("click", { ref: "e3" });
  const note = firstText(r);
  const m = /appeared: button "Send" (e\d+)/.exec(note);
  check("a click's note names the control it made appear, by ref", r.ok && !!m, note.split("\n")[0]);
  const again = m ? await h.act("click", { ref: m[1], name: "Send" }) : null;
  check("…and that ref is live: the next click can use it with no observation between", !!again && !/not in the latest observation/.test(firstText(again)), again ? firstText(again).split("\n")[0] : "");
}

// ── wait({}) listens where the app's silence can be read, and polls the text where it cannot ──
{
  const { stub, driver } = await session();
  const polled = await driver.waitSettled(2_000);
  check("an app that has never posted a change is waited on by polling its text, as before",
    /the readable text settled/.test(polled.note ?? "") && !!findCall(stub.calls, "watch"), polled.note);
  stub.spoken = 4;
  stub.calls.length = 0;
  const heard = await driver.waitSettled(2_000);
  check("an app that has spoken is settled when it stops, and nothing is read to find that out",
    /计算器 stopped posting accessibility changes after \d/.test(heard.note ?? "") && !findCall(stub.calls, "tree"), `${heard.note} | ${ops(stub.calls)}`);
  stub.talking = true;
  const busy = await driver.waitSettled(30);
  check("…and one that never stops says so when the budget runs out, without failing",
    busy.ok && /still posting accessibility changes when the 0s budget ran out/.test(busy.note ?? ""), busy.note);
  stub.talking = false;
  stub.noWatch = true;
  const { stub: old, driver: oldDriver } = await session();
  old.noWatch = true;
  const fallback = await oldDriver.waitSettled(2_000);
  check("a helper without `watch` polls the text", /the readable text settled/.test(fallback.note ?? ""), fallback.note);
}

// ── changeNote itself ──
{
  const was = [{ ref: "e1", role: "button", name: "Add" }, { ref: "e2", role: "row", name: "" }, { ref: "e3", role: "text", name: "Old" }];
  const now = [{ ref: "e1", role: "button", name: "Add" }, { ref: "e4", role: "button", name: "Mail", offscreen: true }, { ref: "e5", role: "row", name: "" }];
  check("changeNote lists what came and what went, marks what is outside the window, and leaves nameless rows out",
    changeNote(was, now) === 'appeared: button "Mail" e4 (outside the window); gone: text "Old"', String(changeNote(was, now)));
  check("changeNote answers null when nothing named came or went", changeNote(was, was) === null && changeNote(undefined, now) === null);
  const churn = [...now, { ref: "e2", role: "button", name: "General", offscreen: true }];
  check("…and outside the window only a control never listed before counts: a lazy row that got its name back is not the click's doing",
    changeNote(was, churn, 3) === 'appeared: button "Mail" e4 (outside the window); gone: text "Old"', String(changeNote(was, churn, 3)));
  check("…nor is one that lost it reported as gone",
    changeNote([...was, { ref: "e6", role: "button", name: "VPN", offscreen: true }], now, 3) === 'appeared: button "Mail" e4 (outside the window); gone: text "Old"');
  const many = Array.from({ length: 12 }, (_, i) => ({ ref: `e${10 + i}`, role: "button", name: `B${i}` }));
  check("changeNote is bounded", /\+4 more$/.test(changeNote([], many) ?? ""), String(changeNote([], many)));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
