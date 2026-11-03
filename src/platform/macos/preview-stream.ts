/**
 * Read-only video of one macOS window. Its own helper process (or the host's shared capture
 * worker, when there is one), never the helper that acts: a frame can never queue behind, or
 * ahead of, an action.
 */
import { AxHelperProcess } from "./ax-client.ts";
import { CaptureClient } from "./capture-client.ts";
import type { PreviewSink, PreviewStream, PreviewTarget } from "../types.ts";

/** A damaged event stays bounded while leaving room for a detailed 2560 px frame. */
const MAX_FRAME_CHARS = 16 * 1024 * 1024;

export class MacosPreviewStream implements PreviewStream {
  private disposed = false;
  private stop: (() => void) | null = null;

  constructor(private readonly target: PreviewTarget, private readonly sink: PreviewSink,
    private readonly maxSize: number, private readonly env: NodeJS.ProcessEnv = process.env) {}

  start(): void {
    const c = this.target.capture;
    if (this.stop || this.disposed || c.type !== "macos") return;
    const event = (e: Record<string, unknown>) => this.event(e);
    const shared = CaptureClient.fromEnv(this.env);
    if (shared) {
      const controller = new AbortController();
      this.stop = () => controller.abort();
      shared.preview(c.pid, c.windowId, event, controller.signal)
        .catch((error: Error) => { if (!controller.signal.aborted) this.unavailable(error.message); });
      return;
    }
    const helper = new AxHelperProcess({ env: { ...this.env, COMPUTER_USE_PREVIEW_WORKER: "1" }, captureLocal: true, onEvent: event });
    this.stop = () => { void helper.close(); };
    helper.request("previewstart", { pid: c.pid, window: c.windowId, maxLongSide: this.maxSize })
      .then((metadata) => this.event({ event: "previewReady", ...(metadata as Record<string, unknown>) }))
      .catch((error: Error) => this.unavailable(error.message));
  }

  private event(e: Record<string, unknown>): void {
    if (this.disposed) return;
    if (e.event === "previewError" || e.event === "previewUnavailable") {
      this.unavailable(typeof e.message === "string" ? e.message : "Application capture stopped.");
    } else if (e.event === "previewReady") {
      this.sink.status({ unavailable: null, ...(typeof e.icon === "string" ? { icon: e.icon } : {}) });
    } else if (e.event === "previewFrame" && typeof e.data === "string" && e.data.length < MAX_FRAME_CHARS
      && Number(e.w) > 0 && Number(e.h) > 0) {
      this.sink.frame({ mimeType: "image/jpeg", data: e.data, width: Number(e.w), height: Number(e.h),
        capturedAt: typeof e.capturedAt === "number" ? e.capturedAt : Date.now() });
    }
  }

  private unavailable(message: string): void {
    if (!this.disposed) this.sink.status({ unavailable: message });
  }

  async tick(): Promise<void> { this.start(); }

  dispose(): void {
    this.disposed = true;
    this.stop?.();
    this.stop = null;
  }
}
