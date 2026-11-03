/**
 * Opt-in real-attach smoke for the electron driver — `node scripts/test.mjs electron-live`. Not part of
 * `npm test`: it needs a running Electron app with its renderer debugging port open, e.g.
 *
 *   /path/to/YourApp --remote-debugging-port=9333
 *
 * (COMPUTER_USE_ELECTRON_CDP_URL if not on the default port). Close that app when done: the port
 * is unauthenticated, so it hands the app to any local process while open.
 *
 * Asserts the driver's contract, not the app's content: targets are WINDOWS, observations carry
 * refs, a universal verb dispatches, DevTools is filtered out — and `close()` leaves the app
 * running.
 */

import { createDriver } from "../src/platform/registry.ts";
import { createHarness } from "./harness.ts";
import type { ToolResult } from "../src/platform/types.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: ToolResult) => r.content.find((c) => c.type === "text")?.text ?? "";

const cdpUrl = process.env.COMPUTER_USE_ELECTRON_CDP_URL?.trim() || "http://127.0.0.1:9333";
const driver = createDriver("electron", { cdpUrl });
const h = createHarness(driver);

check("the registry knows the platform", driver.platform === "electron", driver.platform);
check("the grounding fragment says it is an app, not a page",
  /DESKTOP APPLICATION/.test(driver.promptFragment()) && /WINDOWS, not tabs/.test(driver.promptFragment()));

const targets = firstText(await h.targets());
console.log(`\ntargets:\n${targets}\n`);
check("targets come back", targets.length > 0);
check("targets are windows, not tabs", /window/i.test(targets) && !/\btab\b/i.test(targets), targets.split("\n")[0]);
check("DevTools is not offered as a surface", !/devtools/i.test(targets));

const obs = await h.observe({});
const text = firstText(obs);
console.log(`observe — ${text.length} chars, first 12 lines:\n${text.split("\n").slice(0, 12).join("\n")}\n`);
check("the observation carries elements with refs", /\be\d+\b/.test(text), `${(text.match(/\be\d+\b/g) ?? []).length} refs`);
const details = obs.details as { elementCount?: number; url?: string };
check("the element count is real", (details.elementCount ?? 0) > 0, String(details.elementCount));

// `keys Escape`: a universal verb that changes nothing a person would miss.
const act = await h.act("keys", { chord: "Escape" });
check("a universal verb dispatches", act.ok, firstText(act).split("\n")[0]);

// The stale-ref gate, proving refs are bookkept the same way as on a page.
const stale = await h.act("click", { ref: "e99999" });
check("an unknown ref is refused, not clicked", stale.details?.error === "stale_ref");

// The console verb: a page-side exception is a result (as the console shows it), not a failure.
const js = await h.act("run_js", { code: "1 + 1" });
check("run_js evaluates an expression", /result: 2\b/.test(firstText(js)), firstText(js).split("\n")[0]);
const thrown = await h.act("run_js", { code: "totally_undefined_fn()" });
check("a page exception is a result, not a failed action",
  thrown.ok && /threw:/.test(firstText(thrown)), firstText(thrown).split("\n")[0]);

await driver.close();
// The app must have survived it. A fresh driver can only attach if the process is still there.
const after = createDriver("electron", { cdpUrl });
let reattached = false;
try {
  await after.listTargets();
  reattached = true;
} catch (e) {
  console.log(`  reattach failed: ${(e as Error).message.split("\n")[0]}`);
}
await after.close();
check("close() disconnected without quitting the app", reattached);

console.log(`\nelectron-live: ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
