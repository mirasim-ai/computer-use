/**
 * Opt-in live smoke for the macos driver — `node scripts/test.mjs macos-live`.
 *
 * Not part of `npm test`: it needs a Mac with Accessibility granted to this shell's responsible
 * app, a Swift toolchain (or `COMPUTER_USE_MACOS_AX_BIN`), and a running TextEdit — the environment the
 * hermetic suite refuses to depend on (`test/macos-ui.ts` runs everywhere).
 *
 *   open -b com.apple.TextEdit && node scripts/test.mjs macos-live
 *
 * TextEdit and not Calculator: it is AppKit, takes AXSetValue in the background, and has a text
 * area whose content can be read back — so the assertion is a real write verified by a real read,
 * with the app never brought to the front. What it asserts is the driver's contract, not the
 * app's content: the harness builds over it, targets are windows, an observation carries refs, the
 * universal write verb lands and reads back, a screenshot is a PNG of one window, the stale-ref
 * gate refuses, and `close()` leaves the app running.
 */

import { createDriver } from "../src/platform/registry.ts";
import type { ToolResult } from "../src/platform/types.ts";
import { createHarness } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: ToolResult) => r.content.find((c) => c.type === "text")?.text ?? "";

const bundle = process.env.COMPUTER_USE_TEST_APP?.trim() || "com.apple.TextEdit";
const driver = createDriver("macos", { bundle });
const h = createHarness(driver);

check("the registry knows the platform", driver.platform === "macos", driver.platform);
// (The "four tools build against it" count went with the verb tools; the harness builds or throws.)
check("the grounding fragment says actions stay in the background", /BACKGROUND/.test(driver.promptFragment()));

const t0 = Date.now();
const targets = firstText(await h.targets());
console.log(`\ntargets (${Date.now() - t0} ms):\n${targets.split("\n").slice(0, 8).join("\n")}\n`);
check("targets are windows", /window/.test(targets), targets.split("\n")[0]);

const t1 = Date.now();
const obs = await h.observe({});
const text = firstText(obs);
console.log(`observe (${Date.now() - t1} ms) — ${text.length} chars, first 12 lines:\n${text.split("\n").slice(0, 12).join("\n")}\n`);
check("the observation carries elements with refs", /\be\d+\b/.test(text), `${(text.match(/\be\d+\b/g) ?? []).length} refs`);
const textbox = /(e\d+): textbox/.exec(text)?.[1];
check("TextEdit exposes its text area as a textbox", !!textbox, textbox ?? "none");

if (textbox) {
  const marker = `computer-use macos-live ${Date.now()}`;
  const write = await h.act("set_text", { ref: textbox, text: marker });
  check("set_text by ref dispatches", write.ok, write.note || firstText(write).split("\n")[0]);
  const after = firstText(await h.observe({ what: "text" }));
  check("the written text reads back through the tree", after.includes(marker));
}

const shot = await h.observe({ what: "screenshot" });
const image = shot.content.find((c) => c.type === "image") as { data?: string; mimeType?: string } | undefined;
check("a screenshot is a PNG of the window", !!image?.data && image.mimeType === "image/png" && Buffer.from(image.data, "base64").subarray(1, 4).toString() === "PNG",
  `${image?.data?.length ?? 0} base64 chars`);

const stale = await h.act("click", { ref: "e99999" });
check("an unknown ref is refused, not pressed", (stale.details as { error?: string }).error === "stale_ref");

await driver.close();
const again = createDriver("macos", { bundle });
let alive = false;
try {
  alive = (await again.listTargets()).some((t) => t.title.includes(bundle));
} catch (e) {
  console.log(`  re-list failed: ${(e as Error).message.split("\n")[0]}`);
}
await again.close();
check("close() stopped the helper without quitting the app", alive);

console.log(`\nmacos-live: ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
