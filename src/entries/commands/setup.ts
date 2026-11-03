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

  browser    check for a driveable Chrome; a miss names the fix (never auto-installs)
  macos      check Accessibility + Screen Recording for the app that launched this; a miss
             opens its System Settings pane (--no-open: only report). Exit 1 while one is missing
  extension  let the browser extension start this computer-use's bridge: writes the
             native-messaging manifest into every Chromium-family browser found
             (--remove takes this computer-use's record back; the last one out
             removes the manifests)

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
  usage(wantsHelp(argv));
}
