/** Read-only video for one Chromium target, including the browser extension's flattened CDP. */
import WsClient from "ws";
import type { PreviewSink, PreviewStream, PreviewTarget } from "../types.ts";

// Preserve text detail when the observer is expanded on a Retina display.
const DEFAULT_MAX_SIZE = 2560;
/**
 * The frame pace: at most one screencast frame per this many ms leaves this process.
 *
 * Enforced at the SOURCE. Chromium keeps at most two screencast frames un-acknowledged and encodes
 * the next one only when an ack comes back, so acknowledging every frame on arrival had it
 * PNG-encode up to 30 frames a second, two in three of which were then dropped unseen. Acks go back
 * at this pace instead, so Chromium encodes only the frames that are shown; and the frame a burst
 * ends on is shown when its slot comes rather than discarded, so a page that stops changing is
 * never left on an older picture.
 */
const FRAME_INTERVAL_MS = 100;

async function httpJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? await response.json() as T : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

interface CdpTarget { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string }

export class CdpPreviewStream implements PreviewStream {
  private socket: WsClient | null = null;
  private nextId = 0;
  private sessionId: string | null = null;
  private attachId = -1;
  private metricsId = -1;
  private width = 0;
  private height = 0;
  private lastFrameAt = 0;
  private disposed = false;
  private connecting = false;
  private videoStarted = false;
  private videoStartedAt = 0;
  private sawScreencast = false;
  private screenshotId: number | null = null;
  private lastScreenshotAt = 0;
  private unavailableNow = false;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  /** The newest screencast frame not yet shown, and the acks still owed — see FRAME_INTERVAL_MS. */
  private pendingCast: { data: string; w: number; h: number } | null = null;
  private unacked: Array<number | string | undefined> = [];
  private castTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly target: PreviewTarget, private readonly sink: PreviewSink,
    private readonly maxSize = DEFAULT_MAX_SIZE) {}

  async tick(): Promise<void> {
    const capture = this.target.capture;
    if (this.disposed || this.connecting || capture.type !== "cdp") return;
    if (this.socket) {
      // Earlier extension bridges cannot forward events on explicit sessions. Poll only
      // this target's screenshot as a compatibility fallback; never auto-attach user tabs.
      if (this.videoStarted && !this.sawScreencast && Date.now() - this.videoStartedAt > 1500
        && Date.now() - this.lastScreenshotAt > 1000) this.capture();
      return;
    }
    const endpoint = capture.endpoint.replace(/\/$/, "");
    this.connecting = true;
    try {
      let socketUrl = endpoint;
      let direct = false;
      if (/^https?:/.test(endpoint)) {
        const list = await httpJson<CdpTarget[]>(`${endpoint}/json/list`);
        // Only a successful, valid target list can establish that a page was closed.
        // A timeout/HTTP error/malformed response says nothing about its existence.
        if (!Array.isArray(list) || list.some((t) => !t || typeof t.id !== "string"
          || typeof t.type !== "string" || typeof t.url !== "string")) {
          this.unavailable("Could not read the application targets. Reconnecting…");
          return;
        }
        if (this.disposed) return;
        // Never replace a vanished target with an unrelated user tab.
        const page = list.find((t) => t.id === capture.targetId && t.type === "page");
        if (!page) { this.dispose(); this.sink.gone(); return; }
        direct = !!page.webSocketDebuggerUrl;
        const version = direct ? null : await httpJson<{ webSocketDebuggerUrl?: string }>(`${endpoint}/json/version`);
        socketUrl = page.webSocketDebuggerUrl ?? version?.webSocketDebuggerUrl ?? "";
      }
      if (this.disposed) return;
      if (!socketUrl) { this.unavailable("The application video endpoint is unavailable. Reconnecting…"); return; }
      const socket = new WsClient(socketUrl);
      this.socket = socket;
      const connectingAt = Date.now();
      this.connectionTimer = setTimeout(() => {
        if (this.socket === socket && this.lastFrameAt < connectingAt) {
          this.unavailable("The application did not provide a frame. Reconnecting…");
          socket.close();
        }
      }, 6000);
      this.connectionTimer.unref();
      socket.on("open", () => {
        if (this.disposed || this.socket !== socket) return;
        if (direct) this.startVideo();
        else this.attachId = this.send("Target.attachToTarget", { targetId: capture.targetId, flatten: true }, false);
      });
      socket.on("message", (data) => { if (this.socket === socket) this.message(String(data)); });
      socket.on("error", () => {
        if (this.socket === socket) this.unavailable("The application video connection failed.");
      });
      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.unavailable("The video connection was interrupted. Reconnecting…");
        this.socket = null; this.sessionId = null; this.videoStarted = false;
        this.sawScreencast = false; this.screenshotId = null;
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.resetCast();
      });
    } catch {
      this.unavailable("The application video connection failed. Reconnecting…");
    } finally { this.connecting = false; }
  }

  private startVideo(): void {
    if (this.videoStarted) return;
    this.videoStarted = true;
    this.videoStartedAt = Date.now();
    // A socket/attachment is not a recovered picture: the warning clears only when this
    // connection actually supplies a frame.
    this.metricsId = this.send("Page.getLayoutMetrics", {});
    this.capture();
    // Electron guests can have a transparent canvas over their embedder's white background.
    // JPEG discards that alpha as black, hiding black text; keep it in every video frame.
    this.send("Page.startScreencast", { format: "png", maxWidth: this.maxSize, maxHeight: this.maxSize, everyNthFrame: 2 });
  }

  private message(raw: string): void {
    if (this.disposed) return;
    let msg: { id?: number; sessionId?: string; method?: string; error?: { message?: string };
      result?: { sessionId?: string; data?: string; cssVisualViewport?: { clientWidth?: number; clientHeight?: number } };
      params?: { data?: string; sessionId?: number | string; targetInfo?: { targetId?: string };
        metadata?: { deviceWidth?: number; deviceHeight?: number } } };
    try { msg = JSON.parse(raw) as typeof msg; } catch { return; }
    const capture = this.target.capture;
    if (msg.method === "Target.attachedToTarget" && capture.type === "cdp"
      && msg.params?.targetInfo?.targetId === capture.targetId && typeof msg.params.sessionId === "string") {
      this.sessionId = msg.params.sessionId;
      this.startVideo();
      return;
    }
    if (msg.id === this.attachId) {
      if (msg.error || !msg.result?.sessionId) { this.unavailable(msg.error?.message ?? "Could not attach to the selected tab."); return; }
      this.sessionId ??= msg.result.sessionId;
      this.startVideo();
      return;
    }
    if (this.sessionId && msg.sessionId !== this.sessionId) return;
    if (msg.id === this.screenshotId) {
      this.screenshotId = null;
      if (msg.error) { this.unavailable(msg.error.message ?? "The application could not provide a frame."); return; }
    }
    if (msg.id === this.metricsId) {
      this.width = msg.result?.cssVisualViewport?.clientWidth ?? 0;
      this.height = msg.result?.cssVisualViewport?.clientHeight ?? 0;
    }
    if (msg.method === "Page.screencastFrame" && msg.params?.data) {
      this.sawScreencast = true;
      this.pendingCast = { data: msg.params.data, w: msg.params.metadata?.deviceWidth ?? this.width,
        h: msg.params.metadata?.deviceHeight ?? this.height };
      this.unacked.push(msg.params.sessionId);
      this.scheduleCast();
    } else if (msg.result?.data) {
      // PNG dimensions describe the captured area even when it differs from layout metrics.
      // Keep the width in CSS pixels so the action pointer still uses the same coordinates.
      const header = Buffer.from(msg.result.data.slice(0, 32), "base64");
      if (header.length < 24) return;
      const pixelsWide = header.readUInt32BE(16), pixelsHigh = header.readUInt32BE(20);
      if (!pixelsWide || !pixelsHigh) return;
      const scale = this.width ? this.width / pixelsWide : 1;
      this.frame(msg.result.data, pixelsWide * scale, pixelsHigh * scale);
    }
  }

  /** Show the newest screencast frame and return one ack, no sooner than FRAME_INTERVAL_MS after the last frame. */
  private scheduleCast(): void {
    if (this.castTimer || this.disposed) return;
    const wait = Math.max(0, this.lastFrameAt + FRAME_INTERVAL_MS - Date.now());
    this.castTimer = setTimeout(() => {
      this.castTimer = null;
      if (this.disposed) return;
      const cast = this.pendingCast;
      this.pendingCast = null;
      if (cast) this.frame(cast.data, cast.w, cast.h);
      if (this.unacked.length) this.send("Page.screencastFrameAck", { sessionId: this.unacked.shift() });
      if (this.unacked.length) this.scheduleCast();
    }, wait);
    this.castTimer.unref();
  }
  private resetCast(): void {
    if (this.castTimer) clearTimeout(this.castTimer);
    this.castTimer = null;
    this.pendingCast = null;
    this.unacked = [];
  }
  private frame(data: string, width: number, height: number): void {
    this.lastFrameAt = Date.now();
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    if (this.unavailableNow) { this.unavailableNow = false; this.sink.status({ unavailable: null }); }
    this.sink.frame({ mimeType: "image/png", data, width, height, capturedAt: Date.now() });
  }
  private send(method: string, params: Record<string, unknown>, scoped = true): number {
    const id = ++this.nextId;
    try {
      this.socket?.send(JSON.stringify({ id, method, params, ...(scoped && this.sessionId ? { sessionId: this.sessionId } : {}) }));
    } catch { /* The next tick reconnects. */ }
    return id;
  }
  private unavailable(message: string): void {
    if (this.disposed) return;
    this.unavailableNow = true;
    this.sink.status({ unavailable: message });
  }
  private capture(): void {
    if (this.screenshotId !== null && Date.now() - this.lastScreenshotAt < 5000) return;
    this.lastScreenshotAt = Date.now();
    // Idle pages may never produce a compositor frame: keep their first frame lossless.
    this.screenshotId = this.send("Page.captureScreenshot", { format: "png" });
  }
  dispose(): void {
    this.disposed = true;
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.resetCast();
    if (this.socket) this.send("Page.stopScreencast", {});
    if (this.sessionId) this.send("Target.detachFromTarget", { sessionId: this.sessionId }, false);
    this.socket?.close();
    this.socket = null;
  }
}
