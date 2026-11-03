/** Hermetic coverage of what a macOS observation does NOT list, and why the two omissions read
 * differently: the control cap says "narrow your target"; the text budget says "text()". They are
 * kept apart because only controls are actionable — one shared budget let a long transcript
 * (2,082 text runs vs 232 controls) crowd out the composer and its Send button. */

import { readFileSync } from "node:fs";

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
  await h.observe({});

  stub.overflow = 7;
  const capped = firstText(await h.observe({}));
  // No count in the note: the cap is per-platform, and the exact number lives in coverage.
  check("controls past the listing budget are reported, with the way out",
    /exceed this observation's element cap \(narrow your target, or read the page\)/.test(capped),
    capped.split("\n").find((l) => /element cap/.test(l)) ?? capped.split("\n")[0]);
  stub.overflow = 0;

  // One number written twice: the helper's `tree` defaults and the driver's constants. A caller
  // that omits a parameter (a probe, a bench) would silently walk a DIFFERENT tree than the
  // product — at depth 24 vs 64, ChatGPT's window is 288 nodes vs 2,723.
  const swift = readFileSync(new URL("../src/platform/macos/ax/main.swift", import.meta.url), "utf8");
  const shapes = readFileSync(new URL("../src/platform/macos/ax-shapes.ts", import.meta.url), "utf8");
  const constant = (name: string) => Number(shapes.match(new RegExp(`${name} = (\\d+)`))?.[1]);
  const helperDefault = (param: string) => Number(swift.match(new RegExp(`req\\.int\\("${param}", (\\d+)\\)`))?.[1]);
  for (const [param, name] of [
    ["max", "TREE_MAX_VISITED"], ["deadlineMs", "TREE_WALK_DEADLINE_MS"], ["maxElements", "TREE_MAX_ELEMENTS"],
    ["maxText", "TREE_MAX_TEXT"], ["depth", "TREE_MAX_DEPTH"],
  ] as const) {
    const [a, b] = [helperDefault(param), constant(name)];
    check(`the helper's default ${param} is the driver's ${name}`, Number.isFinite(a) && a === b, `${a} vs ${b}`);
  }

  // The walk's own budgets: a node count is a window too big for one read, a deadline an app too
  // slow, so the advice differs. 8,000 nodes because 4,000 cuts a real Electron window (5,924) in
  // half, and depth-first drops the BOTTOM — the composer and its Send button.
  for (const [by, expected] of [["nodes", /focus a smaller window or read text/], ["time", /answered too slowly/]] as const) {
    stub.cappedBy = by;
    const out = firstText(await h.observe({}));
    check(`a walk stopped by its ${by === "nodes" ? "NODE budget" : "DEADLINE"} says so in its own terms`,
      /stopped at its read budget \(8000 nodes\)/.test(out) && expected.test(out),
      out.split("\n").find((l) => /read budget/.test(l)) ?? out.split("\n")[0]);
  }
  stub.cappedBy = "";

  stub.textOverflow = 1670;
  const textCut = firstText(await h.observe({}));
  check("text past the TEXT budget is a count of its own, and names text() rather than a narrower target",
    /1670 static text runs past this observation's text budget/.test(textCut)
    && /text\(\) returns all of it/.test(textCut)
    && !/element cap/.test(textCut),
    textCut.split("\n").find((l) => /text runs/.test(l)) ?? textCut.split("\n")[0]);
  stub.textOverflow = 0;

  stub.calls.length = 0;
  await h.api.text();
  const walks = stub.calls.filter((c) => c.op === "tree").map((c) => c.params);
  check("the text channel asks for a bigger text budget than the observation does — else the window's own text is cut, silently",
    walks.some((p) => Number(p.maxText) > 200) && walks.every((p) => Number(p.maxElements) === 300),
    JSON.stringify(walks.map((p) => ({ maxElements: p.maxElements, maxText: p.maxText }))));

  // ── a window that answered the accessibility switch and still shows nothing ──
  // VS Code cold: three nameless buttons, text() empty. Unexplained that reads as "this app is
  // empty"; its web content is just not published yet, and the routes that work must be named.
  {
    const thin = stubTransport();
    thin.thinAfterNudge = true;
    const thinH = createHarness(new MacosDriver({ transport: thin.transport, ...ONE_APP }));
    const seen = (await thinH.observe({})).content.find((c) => c.type === "text")?.text ?? "";
    check("a window still thin after the nudge says so, and names the menu and the screenshot as the routes left",
      /answered the accessibility switch/.test(seen) && /menu\(\{\}\)/.test(seen) && /click\(\{x, y\}\)/.test(seen),
      seen.split("\n").find((l) => /accessibility switch/.test(l))?.slice(0, 80) ?? seen.slice(0, 80));

    // Not on an ordinary small window: a two-button alert is not an app that failed to publish.
    const ordinary = stubTransport();
    const ordinaryH = createHarness(new MacosDriver({ transport: ordinary.transport, ...ONE_APP }));
    const normal = (await ordinaryH.observe({})).content.find((c) => c.type === "text")?.text ?? "";
    check("…and a window that never needed the switch says nothing about it",
      !/accessibility switch/.test(normal));
  }

  console.log(`\nmacos-budgets: ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
