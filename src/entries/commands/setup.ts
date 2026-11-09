/**
 * `mirasim-cu setup <kind>` — one command from a fresh machine to a driveable surface.
 *
 *   browser    verify a driveable Chrome exists (COMPUTER_USE_CHROME → install paths → PATH).
 *              computer-use never installs a browser — a miss exits 1 and names every way out
 *              (install command, COMPUTER_USE_CHROME, COMPUTER_USE_CDP_URL).
 *   macos      check the two TCC grants (Accessibility, Screen Recording) of the app that launched
 *              this, and for each missing one fire the OS request and open its System Settings
 *              pane (`setup-macos.ts`).
 *   extension  record this computer-use as a native-messaging host for the browser extension
 *              (`platform/browser/bridge/native-host.ts`), or take the record back with
 *              `--remove`. `bridge --native-host` does the same on every start; this is the
 *              explicit way in, and the way out.
 *   skill      copy the agent skill this package ships into Claude Code's and Codex's skill
 *              folders (`setup-skill.ts`), or take it back with `--remove`.
 *
 * The command stays rather than folding into `browser`: each platform that needs a bootstrap
 * arrives as one more kind here.
 */

import { parseArgs } from "node:util";
import { findChrome, chromeMissingError } from "../../platform/browser/acquire.ts";
import { MIRASIM_EXTENSION_ID } from "../../platform/browser/bridge/extension-id.ts";
import { defaultBridgeSocket, installNativeHost, removeNativeHost } from "../../platform/browser/bridge/native-host.ts";
import { emitUsage, wantsHelp } from "./help.ts";
import { hostEntry, hostName, hostOwner, NATIVE_HOST_OPTIONS, NATIVE_HOST_USAGE } from "./native-host-options.ts";

function usage(asked: boolean): never {
  emitUsage(`Usage: mirasim-cu setup browser
       mirasim-cu setup macos [--no-open] [--json]
       mirasim-cu setup extension [--remove] [--socket P] [--json] [options]
       mirasim-cu setup skill [--remove] [--dir D]... [--json]

  browser    check for a driveable Chrome; a miss names the fix (never auto-installs)
  macos      check Accessibility + Screen Recording for the app that launched this; a miss
             opens its System Settings pane (--no-open: only report). Exit 1 while one is missing
  extension  let the browser extension start this computer-use's bridge: writes the
             native-messaging manifest into every Chromium-family browser found
             (--remove takes this computer-use's record back; the last one out
             removes the manifests)
  skill      copy the agent skill (mirasim-computer-use) into ~/.claude/skills (Claude Code)
             and ~/.agents/skills (Codex), for each agent set up here; run it again after an
             upgrade (--dir D: that skills folder instead, repeatable; --remove takes it back)

  --socket P         the socket \`bridge\` listens on (default <COMPUTER_USE_HOME>/bridge.sock)
  --json             print the result as JSON
${NATIVE_HOST_USAGE}`, asked);
}

export async function runSetupCommand(argv: string[]): Promise<void> {
  const kind = argv[0];
  if (kind === "browser") {
    const exe = findChrome();
    if (exe) {
      console.log(`browser ready: ${exe}`);
      return;
    }
    console.error(chromeMissingError().message);
    process.exit(1);
  }
  if (kind === "macos") {
    if (wantsHelp(argv.slice(1))) usage(true);
    const { runSetupMacos } = await import("./setup-macos.ts");
    await runSetupMacos(argv.slice(1));
    return;
  }
  if (kind === "extension") {
    if (wantsHelp(argv.slice(1))) usage(true);
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        remove: { type: "boolean", default: false },
        socket: { type: "string" },
        json: { type: "boolean", default: false },
        ...NATIVE_HOST_OPTIONS,
      },
    });
    const result = values.remove
      ? removeNativeHost(hostOwner(values), hostName(values), values["manifest-dir"] ?? [])
      : installNativeHost(hostEntry(values, values.socket ?? defaultBridgeSocket(), [MIRASIM_EXTENSION_ID]), hostName(values));
    if (values.json) {
      console.log(JSON.stringify(result));
      return;
    }
    if (values.remove) {
      console.log(result.owners.length
        ? `native host ${result.name}: record removed; manifests kept for ${result.owners.join(", ")}`
        : `native host ${result.name} removed${result.manifests.length ? `: ${result.manifests.join(", ")}` : ""}`);
      return;
    }
    console.log(`native host ${result.name} installed`);
    console.log(`  manifests: ${result.manifests.join(", ") || "(none — no Chromium-family browser folder found)"}`);
    console.log(`  recorded:  ${result.owners.join(", ")}`);
    console.log("Run `mirasim-cu bridge --native-host` to let the extension connect.");
    return;
  }
  if (kind === "skill") {
    if (wantsHelp(argv.slice(1))) usage(true);
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        remove: { type: "boolean", default: false },
        dir: { type: "string", multiple: true },
        json: { type: "boolean", default: false },
      },
    });
    const { defaultSkillDirs, setupSkill } = await import("./setup-skill.ts");
    const dirs = values.dir?.length ? values.dir : defaultSkillDirs();
    const result = setupSkill(dirs, { remove: values.remove });
    if (values.json) {
      console.log(JSON.stringify(result));
      return;
    }
    if (!result.length) {
      console.error("no Claude Code (~/.claude) or Codex (~/.codex) setup found; name a skills folder with --dir");
      process.exit(1);
    }
    for (const t of result) console.log(`${t.result.padEnd(9)} ${t.dir}${t.note ? ` — ${t.note}` : ""}`);
    return;
  }
  usage(wantsHelp(argv));
}
