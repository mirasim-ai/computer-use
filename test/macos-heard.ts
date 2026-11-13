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
  const h = createHarness(new MacosDriver({ transport: stub.transport, ...ONE_APP, interaction: "background" }));
  await h.observe({});
  stub.calls.length = 0;
  return { stub, h };
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

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
