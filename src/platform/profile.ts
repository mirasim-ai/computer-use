/**
 * Session bootstrap: resolve driver(s) into a frozen profile with its tool list. The
 * model never chooses these — explicit options, then env, then defaults, read ONCE per session.
 * Options win over env so several sessions can share one process (see platform/browser/config.ts).
 */

import { createDriver } from "./registry.ts";
import { createComputerUseTools } from "./tools/index.ts";
import type { ComputerUseDriver } from "./driver.ts";
import type { ComputerUseToolSpec, UserConsent } from "./types.ts";
import type { BrowserConfigOptions } from "./browser/config.ts";
import { ComputerUseOwnership, type OwnershipProvider } from './ownership.ts';

export interface Profile {
  /** The FIRST mounted platform — the one the handshake's grounding text is written for. */
  driver: ComputerUseDriver;
  /** Every mounted platform, first included: what a lifecycle edge (turn end, shutdown) must reach. */
  drivers: ComputerUseDriver[];
  tools: ComputerUseToolSpec[];
}

/**
 * What a host may fix per session; each falls back to the environment (what the CLI uses). An
 * embedder running several sessions in ONE process must pass them: env cannot vary per session.
 */
export interface ProfileOptions {
  /** An embedder's own ownership policy; absent uses the machine-wide local store. */
  ownership?: OwnershipProvider;
  /** The platforms to mount, comma-separated (`browser,macos`); falls back to `COMPUTER_USE_PLATFORMS`. */
  driver?: string;
  cdpUrl?: string;
  /** Per-session browser surface knobs (profile dir, tab claim, window posture, attachment). */
  browser?: BrowserConfigOptions;
  /** Offer the diagnostics channel. Off by default: it taxes the tool surface and helps only a
   *  caller that can read source (the MCP entry, whose host is a coding agent, turns it on). */
  diagnostics?: boolean;
  /** The host's way to ask its user — see {@link UserConsent}. */
  consent?: UserConsent;
  /** This caller already HAS the API reference (its runtime was respawned), so the first result
   *  carries a one-line pointer instead. Falls back to `COMPUTER_USE_REPL_DOCS_DELIVERED=1`. */
  docsDelivered?: boolean;
  /** The environment every unset option falls back to; defaults to this process's own.
   *  An embedder hosting several sessions passes the env it WOULD have spawned each with. */
  env?: NodeJS.ProcessEnv;
}

export function resolveProfile(opts: ProfileOptions = {}): Profile {
  const env = opts.env ?? process.env;
  // One session may mount SEVERAL platforms (`COMPUTER_USE_PLATFORMS=macos,browser`). Drivers
  // connect lazily, so mounting one the run never touches costs only an object.
  const driverIds = (opts.driver ?? env.COMPUTER_USE_PLATFORMS ?? "browser")
    .split(",").map((d) => d.trim()).filter(Boolean);
  const drivers = driverIds.map((id) => createDriver(id, {
    cdpUrl: opts.cdpUrl,
    browser: opts.browser,
    ...(opts.consent ? { consent: opts.consent } : {}),
    env,
  }));
  const driver = drivers[0]!;
  const diagnostics = opts.diagnostics ?? env.COMPUTER_USE_DIAGNOSTICS === "1";
  const mounted = drivers.map((d) => ({ driver: d }));
  const docsDelivered = opts.docsDelivered ?? env.COMPUTER_USE_REPL_DOCS_DELIVERED === "1";
  const ownership = opts.ownership ?? new ComputerUseOwnership();
  for (const d of drivers) d.onExecutorStart = ownership.trackProcess?.bind(ownership);
  return { driver, drivers, tools: createComputerUseTools(mounted, { diagnostics, docsDelivered, ownership }) };
}
