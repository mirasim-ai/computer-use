/**
 * The extension's end of the line, as a transport-agnostic duplex carrying the SAME messages
 * either way (commands out, results and chrome.* events back):
 *
 *  - **ws** — the relay: the extension opens `ws://127.0.0.1:<port>/extension/<uuid>` from a
 *    connect page. One-shot (the uuid is per process), so it needs re-handing after a restart.
 *  - **native** — Chrome spawns `mirasim-cu bridge-host` (native messaging), which pumps
 *    the same JSON over this process's local socket. Nothing is handed over, so nothing expires.
 */
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import { BROWSER_TO_HOST_MAX, encodeFrame, FrameDecoder, HOST_TO_BROWSER_MAX } from "./native-frames.ts";

export interface ExtensionChannel {
  /** Which transport this line runs on — for logs and for the status a host reports. */
  readonly kind: "ws" | "native";
  readonly isOpen: boolean;
  send(text: string): void;
  close(reason: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
}

/** The relay transport: a WebSocket the extension opened. */
export function webSocketChannel(ws: WebSocket): ExtensionChannel {
  return {
    kind: "ws",
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    send: (text) => ws.send(text),
    close: (reason) => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, reason);
    },
    onMessage: (cb) => ws.on("message", (data) => cb(data.toString())),
    onClose: (cb) => {
      ws.on("close", cb);
      ws.on("error", cb);
    },
  };
}

/**
 * The native transport: the socket `mirasim-cu bridge-host` dialled. Framed like the
 * stdio leg it relays (`native-frames.ts`), so the shim is a pipe, never a parser. What the
 * bridge SENDS reaches Chrome as a host message (the 1 MB side); what it RECEIVES is 64 MiB.
 */
export function socketChannel(socket: Duplex, onError: (e: Error) => void): ExtensionChannel {
  const decoder = new FrameDecoder(BROWSER_TO_HOST_MAX);
  let open = true;
  const shut = (): void => {
    open = false;
  };
  socket.on("close", shut);
  socket.on("error", shut);
  return {
    kind: "native",
    get isOpen() {
      return open && socket.writable;
    },
    send: (text) => {
      try {
        socket.write(encodeFrame(text, HOST_TO_BROWSER_MAX));
      } catch (e) {
        // An oversized frame is a bug on our side, not a transport failure: report it and
        // leave the line up, the way a rejected command would.
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    },
    close: () => { open = false; socket.destroy(); },
    onMessage: (cb) => {
      socket.on("data", (chunk: Buffer) => {
        let frames: string[];
        try {
          frames = decoder.push(chunk);
        } catch (e) {
          // A desynchronised stream cannot be resynchronised by skipping bytes.
          onError(e instanceof Error ? e : new Error(String(e)));
          socket.destroy();
          return;
        }
        for (const frame of frames) cb(frame);
      });
    },
    onClose: (cb) => {
      socket.on("close", cb);
      socket.on("error", cb);
    },
  };
}
