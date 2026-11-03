/**
 * `mirasim-cu bridge-host --socket <path>` — the Chrome native-messaging host.
 *
 * **Chrome spawns this, not the program running the bridge** (via `chrome.runtime.connectNative` and the host
 * manifest's wrapper), over stdio. The socket paths are baked into the wrapper by the code that
 * wrote the manifest.
 *
 * Several programs can run a bridge on one machine and share the extension's one host name, so
 * the wrapper passes every recorded socket (`--socket` repeated, in priority order) and this
 * pipes into the FIRST that answers (`platform/browser/bridge/native-host.ts`).
 *
 * A PIPE, not a participant: it answers only the extension's `ping` itself, and only once the
 * socket is up, so a pong means the whole route is there.
 *
 * **No reconnect, deliberately.** No socket, or a dropped one, exits; Chrome respawns a host on
 * the next connect and the EXTENSION owns the retry loop (one process per port, Chrome's model).
 *
 * Diagnostics go to a FILE: Chrome owns this process's stderr and nobody sees it.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  BROWSER_TO_HOST_MAX,
  encodeFrame,
  FrameDecoder,
  HOST_TO_BROWSER_MAX,
} from "../../platform/browser/bridge/native-frames.ts";
import { emitUsage, wantsHelp } from "./help.ts";

function usage(asked: boolean): never {
  emitUsage(`Usage: mirasim-cu bridge-host --socket <path> [--socket <path> …]

Chrome's native-messaging host for the mirasim bridge extension. Chrome runs this;
running it by hand does nothing useful — it speaks the length-prefixed stdio protocol.

  --socket <path>   a bridge's local socket (absolute); repeated, the first that answers wins`, asked);
}

/** Next to the socket — one place to look for both halves. */
function logFile(sockPath: string): string {
  return path.join(path.dirname(sockPath), "bridge-host.log");
}

export async function runBridgeHostCommand(rest: string[]): Promise<void> {
  if (wantsHelp(rest)) usage(true);
  const { values } = parseArgs({
    args: rest,
    options: { socket: { type: "string", multiple: true } },
    // Chrome appends the caller's origin (and on Windows --parent-window=N); unused (the
    // manifest's allowed_origins gates who connects) but they must not fail the parse.
    allowPositionals: true,
    strict: false,
  });
  const sockPaths = (Array.isArray(values.socket) ? values.socket : [values.socket])
    .filter((p): p is string => typeof p === "string" && p !== "");
  if (!sockPaths.length) usage(false);

  // Logs go next to the socket in use; until one answers, next to the first.
  let sockPath = sockPaths[0]!;
  const log = (message: string): void => {
    try {
      fs.appendFileSync(logFile(sockPath), `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* a host that cannot log still has a job to do */
    }
  };

  let found: net.Socket | null = null;
  for (const candidate of sockPaths) {
    found = await new Promise<net.Socket | null>((resolve) => {
      const s = net.createConnection(candidate);
      s.once("connect", () => resolve(s));
      s.once("error", (e) => {
        log(`no bridge on ${candidate}: ${e.message}`);
        resolve(null);
      });
    });
    if (found) {
      sockPath = candidate;
      break;
    }
  }
  const socket = found;
  if (!socket) {
    // The extension reads this exit as "not connected" and backs off; it must NOT read it as
    // "host not installed", which is a different message and stops the retries for good.
    process.exitCode = 1;
    return;
  }
  log(`connected to ${sockPath}`);

  const toBridge = new FrameDecoder(BROWSER_TO_HOST_MAX);
  const toBrowser = new FrameDecoder(HOST_TO_BROWSER_MAX);
  const write = (text: string, max: number, sink: NodeJS.WritableStream): void => {
    try {
      sink.write(encodeFrame(text, max));
    } catch (e) {
      log(`frame rejected: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await new Promise<void>((resolve) => {
    const done = (why: string, code = 0): void => {
      log(why);
      process.exitCode = code;
      socket.destroy();
      resolve();
    };
    // Setting exitCode is NOT leaving: Chrome's stdin pipe keeps the process alive, and Chrome
    // tears the extension's port down only when the host EXITS — a lingering host leaves the
    // extension on a dead route with `onDisconnect` never firing. So teardown exits.
    const exit = (why: string, code = 0): void => {
      done(why, code);
      process.exit(code);
    };

    process.stdin.on("data", (chunk: Buffer) => {
      let frames: string[];
      try {
        frames = toBridge.push(chunk);
      } catch (e) {
        exit(`stdin: ${e instanceof Error ? e.message : String(e)}`, 1);
        return;
      }
      for (const frame of frames) {
        // The probe asks whether THIS ROUTE is alive; the socket already answered that.
        if (frame.includes('"ping"') && isPing(frame)) {
          write(JSON.stringify({ type: "pong" }), HOST_TO_BROWSER_MAX, process.stdout);
          continue;
        }
        socket.write(encodeFrame(frame, BROWSER_TO_HOST_MAX));
      }
    });
    // stdin closing means Chrome tore the port down (the extension disconnected, the worker
    // was evicted, or the browser quit) — nothing left to relay.
    process.stdin.on("end", () => exit("stdin closed"));
    process.stdin.on("error", (e) => exit(`stdin error: ${e.message}`, 1));

    socket.on("data", (chunk: Buffer) => {
      let frames: string[];
      try {
        frames = toBrowser.push(chunk);
      } catch (e) {
        exit(`socket: ${e instanceof Error ? e.message : String(e)}`, 1);
        return;
      }
      for (const frame of frames) write(frame, HOST_TO_BROWSER_MAX, process.stdout);
    });
    socket.on("close", () => exit("bridge closed the socket"));
    socket.on("error", (e) => exit(`socket error: ${e.message}`, 1));
  });
}

/** `{"type":"ping"}` and nothing else — a chrome.* command that merely contains the word is
 *  still the bridge's business. */
function isPing(frame: string): boolean {
  try {
    const message = JSON.parse(frame) as { type?: unknown };
    return message?.type === "ping";
  } catch {
    return false;
  }
}
