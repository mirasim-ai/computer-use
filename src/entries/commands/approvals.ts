/**
 * `mirasim-cu approvals` — the "always allow" answers kept on disk, made visible.
 *
 * The stores themselves (`macos/approvals.ts`, `windows/app-gate.ts`) are written by the consent
 * prompt; this command only reads, adds and removes entries in them, so revoking an app no longer
 * means hand-editing JSON. A host that keeps its own list (`COMPUTER_USE_*_APPROVALS=""`) has no
 * store here, and the command says so rather than editing a file nobody reads.
 *
 * Windows apps are not part of this release (registry.ts `windowsAppsOptedIn`): their store is
 * reachable, and named in the usage, only where a host opted in.
 */

import { parseArgs } from "node:util";
import { MacosApprovals } from "../../platform/macos/approvals.ts";
import { windowsAppsOptedIn } from "../../platform/registry.ts";
import { WindowsApprovals } from "../../platform/windows/app-gate.ts";
import { emitUsage, wantsHelp } from "./help.ts";

type Platform = "macos" | "windows";

const usage = (windowsApps: boolean) => `Usage: mirasim-cu approvals [list] [--json]${windowsApps ? " [--platform P]" : ""}
       mirasim-cu approvals add <app>${windowsApps ? " [--platform P]" : ""}
       mirasim-cu approvals remove <app>${windowsApps ? " [--platform P]" : ""}

  list     the apps answered "always allow" (default)
  add      allow an app ahead of its first prompt
  remove   revoke one; the next use asks again (a session that answered it itself keeps it
           until that session ends)

  Only a client that can ask (MCP elicitation) consults this list. One that cannot drives every
  app, or only COMPUTER_USE_MACOS_FALLBACK_APPS when that is set.

  <app>    ${windowsApps
    ? `macOS: a bundle id (com.apple.TextEdit; find one with
           \`osascript -e 'id of app "TextEdit"'\`). Windows: the executable's name without
           .exe (WINWORD; CalculatorApp for Calculator — a Store app goes by its own program,
           never ApplicationFrameHost). A refusal names the exact command to run.
  --platform P   macos | windows (default: this machine's)`
    : `a macOS bundle id (com.apple.TextEdit; find one with
           \`osascript -e 'id of app "TextEdit"'\`). A refusal names the exact command to run.`}
  --json         print the result as JSON`;

interface Store {
  readonly file: string | null;
  list(): string[];
  add(app: string): void;
  remove(app: string): void;
}

function store(platform: Platform): Store {
  return platform === "macos" ? new MacosApprovals(process.env) : new WindowsApprovals(process.env);
}

function hostPlatform(windowsApps: boolean): Platform | null {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" && windowsApps ? "windows" : null;
}

const envKey = (platform: Platform) => (platform === "macos" ? "COMPUTER_USE_MACOS_APPROVALS" : "COMPUTER_USE_WINDOWS_APPROVALS");

export async function runApprovalsCommand(argv: string[]): Promise<void> {
  const windowsApps = windowsAppsOptedIn();
  const USAGE = usage(windowsApps);
  if (wantsHelp(argv)) emitUsage(USAGE, true);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { platform: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const [verb = "list", app, ...extra] = positionals;
  const platform = (values.platform ?? hostPlatform(windowsApps)) as Platform | null;
  if (platform === null) {
    // No usage dump: the command was typed right, on a system whose apps this release does not drive.
    console.error("approvals are for native apps, which this release drives on macOS only: there is no list on this system.");
    process.exit(1);
  }
  if (platform !== "macos" && !(platform === "windows" && windowsApps)) emitUsage(USAGE, false);
  if (verb !== "list" && verb !== "add" && verb !== "remove") emitUsage(USAGE, false);
  if (extra.length || (verb === "list") !== !app?.trim()) emitUsage(USAGE, false);

  const s = store(platform);
  if (!s.file) {
    console.error(`${platform} approvals are kept by the host (${envKey(platform)}=""): change them in its own settings.`);
    process.exit(1);
  }
  const before = s.list();
  if (verb === "add") s.add(app!.trim());
  if (verb === "remove") s.remove(app!.trim());

  const apps = s.list();
  // The stores swallow write errors (a prompt must never fail over one); a command must not.
  const want = platform === "windows" ? app?.trim().toLowerCase() : app?.trim();
  if ((verb === "add" && !apps.includes(want!)) || (verb === "remove" && apps.includes(want!))) {
    console.error(`could not write ${s.file}`);
    process.exit(1);
  }
  if (values.json) {
    console.log(JSON.stringify({ platform, file: s.file, apps }));
    return;
  }
  if (verb === "add") console.log(before.includes(want!) ? `already allowed: ${want}` : `allowed: ${want}`);
  if (verb === "remove") console.log(before.includes(want!) ? `revoked: ${want}` : `not in the list: ${want}`);
  if (verb !== "list") return;
  console.log(`${platform} approvals (${s.file}):`);
  console.log(apps.length ? apps.map((a) => `  ${a}`).join("\n") : "  (none — every app is asked about on first use)");
}
