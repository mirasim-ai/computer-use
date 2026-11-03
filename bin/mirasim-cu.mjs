#!/usr/bin/env node
/**
 * The `mirasim-cu` executable — and, in a repo checkout, the one that runs the SOURCE:
 * nothing keeps the checkout's `tsc` build (`dist/entries/cli.js`) current, and a host that
 * spawns this bin for its children and the browser bridge would run stale fixes (e.g. without
 * the parent-death backstop, leaving orphan bridges holding a port).
 *
 * ONE process, deliberately: tsx is registered in-process rather than spawning
 * `node --import tsx …`, because the bridge relies on stdin as the parent-death probe and on
 * signal/stdio pass-through.
 *
 * Where the source is not present (a published tarball, a bundled copy) the build runs.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src", "entries", "cli.ts");
const built = join(root, "dist", "entries", "cli.js");

/** Source only when it can actually be RUN: a tarball may carry `src/` with no tsx beside it. */
const runnable = existsSync(source) && (await import("tsx/esm/api").catch(() => null));
if (runnable) {
  runnable.register();
  // A URL, not a path: on Windows `import("C:\…")` is read as a URL with the scheme `c:` and refused.
  await import(pathToFileURL(source).href);
} else {
  await import(pathToFileURL(built).href);
}
