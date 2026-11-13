/** Shared helper: spawn a throwaway Chrome (own profile + CDP port) and wait for the endpoint. */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where Chrome installs itself on each platform; `COMPUTER_USE_CHROME` names any other. */
const INSTALLED_CHROME: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  win32: [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
    .filter(Boolean).map((dir) => join(dir!, "Google", "Chrome", "Application", "chrome.exe")),
};
const CHROME = process.env.COMPUTER_USE_CHROME
  || (INSTALLED_CHROME[process.platform] ?? []).find((bin) => existsSync(bin))
  || "google-chrome";

/** The installed Chrome the suites spawn. */
export const chromeBinary = (): string => CHROME;

export interface ThrowawayChrome {
  cdpUrl: string;
  pid: number;
  /** The `--user-data-dir` it was given — what an attached-mode driver is pointed at. */
  profileDir: string;
  cleanup: () => void;
}

/** Ask the OS for a free ephemeral port. Fixed ports caused a real failure: a leftover
 * instance holding the port made a fresh spawn silently lose the bind — the new window
 * sat blank while CDP drove the old invisible instance. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function spawnChrome(
  opts: { headed?: boolean; binary?: string; extraArgs?: string[] } = {},
): Promise<ThrowawayChrome> {
  const port = await freePort();
  const cdpUrl = `http://127.0.0.1:${port}`;

  // The endpoint must NOT respond before we spawn — otherwise we'd attach to a stranger.
  try {
    await fetch(`${cdpUrl}/json/version`);
    throw new Error(`port ${port} unexpectedly in use`);
  } catch (e) {
    if ((e as Error).message.includes("unexpectedly in use")) throw e; // fetch succeeded → bail
    /* fetch failed = port free, proceed */
  }

  const profile = mkdtempSync(join(tmpdir(), "computer-use-chrome-"));
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    // Out of the OS keychain, as the managed browser is (acquire.ts): a throwaway Chrome started
    // where the login keychain is out of reach — a sandboxed agent shell — otherwise puts up the
    // system dialog "no keychain to store Chrome" on every launch of every suite.
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ...(opts.extraArgs ?? []),
  ];
  if (!opts.headed) args.push("--headless=new");
  args.push("about:blank");
  const proc: ChildProcess = spawn(opts.binary ?? CHROME, args, { stdio: "ignore" });

  // Never orphan the child: EPIPE (piped stdout closed early), Ctrl+C, or any crash
  // must still take Chrome down. This exact orphan drove a blank-window bug once.
  const reap = () => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } };
  process.on("exit", reap);
  process.on("SIGINT", () => { reap(); process.exit(130); });
  process.on("SIGTERM", () => { reap(); process.exit(143); });

  const deadline = Date.now() + 15000;
  for (;;) {
    try { await fetch(`${cdpUrl}/json/version`); break; }
    catch {
      if (proc.exitCode !== null) throw new Error(`chrome exited early (code ${proc.exitCode})`);
      if (Date.now() > deadline) { reap(); throw new Error("chrome CDP endpoint never came up"); }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return {
    cdpUrl,
    pid: proc.pid!,
    profileDir: profile,
    cleanup: () => {
      reap();
      process.removeListener("exit", reap);
      // Chrome may still be flushing the profile when killed; retry and never throw.
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir, OS will reap */ }
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
