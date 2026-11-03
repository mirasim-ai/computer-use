/**
 * `mirasim-cu bridge [--port N] [--json]` — run the browser bridge in the foreground until killed.
 *
 * Emits ONE status line up front (JSON with --json) carrying the CDP endpoint and the
 * extension id; a host spawns this, reads the line and points COMPUTER_USE_CDP_URL at the
 * endpoint. Nothing here reaches out to a browser: the extension dials in on its own over native
 * messaging, and `--native-host` is what lets it — the bridge records itself in the shared
 * native-host install (`platform/browser/bridge/native-host.ts`) at start, and again while no
 * extension is connected, so a browser installed after the bridge started still gets a manifest.
 */
import { parseArgs } from "node:util";
import { BridgeServer } from "../../platform/browser/bridge/server.ts";
import { extensionDir } from "../../platform/browser/bridge/extension-id.ts";
import { defaultBridgeSocket, installNativeHost } from "../../platform/browser/bridge/native-host.ts";
import { emitUsage, wantsHelp } from "./help.ts";
import { hostEntry, hostName, NATIVE_HOST_OPTIONS, NATIVE_HOST_USAGE } from "./native-host-options.ts";

/** How often a bridge with no extension on the line re-runs the install. Idempotent and cheap (a
 *  dozen stats); the extension itself re-checks a missing host only every few minutes. */
const HOST_SWEEP_MS = 30_000;

function usage(asked: boolean): never {
  emitUsage(`Usage: mirasim-cu bridge [--native-host] [--port N] [--socket P] [--json] [--verbose]

Runs in the foreground until killed, printing the CDP endpoint as its first line
(--json for one parseable object). Point COMPUTER_USE_CDP_URL at that endpoint.

  --native-host  record this bridge so the browser extension can reach it (writes the
                 native-messaging manifests; see \`setup extension\`). Implies a socket
  --port N       listen port (default 0 = pick a free one)
  --socket P     the native-messaging shim (bridge-host) dials this socket — the one way
                 the extension reaches this process (default with --native-host:
                 <COMPUTER_USE_HOME>/bridge.sock)
  --json         print the status line as JSON (cdpUrl, extensionId, extensionDir, nativeHost)
  --verbose      bridge diagnostics on stderr

With --native-host:
${NATIVE_HOST_USAGE}`, asked);
}

export async function runBridgeCommand(rest: string[]): Promise<void> {
  // Before parseArgs: it is strict, so `--help` would throw as an unknown option.
  if (wantsHelp(rest)) usage(true);
  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: "string", default: "0" },
      socket: { type: "string" },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      "native-host": { type: "boolean", default: false },
      ...NATIVE_HOST_OPTIONS,
    },
  });
  const port = Number.parseInt(values.port ?? "0", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) usage(false);
  const socketPath = values.socket ?? (values["native-host"] ? defaultBridgeSocket() : undefined);
  // Diagnostics go to STDERR: stdout carries the one status line a host parses.
  const server = new BridgeServer({
    port,
    ...(socketPath ? { socketPath } : {}),
    ...(values.verbose ? { log: (...args: unknown[]) => console.error("[bridge]", ...args) } : {}),
  });
  await server.start();

  // The record is built once (the command and PATH this process was started with); the sweep
  // re-publishes it. A failure is reported, never fatal: the bridge still serves an extension
  // that is already connected, and the status line is where a host learns why one cannot be.
  let sweep: NodeJS.Timeout | null = null;
  let nativeHost: { name: string; manifests: string[]; owners: string[] } | { error: string } | undefined;
  if (values["native-host"] && socketPath) {
    let entry: ReturnType<typeof hostEntry> | null = null;
    let lastReport = "";
    const install = (): void => {
      try {
        entry ??= hostEntry(values, socketPath, server.extensionIds);
        const r = installNativeHost(entry, hostName(values));
        nativeHost = { name: r.name, manifests: r.manifests, owners: r.owners };
      } catch (e) {
        nativeHost = { error: e instanceof Error ? e.message : String(e) };
      }
      const report = JSON.stringify(nativeHost);
      // Only a change is news (the first run is reported on the status line instead).
      if (lastReport && report !== lastReport) console.error("[bridge] native host", report);
      lastReport = report;
    };
    install();
    sweep = setInterval(() => { if (!server.extensionConnected()) install(); }, HOST_SWEEP_MS);
    sweep.unref();
  }

  // `extensionId` rather than a connect URL: there is no page to hand anybody — the extension
  // dials in over native messaging.
  const status = {
    cdpUrl: server.cdpUrl(),
    extensionId: server.extensionId,
    extensionIds: server.extensionIds,
    extensionDir: extensionDir(),
    ...(nativeHost ? { nativeHost } : {}),
  };
  if (values.json) console.log(JSON.stringify(status));
  else {
    console.log(`bridge CDP endpoint: ${status.cdpUrl}`);
    console.log(`extension id:       ${status.extensionId}`);
    console.log(`unpacked extension: ${status.extensionDir}`);
    if (nativeHost) console.log(`native host:        ${"error" in nativeHost ? `not installed — ${nativeHost.error}` : `${nativeHost.name} → ${nativeHost.manifests.join(", ") || "(no browser folder found)"}`}`);
  }
  // Foreground service: run until the host kills us; the socket keeps the loop alive.
  //
  // Orphan backstop: a SIGKILLed or crashed host sends no signal. With
  // COMPUTER_USE_BRIDGE_PARENT_STDIN=1 the host's stdin pipe closing is our cue to wind down.
  // An explicit env contract, not sniffing stdin: a hand-run bridge may have /dev/null
  // (immediate EOF) or a TTY there.
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    if (process.env.COMPUTER_USE_BRIDGE_PARENT_STDIN === "1") {
      process.stdin.resume();
      process.stdin.once("end", resolve);
      process.stdin.once("close", resolve);
      process.stdin.once("error", resolve);
    }
  });
  if (sweep) clearInterval(sweep);
  server.stop();
}
