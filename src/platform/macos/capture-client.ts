/** Authenticated, read-only connection to the host's persistent native capture worker. */
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import { AxRequestError, type AxErrorCode, type CaptureFailure } from "./ax-errors.ts";

interface Reply { ok: boolean; result?: unknown; error?: { code?: AxErrorCode; message?: string; capture?: CaptureFailure } }
const MAX_REPLY = 32 * 1024 * 1024;

export class CaptureClient {
  private readonly requests = new Set<http.ClientRequest>();

  abortRequests(): void {
    for (const request of this.requests) request.destroy(new Error("This capture client closed."));
  }

  constructor(private readonly socketPath: string, private readonly token: string) {}

  static fromEnv(env: NodeJS.ProcessEnv): CaptureClient | null {
    const socket = env.COMPUTER_USE_MACOS_CAPTURE_SOCKET, token = env.COMPUTER_USE_MACOS_CAPTURE_TOKEN;
    if (!socket && !token) return null;
    if (!socket || !token) throw new Error("The native capture connection is incomplete; restart this host.");
    return new CaptureClient(socket, token);
  }

  private async open(route: string, body: object, signal?: AbortSignal): Promise<http.IncomingMessage> {
    const bytes = JSON.stringify(body);
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        return await new Promise<http.IncomingMessage>((resolve, reject) => {
          const request = http.request({ socketPath: this.socketPath, path: route, method: "POST", signal,
            headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json",
              "content-length": Buffer.byteLength(bytes) } }, (response) => {
            request.setTimeout(0);
            resolve(response);
          });
          this.requests.add(request);
          request.once("close", () => this.requests.delete(request));
          request.setTimeout(30_000, () => request.destroy(new Error("Native capture did not answer within 30 seconds.")));
          request.on("error", reject);
          request.end(bytes);
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        // These failures occurred before a connection existed. Never replay a sent request.
        if (!["ENOENT", "ECONNREFUSED"].includes(code ?? "") || Date.now() >= deadline)
          throw new AxRequestError("capture_service_error", "The host's native capture service is unavailable. No alternate capture process was started.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  async request(op: "shot" | "shotscoped", params: Record<string, unknown>): Promise<unknown> {
    const response = await this.open("/capture", { op, params });
    let bytes = 0;
    const chunks: Buffer[] = [];
    response.setTimeout(30_000, () => response.destroy(new Error("Native capture response timed out.")));
    for await (const chunk of response) {
      const data = Buffer.from(chunk);
      bytes += data.length;
      if (bytes > MAX_REPLY) { response.destroy(); throw new Error("Native capture response exceeded its size limit."); }
      chunks.push(data);
    }
    const reply = JSON.parse(Buffer.concat(chunks).toString()) as Reply;
    if (!reply.ok) throw new AxRequestError(reply.error?.code ?? "capture_service_error",
      reply.error?.message ?? "Native capture failed.", undefined, undefined, undefined, reply.error?.capture);
    return reply.result;
  }

  async preview(pid: number, window: number, event: (value: Record<string, unknown>) => void,
    signal: AbortSignal): Promise<void> {
    const response = await this.open("/preview", { pid, window }, signal);
    const abort = () => response.destroy();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    try {
      for await (const chunk of response) {
        buffer += decoder.write(Buffer.from(chunk));
        if (buffer.length > MAX_REPLY) throw new Error("Native preview event exceeded its size limit.");
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line) event(JSON.parse(line) as Record<string, unknown>);
        }
      }
      if (!signal.aborted) throw new Error("Native capture connection closed; reopen the preview.");
    } finally { signal.removeEventListener("abort", abort); response.destroy(); }
  }
}
