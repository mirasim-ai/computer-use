/**
 * `mirasim-cu browser state export|import` — move the managed browser's login state
 * (cookies + per-origin localStorage, Playwright storage_state shape) between profiles: log in
 * by hand once, export, import into other profiles before their sessions start. Both verbs
 * adopt-or-launch the COMPUTER_USE_PROFILE_DIR browser (`browser open`'s semantics); import is
 * idempotent.
 *
 * With no --out, stdout carries the state JSON and NOTHING else — summaries go to stderr.
 * Failures exit non-zero with a one-line reason on stderr (acquisition dead-ends keep their
 * multi-line guidance).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { acquireManagedBrowser } from "../../platform/browser/acquire.ts";
import { exportStorageState, importStorageState, type BrowserStorageState } from "../../platform/browser/state.ts";
import { emitUsage, wantsHelp } from "./help.ts";

function usage(asked: boolean): never {
  emitUsage(`Usage: mirasim-cu browser state export [--out state.json]
       mirasim-cu browser state import --in state.json

State shape is Playwright storage_state: {cookies: [...], origins: [{origin, localStorage: [...]}]}.
The target browser/profile follows COMPUTER_USE_PROFILE_DIR (default ~/.mirasim-computer-use/chrome), adopt-or-launch.
export with no --out prints the JSON to stdout (stderr carries the summary).`, asked);
}

export async function runBrowserStateCommand(argv: string[]): Promise<void> {
  const verb = argv[0];
  if (verb !== "export" && verb !== "import") usage(wantsHelp(argv));
  // Before parseArgs: it is strict, so `--help` would throw as an unknown option.
  if (wantsHelp(argv.slice(1))) usage(true);
  let values: { out?: string; in?: string };
  try {
    values = parseArgs({
      args: argv.slice(1),
      options: { out: { type: "string" }, in: { type: "string" } },
    }).values;
  } catch {
    usage(false);
  }

  if (verb === "export") {
    const { browser } = await acquireManagedBrowser();
    try {
      const state = await exportStorageState(browser);
      const json = `${JSON.stringify(state, null, 2)}\n`;
      if (values.out) writeFileSync(values.out, json);
      else process.stdout.write(json);
      console.error(
        `computer-use: exported ${state.cookies.length} cookie(s), ${state.origins.length} origin(s) with localStorage`
          + `${values.out ? ` → ${values.out}` : ""}`,
      );
    } finally {
      // Disconnect only — the managed browser outlives the command (acquire.ts contract).
      await browser.close().catch(() => {});
    }
    return;
  }

  if (!values.in) usage(false);
  let state: BrowserStorageState;
  try {
    state = JSON.parse(readFileSync(values.in, "utf8")) as BrowserStorageState;
  } catch (e) {
    console.error(`computer-use: cannot read state file ${values.in}: ${(e as Error).message.split("\n")[0]}`);
    process.exit(1);
  }
  if (!Array.isArray(state?.cookies) || !Array.isArray(state?.origins)) {
    console.error(`computer-use: ${values.in} is not a storage-state JSON (expected {cookies: [], origins: []})`);
    process.exit(1);
  }
  const { browser, profileDir } = await acquireManagedBrowser();
  try {
    await importStorageState(browser, state);
    console.error(
      `computer-use: imported ${state.cookies.length} cookie(s), ${state.origins.length} origin(s) into ${profileDir}`,
    );
  } finally {
    await browser.close().catch(() => {});
  }
}
