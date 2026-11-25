/**
 * Screencasts and screenshots on the tabs the bridge shares between clients.
 *
 * A SCREENSHOT NEEDS FRAMES. The agent's tabs sit in the BACKGROUND of the user's window
 * (`createTarget` opens them inactive, so the user's own tab is never taken), and Chrome does not
 * draw a background tab for a capture reliably: `Page.captureScreenshot` there either waits for a
 * frame that never comes (Playwright gives up after 10 s) or is answered with the frame drawn for
 * the PREVIOUS capture, at that capture's scale — on a 150% display a CSS-pixel shot came back as
 * the top-left two thirds of the page, enlarged by 1.5. While a screencast runs, Chrome keeps the
 * tab drawing, and captures come back at once and right. Measured on Chrome 157, Windows 11 at
 * 150%, a background tab through this bridge: Playwright `page.screenshot` 0 of 8 answered, 8 of 8
 * with a screencast running; raw captures timed out every other time, or came back at the scale of
 * the one before. A front tab needs none. (The managed browser gives every tab a window of its own
 * for the same reason: tabs.ts.) So a capture on a tab whose screencast nobody is running gets one
 * of the bridge's own around it: started, its first frame awaited, stopped after.
 *
 * ONE SCREENCAST PER TAB. Every client of a tab shares the ONE debugger session the extension
 * holds on it, so Chrome keeps one screencast per tab, not per client: a second start replaces the
 * first one's settings, and any stop ends it for all. So the bridge keeps the books. Chrome runs the
 * settings of the newest client that asked; a client's stop ends the screencast only when no other
 * client reads it and no capture needs it; frames go to the clients that asked for them — not to
 * every client of the tab, where Playwright acknowledged each one too and undid the pace a preview
 * sets with its own acknowledgements — and the bridge acknowledges the frames of its own screencast
 * itself, delivering them to nobody. Those are told apart by their size, not only by whether anyone
 * reads: a client's start can cross frames Chrome already made for the bridge's ({@link ownFrame}).
 */

import { base64ImageSize } from "../../image-size.ts";
import type { BridgeClient } from "./client.ts";

/** Sends one CDP command to a tab's root debugger session. */
export type TabCommand = (tabId: number, method: string, params?: unknown) => Promise<unknown>;

/** The commands {@link TabScreencasts.command} answers on a tab's root session. */
export const SCREENCAST_COMMANDS = new Set(["Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck", "Page.captureScreenshot"]);
/** The events that are one screencast's, routed by {@link TabScreencasts.readersOf}. */
const SCREENCAST_EVENTS = new Set(["Page.screencastFrame", "Page.screencastVisibilityChanged"]);

/** How long a capture waits for the first frame of the bridge's own screencast. Measured: 40–60 ms
 *  on a slow laptop. A tab that sends none in this time is captured anyway, as before. */
const FIRST_FRAME_MS = 1_000;
/** The bridge's own screencast exists only to keep the tab drawing: the smallest frames Chrome makes. */
const KEEP_DRAWING = { format: "jpeg", quality: 1, maxWidth: 64, maxHeight: 64, everyNthFrame: 1 };

/**
 * Whether a frame that came while `reader`'s settings run is the bridge's own after all. A capture
 * starts the bridge's screencast; a preview starting its own a moment later does not stop the frames
 * Chrome has already made for the bridge's from arriving, now with a reader to hand them to. Handed
 * on, a 64-px quality-1 frame was the preview's whole picture — blurred past reading, ghosted, and
 * kept until the page next changed, which an idle page does not. Told apart by size: a client is
 * sent frames that small only when it asked for them.
 */
function ownFrame(reader: Reader | undefined, params: unknown): boolean {
  const data = (params as { data?: unknown } | undefined)?.data;
  const size = typeof data === "string" ? base64ImageSize(data) : null;
  if (!size || size.width > KEEP_DRAWING.maxWidth || size.height > KEEP_DRAWING.maxHeight) return false;
  const asked = (reader?.params ?? {}) as { maxWidth?: unknown; maxHeight?: unknown };
  const wantsSmall = (max: unknown, keep: number) => typeof max === "number" && max <= keep;
  return !wantsSmall(asked.maxWidth, KEEP_DRAWING.maxWidth) && !wantsSmall(asked.maxHeight, KEEP_DRAWING.maxHeight);
}

/** A client session reading a tab's screencast, with the settings it started it with. */
interface Reader {
  client: BridgeClient;
  alias: string;
  params: unknown;
}

interface TabCast {
  /** Oldest first: Chrome runs the newest one's settings. */
  readers: Reader[];
  /** Captures in progress that need the tab drawing. */
  holds: number;
  /** Chrome's screencast on this tab is running, whoever started it. */
  running: boolean;
  /** A frame has come since it started: the tab is drawing. */
  drawing: boolean;
  frameWaiters: Array<() => void>;
}

export class TabScreencasts {
  private readonly tabs = new Map<number, TabCast>();

  constructor(private readonly send: TabCommand, private readonly log: (...args: unknown[]) => void = () => {}) {}

