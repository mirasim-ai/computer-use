/** One host-owned ScreenCaptureKit process; this endpoint exposes no input or AX-key operations. */
import http from "node:http";
import net from "node:net";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { AxHelperProcess } from "../../platform/macos/ax-client.ts";
import { AxRequestError } from "../../platform/macos/ax-errors.ts";

type Params = Record<string, unknown>;
function object(value: unknown): Params {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Params;
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function rect(value: unknown): void {
  const r = object(value);
  if (![r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n))
    || !(r.width as number > 0) || !(r.height as number > 0)) throw new Error("Invalid capture rectangle.");
}
function target(value: unknown): Params {
  const p = object(value);
  if (!positive(p.pid) || p.pid > 0x7fff_ffff || !positive(p.window) || p.window > 0xffff_ffff)
    throw new Error("Capture requires a valid PID and window ID.");
  return p;
}
function captureParams(op: unknown, value: unknown): Params {
  if (op !== "shot" && op !== "shotscoped") throw new Error("Only window screenshots are available here.");
  const p = target(value);
  if (Object.keys(p).some((k) => !["pid", "window", "expectedFrame", "maxLongSide", "region", "mark"].includes(k)))
    throw new Error("Unsupported capture parameter; AX keys and input cannot cross this connection.");
  rect(p.expectedFrame);
  if (!positive(p.maxLongSide) || p.maxLongSide > 4096) throw new Error("Invalid capture size.");
  if (op === "shotscoped") rect(p.region);
  else if (p.region !== undefined) throw new Error("A full screenshot cannot carry a region.");
  if (p.mark !== undefined) {
    const mark = object(p.mark);
    if (![mark.x, mark.y].every((n) => typeof n === "number" && Number.isFinite(n)) || typeof mark.down !== "boolean")
      throw new Error("Invalid pointer annotation.");
  }
  return p;
}
function failure(error: unknown): object {
  return { ok: false, error: error instanceof AxRequestError
    ? { code: error.code, message: error.message, ...(error.capture ? { capture: error.capture } : {}) }
    : { code: "capture_service_error", message: error instanceof Error ? error.message : String(error) } };
}

export async function runCaptureServer(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Native capture is available only on macOS.");
  const socket = process.env.COMPUTER_USE_MACOS_CAPTURE_SOCKET, secret = process.env.COMPUTER_USE_MACOS_CAPTURE_TOKEN;
  if (!socket || !secret) throw new Error("Native capture must be started by its host.");
  const lease = process.env.COMPUTER_USE_MACOS_CAPTURE_LEASE;
  const expected = Buffer.from(`Bearer ${secret}`);
  const streams = new Map<string, http.ServerResponse>();
  let stopping = false, generation = 0, queued = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const helper = new AxHelperProcess({ captureLocal: true,
    onStart: async (worker) => {
      if (!lease) return;
      writeFileSync(`${lease}.pending`, JSON.stringify({ owner: process.pid, worker }), { mode: 0o600 });
      renameSync(`${lease}.pending`, lease);
    },
    env: { ...process.env, COMPUTER_USE_PREVIEW_WORKER: "1" }, onEvent: (event) => {
      if (typeof event.streamId !== "string") return;
      const stream = streams.get(event.streamId);
      if (stream && !stream.destroyed && stream.writableLength < 256 * 1024) stream.write(`${JSON.stringify(event)}\n`);
    } });
  helper.onReset = () => {
    generation++;
    const active = [...streams.values()]; streams.clear();
    for (const response of active) response.end(`${JSON.stringify({ event: "previewError",
      message: "The native capture worker stopped. Reopen the preview to reconnect." })}\n`);
  };
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    if (stopping || queued >= 16) return Promise.reject(new Error("Native capture is stopping or busy; retry after current captures finish."));
    queued++;
    const job = tail.then(() => {
      if (stopping) throw new Error("Native capture is stopping.");
      return fn();
    });
    tail = job.catch(() => {});
    return job.finally(() => { queued--; });
  };
  const json = (response: http.ServerResponse, status: number, value: object) => {
    if (!response.destroyed) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      const auth = Buffer.from(request.headers.authorization ?? "");
      if (request.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        request.resume(); json(response, 403, failure(new Error("Native capture authentication failed."))); return;
      }
      if (request.method !== "POST" || !["/capture", "/preview"].includes(request.url ?? "")) {
        request.resume(); json(response, 404, failure(new Error("Unknown native capture operation."))); return;
      }
      let bytes = "";
      for await (const chunk of request) {
        bytes += String(chunk);
        if (Buffer.byteLength(bytes) > 16_384) throw new Error("Native capture request is too large.");
      }
      const body = object(JSON.parse(bytes));
      if (request.url === "/capture") {
        const params = captureParams(body.op, body.params);
        const result = await enqueue(() => helper.request(body.op as string, params));
        json(response, 200, { ok: true, result });
      } else {
        const params = target(body);
        if (Object.keys(params).some((k) => k !== "pid" && k !== "window")) throw new Error("Unsupported preview parameter.");
        if (streams.size >= 8) throw new Error("Too many native previews are already active.");
        const id = randomUUID(), startedGeneration = generation;
        streams.set(id, response);
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.flushHeaders();
        response.once("close", () => {
          if (!streams.delete(id) || stopping || generation !== startedGeneration) return;
          void enqueue(() => generation === startedGeneration
            ? helper.request("previewstop", { streamId: id }) : Promise.resolve({})).catch(() => {});
        });
        try {
          const metadata = await enqueue(async () => {
            if (response.destroyed) return {};
            return helper.request("previewstart", { pid: params.pid, window: params.window, streamId: id, maxLongSide: 2560 });
          });
          if (!response.destroyed) response.write(`${JSON.stringify({ event: "previewReady", ...object(metadata) })}\n`);
        } catch (error) {
          if (!response.destroyed) response.end(`${JSON.stringify({ event: "previewError", ...object(failure(error)),
            message: error instanceof Error ? error.message : String(error) })}\n`);
        }
      }
    })().catch((error) => {
      if (response.headersSent) response.destroy(); else json(response, 400, failure(error));
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  // The parent owns a private directory. A replacement worker may remove its own stale socket.
  if (existsSync(socket)) {
    if (!lstatSync(socket).isSocket()) throw new Error("The native capture socket path is occupied by a non-socket file.");
    const alive = await new Promise<boolean>((resolve) => {
      const peer = net.createConnection(socket);
      peer.once("connect", () => { peer.destroy(); resolve(true); });
      peer.once("error", () => resolve(false));
      peer.setTimeout(500, () => { peer.destroy(); resolve(true); });
    });
    if (alive) throw new Error("A native capture service is already listening on this socket.");
    unlinkSync(socket);
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  chmodSync(socket, 0o600);
  await new Promise<void>((resolve) => {
    const stop = () => { if (!stopping) { stopping = true; resolve(); } };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    process.stdin.resume(); process.stdin.once("end", stop); process.stdin.once("error", stop);
  });
  process.stdin.pause();
  server.close(); server.closeAllConnections();
  await helper.close();
  if (lease && existsSync(lease)) {
    const record = JSON.parse(readFileSync(lease, "utf8")) as { owner?: number };
    if (record.owner === process.pid) unlinkSync(lease);
  }
  if (existsSync(socket)) unlinkSync(socket);
}
