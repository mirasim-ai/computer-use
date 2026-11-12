#!/usr/bin/env node
/**
 * `mirasim-cu` entry. {@link COMMANDS} is the whole surface — there is no fall-through.
 *
 * `mcp` is the runtime; everything else is lifecycle around it (summon the browser,
 * stand up the bridge, install a dependency). computer-use runs no model and no loop of its
 * own, so there is no interactive shape and nothing to prompt.
 */

import { emitUsage, wantsHelp } from "./commands/help.ts";
import { ownVersion } from "./version.ts";

interface Command {
  /** One line for the top-level table — what this command is FOR, not how to call it. */
  readonly summary: string;
  /** Called with argv after the command name. Every body is a lazy import: nothing this
   *  command does not need may load (`mirasim-cu mcp` must not pay for the model layer). */
  readonly run: (rest: string[]) => Promise<void>;
}

/**
 * The subcommands — the ONE list, dispatched below and rendered by `--help`, so adding a command
 * here is the whole job. Each `run` handles its own `--help`.
 */
const COMMANDS: Record<string, Command> = {
  "capture-server": {
    summary: "host-owned native screenshot and preview service",
    run: async (rest) => {
      if (wantsHelp(rest)) {
        emitUsage(`Usage: mirasim-cu capture-server

Runs the one ScreenCaptureKit helper a host shares among its computer-use runtimes (macOS).
It takes no arguments: the host passes COMPUTER_USE_MACOS_CAPTURE_SOCKET, _TOKEN and _LEASE.
See "Shared native capture" in docs/embedding.md.`, true);
      }
      const { runCaptureServer } = await import("./commands/capture-server.ts");
      await runCaptureServer();
    },
  },

  mcp: {
    summary: "MCP stdio server — the runtime; atomic tools for Claude Code / Codex / any host",
    run: async (rest) => {
      // Asked before anything loads: `mcp --help` must print this, not start a server.
      if (wantsHelp(rest)) {
        emitUsage(`Usage: mirasim-cu mcp

Serves the computer_repl tools over MCP on stdin/stdout, for an agent to start:
  claude mcp add mirasim-cu -- npx -y @mirasim/computer-use mcp

It takes no arguments; the environment picks what it drives:
  COMPUTER_USE_PLATFORMS          browser (default), macos, electron; comma-separated
  COMPUTER_USE_BROWSER=extension  the browser you are signed into, through the Mirasim extension
  COMPUTER_USE_CDP_URL            drive this Chromium endpoint instead of a browser of its own
  COMPUTER_USE_ELECTRON_CDP_URL   the Electron app's endpoint (default http://127.0.0.1:9333)

Every variable is listed in docs/embedding.md.`, true);
      }
      const { serveMcp } = await import("./mcp.ts");
      await serveMcp();
    },
  },
  // `open` is what a host's browser icon calls when nothing is running yet; state export is
  // Playwright-storage_state JSON; state import is idempotent.
  browser: {
    summary: "the managed browser as a device (open, state export/import)",
    run: async (rest) => {
      if (rest[0] === "open") {
        const { openManagedBrowser } = await import("../platform/browser/acquire.ts");
        await openManagedBrowser();
        return;
      }
      if (rest[0] === "state") {
        const { runBrowserStateCommand } = await import("./commands/browser-state.ts");
        await runBrowserStateCommand(rest.slice(1));
        return;
      }
      emitUsage(`Usage: mirasim-cu browser <open | state export [--out f.json] | state import --in f.json>

  open           launch or adopt the managed browser for the user (outlives this process)
  state export   dump this profile's login state (cookies + localStorage) as JSON
  state import   inject a dumped state back into this profile's browser`, wantsHelp(rest));
    },
  },
  // Prints one JSON line with the endpoint; a host sets COMPUTER_USE_CDP_URL to it. Tabs live
  // in a labelled tab group.
  bridge: {
    summary: "CDP endpoint backed by the user's own browser, via the bridge extension",
    run: async (rest) => {
      const { runBridgeCommand } = await import("./commands/bridge.ts");
      await runBridgeCommand(rest);
    },
  },
  // A pipe between Chrome's stdio and the bridge's socket.
  "bridge-host": {
    summary: "Chrome native-messaging host for the bridge extension (Chrome spawns this)",
    run: async (rest) => {
      const { runBridgeHostCommand } = await import("./commands/bridge-host.ts");
      await runBridgeHostCommand(rest);
    },
  },
  setup: {
    summary: "bootstrap a surface (browser; macos = OS grants; extension = native-messaging host)",
    run: async (rest) => {
      const { runSetupCommand } = await import("./commands/setup.ts");
      await runSetupCommand(rest);
    },
  },
  approvals: {
    summary: "list, add or revoke the apps answered \"always allow\"",
    run: async (rest) => {
      const { runApprovalsCommand } = await import("./commands/approvals.ts");
      await runApprovalsCommand(rest);
    },
  },
};

/** Our own help — the commands below are all there is. */
function topUsage(): never {
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  const table = Object.entries(COMMANDS)
    .map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`)
    .join("\n");
  emitUsage(`mirasim-cu ${ownVersion()} — Computer Use tools over MCP (browser, electron, macos).

Usage:
  mirasim-cu <command> [args]   one of the commands below
  mirasim-cu <command> --help   that command's own usage

Commands:
${table}

Surface selection is env: COMPUTER_USE_PLATFORMS, plus COMPUTER_USE_PROFILE_DIR,
COMPUTER_USE_CDP_URL or COMPUTER_USE_ELECTRON_CDP_URL to pin WHICH surface.`, true);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [head, ...rest] = argv;

  // A host reads `--version` to detect the installed release, so it must match the package.
  if (head === "--version" || head === "-v") {
    console.log(ownVersion());
    return;
  }
  if (wantsHelp(argv)) topUsage();

  // hasOwn, not a bare lookup: `mirasim-cu constructor` would otherwise find Object.prototype's
  // and crash on `.run` instead of being reported as the unknown command it is.
  if (head !== undefined && Object.hasOwn(COMMANDS, head)) {
    await COMMANDS[head]!.run(rest);
    return;
  }
  // No fall-through: an unknown word is a mistake.
  console.error(`mirasim-cu: unknown command ${head === undefined ? "(none given)" : `"${head}"`}`);
  topUsage();
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
