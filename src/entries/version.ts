/**
 * This package's own version — NOT its host's.
 *
 * Read from package.json and shared by `--version` and the MCP serverInfo so they never
 * disagree. `../../package.json` is the package root from both `src/` and `dist/`.
 */

import { readFileSync } from "node:fs";

export function ownVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}
