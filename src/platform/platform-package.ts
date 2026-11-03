/**
 * The prebuilt native helper an npm install carries: one `@mirasim/computer-use-<platform>-<arch>`
 * package per target, each holding just that target's helper binary and gated by `os`/`cpu`, all
 * listed as optional dependencies of this package so npm installs only the one this machine runs
 * (`scripts/platform-packages.mjs` builds and lists them).
 *
 * Resolved from this module, so it finds the package wherever npm hoisted it. Null when none is
 * installed — a checkout, a host's own bundle, an install with `--omit=optional` — and the caller
 * moves on to building from sources.
 */

import { createRequire } from "node:module";

export function platformPackageHelper(file: string): string | null {
  try {
    return createRequire(import.meta.url).resolve(`@mirasim/computer-use-${process.platform}-${process.arch}/${file}`);
  } catch {
    return null;
  }
}
