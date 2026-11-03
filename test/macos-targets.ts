/** Hermetic coverage of what a NAMED target may resolve to.
 *
 * The enumeration and the lookup answer different questions (ax-apps.swift `liveApps`): the
 * listing carries the apps a user can see, a lookup carries the one the caller asked for. So a
 * menu-bar-only app is drivable by bundle id while never appearing in `computer.surfaces()` — and the
 * same relaxation reaches processes with no UI at all, which must be refused in words that do not
 * send the model to `launch_app`.
 *
 * Measured without the refusal: `com.apple.chronod` (LSBackgroundOnly) answered a lookup, and the
 * `tree` that followed spent the AX timeout to fail as "the app did not answer Accessibility (timed
 * out or does not support it)" — a daemon reported as a broken app. */

import { createHarness } from "./harness.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { findCall, stubTransport } from "./macos-fixtures.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";
/** The driver refuses before any observation, so the harness's act path is where the words land. */
const named = (bundle: string, env: NodeJS.ProcessEnv = process.env) => {
  const stub = stubTransport();
  const driver = new MacosDriver({ transport: stub.transport, bundle, env });
  return { stub, h: createHarness(driver) };
};

async function main() {
  // A menu-bar app: not in the listing, drivable by name.
  {
    const { stub, h } = named("com.bjango.istatmenus.status");
    const listing = firstText(await h.targets());
    check("a menu-bar-only app is not in the surfaces listing", !/istatmenus/.test(listing), listing.split("\n")[0]);
    const read = firstText(await h.observe({}).catch((e: Error) => ({ content: [{ type: "text", text: e.message }] })));
    check("...but naming its bundle id resolves it — the lookup is asked about that bundle alone",
      JSON.stringify(findCall(stub.calls, "lookup")?.params.bundles) === '["com.bjango.istatmenus.status"]'
      && !/is not running|BACKGROUND-ONLY/.test(read),
      read.split("\n")[0]);
    const grounding = new MacosDriver({ env: {} as NodeJS.ProcessEnv }).promptFragment();
    check("...and the grounding text says the listing is not the limit — a model cannot name what nothing told it about",
      grounding.includes("not in it but IS drivable — name its bundle id"),
      grounding.split(". ").find((sentence) => /menu-bar-only/.test(sentence)) ?? "(not said)");
  }

  // A process with no UI: refused by name, and never through launch_app.
  {
    const { stub, h } = named("com.apple.chronod");
    const refusal = firstText(await h.observe({}).catch((e: Error) => ({ content: [{ type: "text", text: e.message }] })));
    check("a background-only process is refused in its own words, not offered as a target",
      /BACKGROUND-ONLY process \(LSBackgroundOnly\)/.test(refusal) && /pid 671/.test(refusal)
      && !/launchApp|is not running/.test(refusal), refusal.split("\n")[0]);
    check("...and the refusal costs no tree walk — the flag comes with the lookup row",
      !stub.calls.some((c) => c.op === "tree"), JSON.stringify(stub.calls.map((c) => c.op)));
  }

  // ── the app this agent runs inside is one target, not two contradictory ones ──
  // Filtered out of the RUNNING half only, it comes back through the "installed but not running"
  // half, telling an allow-list carrying it "not running; launchApp({bundle}) starts it" about an
  // app running with windows open.
  {
    const stub = stubTransport();
    const h = createHarness(new MacosDriver({
      transport: stub.transport,
      env: { COMPUTER_USE_MACOS_FALLBACK_APPS: "com.example.agenthost,com.apple.calculator", COMPUTER_USE_HOST_APPS: "com.example.agenthost" } as NodeJS.ProcessEnv,
    }));
    const listing = firstText(await h.targets());
    check("the host app is in NEITHER half of the listing — no row, rather than a row that lies",
      !/agenthost/.test(listing) && /calculator/.test(listing), listing.split("\n").slice(0, 3).join(" | "));

    const { h: byName } = named("com.example.agenthost", { COMPUTER_USE_HOST_APPS: "com.example.agenthost" } as NodeJS.ProcessEnv);
    const refusal = firstText(await byName.observe({}).catch((e: Error) => ({ content: [{ type: "text", text: e.message }] })));
    check("…and naming it is refused in words that say why, not offered as something to launch",
      /the app this agent runs inside/.test(refusal) && !/launchApp|not running/.test(refusal), refusal.split("\n")[0]);
  }

  console.log(`\nmacos-targets: ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
