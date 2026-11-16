/**
 * The opt-in for native Windows apps, as a leaf: a command that only needs to know whether the
 * host opted in (`mirasim-cu approvals`) must not load every driver to ask (registry.ts imports
 * them all).
 */

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
