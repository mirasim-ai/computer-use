/**
 * The bridge to the user's own browser as a DEVICE, for a session that asked for it without naming
 * an endpoint (`COMPUTER_USE_BROWSER=extension`) — the same adopt-or-launch shape as the managed
 * Chrome (`../acquire.ts`).
 *
 * The bridge mints a random port and a one-time UUID every start, so a static MCP config can never
 * name it. A host like mirasim passes the endpoint down; a standalone session finds it itself:
 *
 *  1. `<home>/bridge.json` names a bridge that still answers → adopt it.
 *  2. Otherwise start `mirasim-cu bridge --native-host` DETACHED, so it outlives this session
 *     (the extension holds one connection, and the next session must find the same bridge), and
 *     record its endpoint there. `--native-host` writes the manifests, so nothing else is set up.
 *
 * A lock file keeps two sessions starting at once from standing up two bridges on one socket.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultBridgeSocket, recordedBridges } from "./native-host.ts";

interface BridgeState {
  cdpUrl: string;
  extensionId?: string;
  extensionIds?: string[];
  pid: number;
  socketPath?: string;
  /** When this process started it — a just-started bridge has not met the extension yet. */
  startedAt?: number;
}

/** How long a start may take before the session gives up (it loads the whole CLI). */
const START_TIMEOUT_MS = 30_000;
/** A lock older than this was left by a crashed starter. */
const LOCK_STALE_MS = 60_000;
/** How long a freshly started bridge waits for the extension before the session goes on. An
 *  extension that failed to reach a bridge backs off up to 30 s between tries, and the bridge's
 *  own handshake waits only 15 s — without this the first call after a start often fails. */
const FIRST_CONNECT_WAIT_MS = 35_000;

/** Where a bridge's endpoint is recorded: next to its socket. mirasim keeps the same file, so
 *  another owner's bridge is found by the same rule. */
function stateFile(dir: string): string {
  return path.join(dir, "bridge.json");
}

function readState(file: string): BridgeState | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as BridgeState;
    return typeof s.cdpUrl === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Is this bridge alive, and is the extension on its line? */
async function probe(cdpUrl: string): Promise<{ answering: boolean; connected: boolean }> {
  try {
    const res = await fetch(`${cdpUrl}/status`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return { answering: false, connected: false };
    const body = (await res.json()) as { extensionConnected?: boolean };
    return { answering: true, connected: body.extensionConnected === true };
  } catch {
    return { answering: false, connected: false };
  }
}

/** The endpoint of this home's bridge, started if none answers; `fresh` when this call started it
 *  (and already gave the extension its time to dial in). */
export async function acquireBridge(home: string): Promise<{ cdpUrl: string; fresh: boolean }> {
  const file = stateFile(home);
  const live = async (): Promise<string | null> => {
    const s = readState(file);
    return s && (await probe(s.cdpUrl)).answering ? s.cdpUrl : null;
  };
  const found = await live();
  if (found) return { cdpUrl: found, fresh: false };

  fs.mkdirSync(home, { recursive: true });
  const lock = path.join(home, "bridge.lock");
  if (!takeLock(lock)) {
    // Another session is starting it: wait for its record rather than racing it.
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline && fs.existsSync(lock)) {
      await new Promise((r) => setTimeout(r, 300));
      const theirs = await live();
      if (theirs) return { cdpUrl: theirs, fresh: false };
    }
    if (!takeLock(lock)) throw new Error(`another process is starting the browser bridge (${lock}) and has not finished`);
  }
  try {
    const raced = await live();
    if (raced) return { cdpUrl: raced, fresh: false };
    const state = await startBridge(home);
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    fs.rmSync(lock, { force: true }); // recorded: a session waiting on the lock can adopt it now
    await waitForExtension(state.cdpUrl, FIRST_CONNECT_WAIT_MS);
    return { cdpUrl: state.cdpUrl, fresh: true };
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Why this home's bridge has no extension, when another program's bridge has it: the extension
 * keeps one connection and the native host prefers the higher-priority record (mirasim's), so a
 * standalone session would otherwise read "install the extension" while it sits installed and
 * busy elsewhere. Returns that owner, or null.
 */
export async function extensionHeldElsewhere(home: string): Promise<string | null> {
  if (process.platform === "win32") return null; // a pipe name says nothing about where its record lives
  for (const { owner, socket } of recordedBridges()) {
    const dir = path.dirname(socket);
    if (path.resolve(dir) === path.resolve(home)) continue;
    const s = readState(stateFile(dir));
    if (s && (await probe(s.cdpUrl)).connected) return owner;
  }
  return null;
}

/** Wait up to `ms` for the extension to be on this bridge's line. The bridge's own handshake waits
 *  too, but then hangs the socket up without a word — asking first is what lets the session say
 *  WHY (see {@link extensionHeldElsewhere}). */
export async function waitForExtension(cdpUrl: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { answering, connected } = await probe(cdpUrl);
    if (connected || !answering) return connected || !answering; // a dead bridge is the endpoint error's job
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Did this home's bridge start within `ms`? The extension may still be on its way. */
export function bridgeJustStarted(home: string, ms: number): boolean {
  const s = readState(stateFile(home));
  return typeof s?.startedAt === "number" && Date.now() - s.startedAt < ms;
}

function takeLock(lock: string): boolean {
  try {
    fs.closeSync(fs.openSync(lock, "wx"));
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        fs.closeSync(fs.openSync(lock, "wx"));
        return true;
      }
    } catch { /* lost the race to whoever cleared it */ }
    return false;
  }
}

/**
 * Start `mirasim-cu bridge --json --native-host` detached, with this process's own runtime (so a
 * loader such as tsx comes along), and read its one status line. stdout is dropped after it; the
 * bridge's diagnostics go to `<home>/bridge.log`.
 */
async function startBridge(home: string): Promise<BridgeState> {
  const script = process.argv[1];
  if (!script) throw new Error("cannot start the browser bridge: this process was not started from the computer-use CLI");
  const env = { ...process.env, COMPUTER_USE_HOME: home };
  const log = fs.openSync(path.join(home, "bridge.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, script, "bridge", "--json", "--native-host"], {
    detached: true,
    stdio: ["ignore", "pipe", log],
    env,
  });
  fs.closeSync(log);
  try {
    const hello = await new Promise<Omit<BridgeState, "pid">>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("no status line")), START_TIMEOUT_MS);
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      });
      child.once("error", (e) => { clearTimeout(timer); reject(e); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`exited ${code}`)); });
    });
    return {
      cdpUrl: hello.cdpUrl,
      extensionId: hello.extensionId,
      extensionIds: hello.extensionIds,
      pid: child.pid ?? 0,
      socketPath: defaultBridgeSocket(env),
      startedAt: Date.now(),
    };
  } catch (e) {
    try { child.kill(); } catch { /* already gone */ }
    throw new Error(`the browser bridge did not start (${e instanceof Error ? e.message : String(e)}); see ${path.join(home, "bridge.log")}`);
  } finally {
    child.stdout?.destroy();
    child.unref();
  }
}
