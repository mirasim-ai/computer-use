/**
 * `mirasim-cu setup macos` — the two TCC grants the macos platform needs, checked and
 * pointed at.
 *
 * macOS grants them to the RESPONSIBLE app (top of the spawn chain: the terminal or the MCP client
 * that launched us), never to the helper, so the answer here is about whatever app launched THIS
 * command. The check asks the helper itself (`capabilities`), the same process the driver acts
 * through. A missing grant gets the OS's own request (which adds the app to the pane's list, so
 * the user only has to tick it) and its System Settings pane opened.
 */

import { execFile, execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { AxHelperProcess } from "../../platform/macos/ax-client.ts";

const GRANTS = [
  {
    key: "accessibility",
    label: "Accessibility",
    why: "read and act in app windows",
    pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    request: 'ObjC.bindFunction("AXIsProcessTrustedWithOptions", ["bool", ["id"]]); $.AXIsProcessTrustedWithOptions($({"AXTrustedCheckOptionPrompt": true}));',
  },
  {
    key: "screenRecording",
    label: "Screen Recording",
    why: "take screenshots",
    pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    request: 'ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]); $.CGRequestScreenCaptureAccess();',
  },
] as const;

type Granted = Record<(typeof GRANTS)[number]["key"], boolean>;

/** The outermost `.app` among our ancestors: the app macOS holds responsible. A `ps` miss (or a
 *  chain with no app, e.g. over ssh) answers null and the output names no app. */
function launchingApp(): { name: string; path: string } | null {
  try {
    const rows = new Map<number, { ppid: number; comm: string }>();
    for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
    }
    let found: { name: string; path: string } | null = null;
    for (let pid = process.pid, hops = 0; pid > 1 && hops < 64; hops++) {
      const row = rows.get(pid);
      if (!row) break;
      const at = row.comm.indexOf(".app/");
      if (at >= 0) {
        const path = row.comm.slice(0, at + 4);
        found = { name: path.slice(path.lastIndexOf("/") + 1, -4), path };
      }
      pid = row.ppid;
    }
    return found;
  } catch {
    return null;
  }
}

async function probe(): Promise<Granted> {
  const helper = new AxHelperProcess({ captureLocal: true, timeoutMs: 180_000 });
  try {
    const r = await helper.request("capabilities") as Partial<Granted>;
    return { accessibility: r.accessibility === true, screenRecording: r.screenRecording === true };
  } finally {
    await helper.close();
  }
}

const jxa = (script: string) =>
  new Promise<void>((resolve) => execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: 10_000 }, () => resolve()));

export async function runSetupMacos(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { open: { type: "boolean", default: true }, json: { type: "boolean", default: false } },
    allowNegative: true,
  });
  if (process.platform !== "darwin") {
    console.error("setup macos: this machine is not a Mac");
    process.exit(1);
  }
  const app = launchingApp();
  let granted: Granted;
  try {
    granted = await probe();
  } catch (e) {
    console.error(`setup macos: could not start the macOS helper: ${(e as Error).message}`);
    process.exit(1);
  }
  const missing = GRANTS.filter((g) => !granted[g.key]);
  if (values.open) {
    for (const g of missing) {
      await jxa(g.request);
      execFile("open", [g.pane], () => {});
    }
  }
  if (values.json) {
    console.log(JSON.stringify({ app, ...granted, opened: values.open ? missing.map((g) => g.key) : [] }));
    process.exit(missing.length ? 1 : 0);
  }
  const who = app ? `${app.name} (${app.path})` : "the app that launched this command";
  console.log(`macOS grants these to ${who}, not to the helper:`);
  for (const g of GRANTS) {
    console.log(`  ${g.label.padEnd(16)}  ${granted[g.key] ? "granted" : `missing — needed to ${g.why}`}`);
  }
  const name = app?.name ?? "that app";
  if (missing.length) {
    const what = missing.length > 1 ? "them" : "it";
    console.log(values.open
      ? `\nOpened System Settings → Privacy & Security${missing.length > 1 ? " (one pane each)" : ""}: tick ${name} there, then run this again.`
      : `\nGrant ${what} in System Settings → Privacy & Security: tick ${name}, then run this again.`);
    if (!granted.screenRecording) console.log(`If Screen Recording still reads missing after ticking it, quit and reopen ${name}.`);
  }
  console.log(`An MCP client that is a different app from ${name} needs the same grants on its own row.`);
  process.exit(missing.length ? 1 : 0);
}