  private cast(tabId: number): TabCast {
    let cast = this.tabs.get(tabId);
    if (!cast) {
      cast = { readers: [], holds: 0, running: false, drawing: false, frameWaiters: [] };
      this.tabs.set(tabId, cast);
    }
    return cast;
  }

  /**
   * A {@link SCREENCAST_COMMANDS} command a client sent on `alias`, the root session of `tabId`.
   * `forward` sends it to the tab as it is.
   */
  async command(client: BridgeClient, alias: string, tabId: number, method: string, params: unknown,
    forward: () => Promise<unknown>): Promise<unknown> {
    const cast = this.cast(tabId);
    switch (method) {
      case "Page.startScreencast": {
        cast.readers = cast.readers.filter((r) => !(r.client === client && r.alias === alias));
        cast.readers.push({ client, alias, params });
        const result = await forward();
        if (!cast.running) cast.drawing = false;
        cast.running = true;
        return result;
      }
      case "Page.stopScreencast": {
        const newest = cast.readers.at(-1);
        cast.readers = cast.readers.filter((r) => !(r.client === client && r.alias === alias));
        await this.settle(tabId, cast, newest);
        return {};
      }
      case "Page.screencastFrameAck":
        // Only a reader was handed frames; anyone else's ack would let Chrome run ahead of the
        // reader's own pace.
        return cast.readers.some((r) => r.client === client && r.alias === alias) ? await forward() : {};
      case "Page.captureScreenshot":
        return await this.capture(tabId, cast, forward);
    }
    return await forward();
  }

  /** A capture, with the tab kept drawing for it when no client's screencast does. */
  private async capture(tabId: number, cast: TabCast, forward: () => Promise<unknown>): Promise<unknown> {
    if (cast.readers.length) return await forward();
    cast.holds += 1;
    try {
      if (!cast.running) {
        cast.running = true;
        cast.drawing = false;
        try {
          await this.send(tabId, "Page.startScreencast", KEEP_DRAWING);
        } catch (e) {
          cast.running = false;
          this.log("could not keep the tab drawing for a capture:", e);
        }
      }
      if (cast.running && !cast.drawing) await this.firstFrame(cast);
      return await forward();
    } finally {
      cast.holds -= 1;
      await this.settle(tabId, cast);
    }
  }

  private firstFrame(cast: TabCast): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, FIRST_FRAME_MS);
      timer.unref?.();
      function done() {
        clearTimeout(timer);
        cast.frameWaiters = cast.frameWaiters.filter((w) => w !== done);
        resolve();
      }
      cast.frameWaiters.push(done);
    });
  }

  /**
   * Bring Chrome's screencast in line with who still needs it: stopped when nobody reads it and
   * no capture holds it; restarted with the newest reader's settings when the reader whose
   * settings were running (`was`) has gone.
   */
  private async settle(tabId: number, cast: TabCast, was: Reader | undefined = undefined): Promise<void> {
    if (!cast.running) return;
    const newest = cast.readers.at(-1);
    try {
      if (!newest && !cast.holds) {
        cast.running = false;
        cast.drawing = false;
        await this.send(tabId, "Page.stopScreencast");
      } else if (newest && was && newest !== was) {
        await this.send(tabId, "Page.startScreencast", newest.params);
      }
    } catch (e) {
      this.log("screencast bookkeeping failed:", e);
    }
  }

  /**
   * Who gets a root-session event of `tabId`: null for any event that is not a screencast's (it
   * goes to every client of the tab as before). A screencast's goes to its readers alone; with
   * none, or when the frame is one of the bridge's own ({@link ownFrame}), it is acknowledged here
   * and delivered to nobody.
   */
  readersOf(tabId: number, method: string, params: unknown): Array<{ client: BridgeClient; alias: string }> | null {
    if (!SCREENCAST_EVENTS.has(method)) return null;
    const cast = this.tabs.get(tabId);
    if (method === "Page.screencastFrame" && cast) {
      cast.drawing = true;
      for (const waiter of [...cast.frameWaiters]) waiter();
    }
    if (cast?.readers.length && !(method === "Page.screencastFrame" && ownFrame(cast.readers.at(-1), params))) {
      return cast.readers.map(({ client, alias }) => ({ client, alias }));
    }
    const frame = (params as { sessionId?: number } | undefined)?.sessionId;
    if (method === "Page.screencastFrame" && frame !== undefined) {
      void this.send(tabId, "Page.screencastFrameAck", { sessionId: frame }).catch(() => {});
    }
    return [];
  }

  /** A client session is gone (detached, or the client left): it reads nothing any more. */
  forget(client: BridgeClient, alias?: string): void {
    for (const [tabId, cast] of this.tabs) {
      const newest = cast.readers.at(-1);
      const left = cast.readers.filter((r) => !(r.client === client && (alias === undefined || r.alias === alias)));
      if (left.length === cast.readers.length) continue;
      cast.readers = left;
      void this.settle(tabId, cast, newest);
    }
  }

  /** The debugger left the tab: whatever ran on it ended with it. */
  dropTab(tabId: number): void {
    const cast = this.tabs.get(tabId);
    if (!cast) return;
    this.tabs.delete(tabId);
    for (const waiter of [...cast.frameWaiters]) waiter();
  }
}
