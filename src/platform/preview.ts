/**
 * The live preview a host can opt into (MCP extension `mirasim-computer-use/preview`, protocol in
 * docs/embedding.md): which surfaces the agent is working in, and video of the ones the host is
 * watching. Off unless the host asked at initialize; then nothing is captured until it watches,
 * and only what it watches.
 *
 * Targets are what the drivers report after each action (`ComputerUseDriver.publishPreview`); a
 * revoked macOS app leaves the list at once and is not re-added by a report from before the revoke.
 */
import { createPreviewStream } from "./registry.ts";
import type { PreviewFrame, PreviewSink, PreviewStream, PreviewTarget } from "./types.ts";

/** One entry of the `targets` notification. */
export interface PublishedTarget extends PreviewTarget {
  updatedAt: number;
  /** The host's `_meta` `mirasim-computer-use/previewTask` of the call that last touched it. */
  taskId: string | null;
}

/** Where the service's output goes: the MCP notifications, in mcp.ts. */
export interface PreviewOutput {
  targets(targets: PublishedTarget[]): void;
  frame(ref: TargetRef, frame: PreviewFrame): void;
  status(ref: TargetRef, status: { unavailable: string | null; icon?: string }): void;
}

export interface TargetRef { kind: PreviewTarget["kind"]; targetId: string }

const MAX_TARGETS = 16;
const TICK_MS = 250;
const keyOf = (t: TargetRef) => `${t.kind}:${t.targetId}`;

export class PreviewService {
  private readonly targets = new Map<string, PublishedTarget>();
  private readonly streams = new Map<string, PreviewStream>();
  private readonly revokedAt = new Map<string, number>();
  private taskTags: Array<{ at: number; id: string | null }> = [{ at: 0, id: null }];
  private watched = new Set<string>();
  private maxSize = 2560;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly out: PreviewOutput, private readonly env: NodeJS.ProcessEnv = process.env) {}

  setTaskId(id: string | null): void {
    if (this.taskTags[this.taskTags.length - 1]?.id === id) return;
    this.taskTags.push({ at: Date.now(), id });
    this.taskTags = this.taskTags.slice(-4);
  }

  publish(target: PreviewTarget, at: number): void {
    if (this.closed) return;
    if (target.capture.type === "macos" && at <= (this.revokedAt.get(target.capture.app) ?? -1)) return;
    const key = keyOf(target);
    const previous = this.targets.get(key);
    if (previous && previous.updatedAt > at) return;
    this.targets.delete(key);
    const taskId = [...this.taskTags].reverse().find((tag) => tag.at <= at)?.id ?? null;
    this.targets.set(key, { ...target, pointer: target.pointer ?? previous?.pointer, updatedAt: at, taskId });
    while (this.targets.size > MAX_TARGETS) this.drop(this.targets.keys().next().value!);
    this.schedule();
    this.sync();
  }

  revoke(apps: string[]): void {
    for (const app of apps) this.revokedAt.set(app, Date.now());
    for (const [key, target] of this.targets) {
      if (target.capture.type === "macos" && apps.includes(target.capture.app)) this.drop(key);
    }
    this.schedule();
  }

  /** The host's `watch` request: exactly these targets get video from now on; [] stops it all. */
  watch(refs: TargetRef[], maxSize?: number): void {
    if (typeof maxSize === "number" && maxSize >= 64) this.maxSize = Math.min(Math.round(maxSize), 4096);
    this.watched = new Set(refs.map(keyOf));
    this.sync();
  }

  /** Start video for watched targets, stop it for the rest; tick while any runs. */
  private sync(): void {
    if (this.closed) return;
    for (const [key, stream] of this.streams) {
      if (!this.watched.has(key) || !this.targets.has(key)) { stream.dispose(); this.streams.delete(key); }
    }
    for (const key of this.watched) {
      const target = this.targets.get(key);
      if (!target || this.streams.has(key)) continue;
      const ref: TargetRef = { kind: target.kind, targetId: target.targetId };
      const sink: PreviewSink = {
        frame: (frame) => { if (this.streams.get(key) === stream) this.out.frame(ref, frame); },
        status: (status) => { if (this.streams.get(key) === stream) this.out.status(ref, status); },
        gone: () => { if (this.streams.get(key) === stream) { this.drop(key); this.schedule(); } },
      };
      const stream: PreviewStream = createPreviewStream(target, sink, this.maxSize, this.env);
      this.streams.set(key, stream);
      void stream.tick().catch(() => {});
    }
    if (this.streams.size && !this.ticker) {
      this.ticker = setInterval(() => { for (const s of this.streams.values()) void s.tick().catch(() => {}); }, TICK_MS);
      this.ticker.unref();
    } else if (!this.streams.size && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private drop(key: string): void {
    this.targets.delete(key);
    this.streams.get(key)?.dispose();
    this.streams.delete(key);
  }

  /** Coalesce a burst of reports (pointer moves) into one `targets` notification. */
  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.out.targets([...this.targets.values()]);
    }, 20);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ticker) clearInterval(this.ticker);
    for (const stream of this.streams.values()) stream.dispose();
    this.streams.clear();
  }
}
