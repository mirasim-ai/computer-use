/**
 * Driver registry — the only file that knows every platform. Pure lookup:
 * session assembly (env knobs, tools) lives in profile.ts. It also picks the live-preview
 * stream for a target's capture route (preview.ts), for the same reason.
 */

import type { ComputerUseDriver } from "./driver.ts";
import { BrowserDriver } from "./browser/driver.ts";
import { ElectronDriver } from "./electron/driver.ts";
import { MacosDriver } from "./macos/driver.ts";
import { WindowsDriver } from "./windows/driver.ts";
import { CdpPreviewStream } from "./chromium/preview-stream.ts";
import { MacosPreviewStream } from "./macos/preview-stream.ts";
import type { BrowserConfigOptions } from "./browser/config.ts";
import type { PreviewSink, PreviewStream, PreviewTarget, UserConsent } from "./types.ts";

export type DriverOptions = {
  cdpUrl?: string;
  /** Per-session browser surface knobs — profile dir, tab claim, window posture, attachment.
   *  Anything left out falls back to the environment (see browser/config.ts): an embedder
   *  running several sessions in one process passes them explicitly, because a process-wide
   *  variable cannot carry one value per session. */
  browser?: BrowserConfigOptions;
  /** macOS app bundle id to drive when the caller binds nothing. */
  bundle?: string;
  /** The host's way to ask its user (MCP elicitation) — what clears a macOS app the session has
   *  not been allowed yet. Absent for an entry with no protocol to ask over. */
  consent?: UserConsent;
  /** The environment every unset knob falls back to. An in-process host passes the env it
   *  WOULD have spawned with, so one process can hold several differently-configured
   *  sessions; the default is this process's own. */
  env?: NodeJS.ProcessEnv;
};

const REGISTRY: Record<string, (opts: DriverOptions) => ComputerUseDriver> = {
  browser: (opts) => new BrowserDriver(opts.cdpUrl, undefined, opts.browser, opts.env),
  // Attaches to a RUNNING Electron app's renderer; never starts one (electron/driver.ts).
  electron: (opts) => new ElectronDriver({ cdpUrl: opts.cdpUrl, env: opts.env }),
  // Native macOS apps through Accessibility, via a resident Swift helper (macos/driver.ts).
  macos: (opts) => new MacosDriver({ bundle: opts.bundle, env: opts.env, consent: opts.consent }),
  // Native Windows apps through UI Automation, via a resident Rust helper (windows/driver.ts).
  // Not offered in this release: mounted only for a host that opts in (windowsAppsOptedIn).
  windows: (opts) => new WindowsDriver({ env: opts.env, consent: opts.consent }),
  // future: linux, ios
};

/**
 * Whether the `windows` platform may be mounted. Native Windows apps are not part of this
 * release: the driver and its helper stay in the tree and keep being published, but nothing
 * says so to users, and a session that names the platform is refused. A host that ships the
 * driver at its own risk sets `COMPUTER_USE_UNSUPPORTED_WINDOWS=1`, which is deliberately
 * absent from README and docs/embedding.md. The browser and Electron platforms on Windows are
 * unaffected: neither goes through this driver or its helper.
 */
export function windowsAppsOptedIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPUTER_USE_UNSUPPORTED_WINDOWS === "1";
}

/** The platforms a session may name: what the errors and the help list. */
function offered(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(REGISTRY).filter((id) => id !== "windows" || windowsAppsOptedIn(env));
}

export function createDriver(id: string, opts: DriverOptions = {}): ComputerUseDriver {
  const env = opts.env ?? process.env;
  if (id === "windows" && !windowsAppsOptedIn(env)) {
    throw new Error(`the "windows" platform (native Windows apps) is not part of this release (available: ${offered(env).join(", ")}; `
      + "on Windows, \"browser\" and \"electron\" work as on any other system)");
  }
  const create = REGISTRY[id];
  if (!create) throw new Error(`unknown driver "${id}" (available: ${offered(env).join(", ")})`);
  return create(opts);
}

/** Read-only video of one preview target, by how it is captured: a macOS window through its own
 *  capture helper, anything else (a browser tab, an Electron renderer) through CDP. */
export function createPreviewStream(target: PreviewTarget, sink: PreviewSink, maxSize: number,
  env: NodeJS.ProcessEnv = process.env): PreviewStream {
  return target.capture.type === "macos"
    ? new MacosPreviewStream(target, sink, maxSize, env)
    : new CdpPreviewStream(target, sink, maxSize);
}
