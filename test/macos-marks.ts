/**
 * The action marks an observation hoists off its element lines — the driver end of it.
 *
 * `macos-elements.ts` pins WHICH marks the walk takes out (a share of the list); this pins that
 * the driver carries them through `meta.sharedMarks` and says so once in the head, because a
 * hoisted mark the model is never told about is a capability that silently disappeared.
 *
 * Its own file rather than another block in `macos-ui.ts`: that one is already large, and one
 * module per job is the same reason the fixture already lives apart. It shares the fixture's
 * stub, so it costs a driver and no second helper.
 */

import { createHarness } from "./harness.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";

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

  const plain = firstText(await h.observe({}));
  check("an ordinary window says nothing about shared marks", !/every control below also offers/.test(plain));

  stub.crowded = true;
  const crowded = firstText(await h.observe({}));
  const lines = crowded.split("\n").filter((l) => /^[+-]? ?e\d+: /.test(l));
  // Live measurement this fixture stands in for (an Electron app's window):
  // 269 of 271 controls marked, 13,061 chars of observation → 11,305 after, a 1,756-char saving
  // on every observation of that window.
  check("the mark every control shares is off the element lines",
    lines.length > 12 && lines.every((l) => !/\[[^\]]*\+menu/.test(l)),
    `${lines.length} lines, ${lines.filter((l) => /\+menu/.test(l)).length} still marked`);
  check("…and the head says it once, with the verb that uses it",
    /NOTE: every control below also offers menu \(ax_action\)/.test(crowded),
    crowded.split("\n").find((l) => /every control below/.test(l))?.slice(0, 90) ?? "(no line)");
  check("…and it warns that being offered is not a promise it works",
    /not a promise it works/.test(crowded));

  // The shape a whole-element share misses: the same marked controls, plus a transcript's worth
  // of text. Text never carries these marks, so counting it hides a toolkit fact behind a 69%
  // share and leaves `,+menu` on every control line — measured on ChatGPT, 206 of 208 controls
  // and 0 of 91 text rows marked.
  stub.chatty = true;
  const chatty = firstText(await h.observe({}));
  check("text rows do not dilute the share — the denominator is CONTROLS",
    /every control below also offers menu/.test(chatty)
    && !chatty.split("\n").some((l) => /^[+-]? ?e\d+: /.test(l) && /\[[^\]]*\+menu/.test(l)),
    chatty.split("\n").find((l) => /every control below/.test(l))?.slice(0, 70) ?? "(no line)");
  stub.chatty = false;
  stub.crowded = false;
  await h.observe({});

  // ...and the case the control floor protects: a small window where an open menu
  // IS most of it. A control FLOOR keeps it, which the share alone could not.
  stub.tinyMenu = true;
  const tiny = firstText(await h.observe({}));
  check("a small all-marked window keeps its marks on the lines — they are the reason to act",
    !/every control below also offers/.test(tiny) && /\+pick/.test(tiny),
    tiny.split("\n").find((l) => /\+pick/.test(l))?.slice(0, 70) ?? "(no marked line)");
  stub.tinyMenu = false;
  await h.observe({});
  const back = firstText(await h.observe({}));
  check("the line goes away with the window that earned it", !/every control below also offers/.test(back));

  console.log(failures === 0 ? "\nmacos-marks: OK" : `\nmacos-marks: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
