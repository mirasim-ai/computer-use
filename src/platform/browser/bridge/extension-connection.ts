/**
 * Portions Copyright (c) Microsoft Corporation (Playwright), licensed under the Apache License,
 * Version 2.0; modified by MIRASIM, INC. See LICENSE and NOTICE.
 *
 * One extension's line into the bridge: the calls sent down it, their answers, and what happens
 * to a call the extension never answers. `server-core.ts` and `server.ts` decide WHICH extension
 * is connected; this is what talking to it means.
 */

import { ExtensionUnanswered } from "./client.ts";
import type { ExtensionChannel } from "./extension-channel.ts";
import { FrameTooLargeError } from "./native-frames.ts";

/** A chrome.* call the extension never answers becomes an ERROR after this, not a hang: an MV3
 *  service worker can be evicted mid-command, and playwright waits forever on an unanswered id. */
const EXTENSION_COMMAND_TIMEOUT_MS = 30_000;
/** A call still unanswered after this gets a log line — the ONLY record that a stall lives on the
 *  extension side. Most callers' own budgets are tighter than the bound above (`SHOT_TIMEOUT_MS`
 *  4s, `NAV_TIMEOUT_MS` 15s, clicks 4-8s) and give up first, so the warning must sit below the
 *  tightest of them. The bound itself does fire in the product: Chrome answers NOTHING on a tab
 *  whose navigation has not started loading, however long that takes. Reaching it does not by
 *  itself fail a tab's command: the tab is asked first (`ExtensionConnection.unanswered`). */
const SLOW_CALL_WARN_MS = 3_000;
/** How long the extension gets to answer a ping once a command went unanswered. It answers from
 *  its own worker in milliseconds, whatever a tab is doing; silence here means the line is dead. */
const LINE_PROBE_MS = 5_000;
/** How long a TAB gets to answer a trivial question once one of its commands went unanswered. A
 *  page answers in milliseconds unless its renderer is busy or Chrome is holding its commands back. */
const TAB_PROBE_MS = 5_000;
/** How many times {@link EXTENSION_COMMAND_TIMEOUT_MS} one command may take on a tab that still
 *  answers, before it fails by itself. A caller's own budget can be longer than the bound (`run_js`
 *  waits up to 45 s), and an answer the extension lost must still end in an error. */
const SLOW_COMMAND_ROUNDS = 3;

/** An error the extension ANSWERED a command with, as opposed to one made up on this side. */
class ExtensionRefusal extends Error {}

/** Id/callback bookkeeping over the extension's line, whichever transport carries it
 *  ({@link ExtensionChannel}: the ws relay, or the native-messaging socket). */
export class ExtensionConnection {
  private readonly callbacks = new Map<number, {
    resolve: (v: unknown) => void; reject: (e: Error) => void; tabId?: number;
    /** How many timeouts this command is into, and how it starts the next one. */
    rounds: number; wait: () => void;
  }>();
  /** The probe in flight for a tab, so commands that time out together ask it once. */
  private readonly tabProbes = new Map<number, Promise<boolean>>();
  private lastId = 0;
  private probing = false;
  /** What the extension sent and this side has not handled yet, in the order it arrived. */
  private readonly inbox: string[] = [];
  private handling = false;
  /** Pending from the moment an answer is handed to its caller until that caller has run. */
  private answersLanding: Promise<void> | null = null;
  onEvent: ((method: string, params: unknown[]) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(
    private readonly channel: ExtensionChannel,
    protected readonly log: (...args: unknown[]) => void,
    protected readonly warn: (...args: unknown[]) => void,
    private readonly commandTimeoutMs = EXTENSION_COMMAND_TIMEOUT_MS,
  ) {
    channel.onMessage((text) => this.onMessage(text));
    channel.onClose(() => this.dispose());
  }

  get pendingCount(): number { return this.callbacks.size; }

  get isOpen(): boolean { return this.channel.isOpen; }

  send(method: string, params: unknown[]): Promise<unknown> {
    if (!this.channel.isOpen) return Promise.reject(new Error("Extension connection closed"));
    const id = ++this.lastId;
    const started = Date.now();
    const tabId = debuggeeTab(method, params);
    return new Promise((resolve, reject) => {
      // Keepalive pings are excluded on purpose: one every 20s, and a busy service
      // worker delaying one is normal — warning on those buries the signal.
      const warn = method === "bridge.ping" ? null : setTimeout(() => {
        // Read-only: deleting the entry is what decides the timeout below.
        if (this.callbacks.has(id)) this.warn(`slow: ${callLabel(method, params)} pending ${SLOW_CALL_WARN_MS}ms`);
      }, SLOW_CALL_WARN_MS);
      warn?.unref?.();
      let timer: NodeJS.Timeout | undefined;
      const wait = () => {
        timer = setTimeout(() => void this.unanswered(id, method, params), this.commandTimeoutMs);
        timer.unref?.();
      };
      wait();
      const settled = () => { this.callbacks.delete(id); clearTimeout(timer); if (warn) clearTimeout(warn); };
      this.callbacks.set(id, {
        rounds: 1, wait,
        ...(tabId === undefined ? {} : { tabId }),
        resolve: (v) => {
          settled();
          // Only the calls that warned report their total, so a healthy run stays silent.
          const ms = Date.now() - started;
          if (ms >= SLOW_CALL_WARN_MS && method !== "bridge.ping") this.warn(`${callLabel(method, params)} answered after ${ms}ms`);
          resolve(v);
        },
        reject: (e) => { settled(); reject(e); },
      });
      try { this.channel.send(JSON.stringify({ id, method, params })); }
      catch (e) {
        const callback = this.callbacks.get(id)!;
        if (e instanceof FrameTooLargeError) {
          // Nothing was written, so the line is as good as before: only this command fails.
          this.warn(`not sent: ${callLabel(method, params)} is ${e.bytes} bytes, over the ${e.max} Chrome takes in one message`);
          callback.reject(new Error(`${callLabel(method, params)} was not sent: at ${e.bytes} bytes it is over the ${e.max} bytes `
            + "Chrome accepts in one message to an extension. Pass less in one call (a long text or script in several parts)."));
          return;
        }
        callback.reject(e instanceof Error ? e : new Error(String(e)));
        this.close('Extension transport failed');
      }
    });
  }

  /**
   * A command went a whole timeout unanswered. For a tab's command the question is whether the
   * TAB stopped answering or only this command is slow: a script its caller gave 45 s, a
   * navigation to a server that takes its time. So the tab is asked something trivial. One that
   * answers is fine: the command waits on ({@link SLOW_COMMAND_ROUNDS} timeouts at most, then it
   * fails by itself) and nothing else on the tab is touched. One that does not is the tab the
   * model lets go of (`model-core.ts` `tabUnanswered`), and everything waiting on it fails with it.
   */
  private async unanswered(id: number, method: string, params: unknown[]): Promise<void> {
    const callback = this.callbacks.get(id);
    if (!callback) return;
    const { tabId } = callback;
    if (tabId !== undefined && await this.tabAnswers(tabId)) {
      // Answered, or failed with its line, while the tab was being asked: nothing left to decide.
      if (this.callbacks.get(id) !== callback) return;
      const waited = Math.round(this.commandTimeoutMs * callback.rounds / 1000);
      if (callback.rounds < SLOW_COMMAND_ROUNDS) {
        callback.rounds += 1;
        this.warn(`slow: ${callLabel(method, params)} pending ${waited}s on a tab that still answers; waiting on`);
        callback.wait();
        return;
      }
      callback.reject(new Error(`${callLabel(method, params)} was not answered in ${waited}s. Its tab still answers, `
        + "so only this command failed and the tab is kept."));
      return;
    }
    if (this.callbacks.get(id) !== callback) return;
    const cdpMethod = tabId !== undefined && typeof params[1] === "string" ? params[1] : undefined;
    const ms = this.commandTimeoutMs * callback.rounds;
    const unanswered = new ExtensionUnanswered(`Extension did not answer ${callLabel(method, params)} within ${ms}ms`, ms, tabId, cdpMethod);
    // Never replay a command: a timed-out input may already have reached its tab.
    callback.reject(unanswered);
    // Whatever else waits on that tab waits on the same thing: fail it now, not one timeout each.
    if (tabId !== undefined) for (const other of [...this.callbacks.values()]) if (other.tabId === tabId) other.reject(unanswered);
    void this.closeUnlessAnswering(method);
  }

  /**
   * Does this tab answer the debugger right now? Asked with an expression that touches nothing.
   * An error the extension answers with is an answer too (the tab is reachable, whatever it
   * refused); silence, or a line that dropped meanwhile, is not. One probe per tab at a time.
   */
  private tabAnswers(tabId: number): Promise<boolean> {
    let probe = this.tabProbes.get(tabId);
    if (!probe) {
      probe = new Promise<boolean>((resolve) => {
        if (!this.channel.isOpen) { resolve(false); return; }
        const id = ++this.lastId;
        const done = (answered: boolean) => { this.callbacks.delete(id); clearTimeout(timer); resolve(answered); };
        const timer = setTimeout(() => done(false), Math.min(TAB_PROBE_MS, Math.round(this.commandTimeoutMs / 4)));
        timer.unref?.();
        this.callbacks.set(id, { rounds: 1, wait: () => {}, resolve: () => done(true), reject: (e) => done(e instanceof ExtensionRefusal) });
        try {
          this.channel.send(JSON.stringify({ id, method: "chrome.debugger.sendCommand", params: [{ tabId }, "Runtime.evaluate", { expression: "1" }] }));
        } catch {
          done(false);
        }
      }).finally(() => { this.tabProbes.delete(tabId); });
      this.tabProbes.set(tabId, probe);
    }
    return probe;
  }

  /**
   * One unanswered command is not a dead line: a tab whose navigation never starts loading
   * answers nothing while the extension itself is fine, and dropping the line for it took every
   * other tab and every other session down with it (and the next line stalled on the same tab).
   * So ask the extension itself. Only its silence closes this transport, so native messaging
   * reconnects and releases stale debugger sessions.
   */
  private async closeUnlessAnswering(method: string): Promise<void> {
    if (method === "bridge.ping") { this.close('Extension command timed out'); return; }
    if (this.probing || !this.channel.isOpen) return;
    this.probing = true;
    try {
      if (!(await this.answersWithin(LINE_PROBE_MS))) this.close('Extension command timed out');
    } finally {
      this.probing = false;
    }
  }

  /** Does the line answer a ping in time? A closed or silent one does not. */
  async answersWithin(ms: number): Promise<boolean> {
    if (!this.channel.isOpen) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); });
    try {
      return await Promise.race([this.send("bridge.ping", []).then(() => true, () => false), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  close(reason: string): void {
    try { this.channel.close(reason); }
    finally { this.dispose(); }
  }

  /**
   * Answers and events leave here in the order the extension sent them.
   *
   * An answer reaches its caller through a promise, so the caller runs only after this function
   * returns; an event is handed over at once. Several messages often arrive in one read, and then
   * an event that came AFTER an answer was passed on before it. A CDP client relies on the order:
   * Playwright starts listening for a page's lifecycle events when `Page.getFrameTree` is
   * answered, so a `load` that overtook that answer was never seen, and waiting for the page to
   * load timed out on a page that had loaded (a popup that finished loading as it was attached,
   * about one time in three on a busy machine).
   *
   * So an event that follows an answer waits until that answer's caller has run: the callers'
   * continuations are microtasks, and all of them are done by the next `setImmediate`.
   */
  private onMessage(text: string): void {
    this.inbox.push(text);
    if (!this.handling) void this.handleInbox();
  }

  private async handleInbox(): Promise<void> {
    this.handling = true;
    try {
      while (this.inbox.length > 0) {
        const text = this.inbox.shift()!;
        let message: { id?: number; method?: string; params?: unknown[]; result?: unknown; error?: string };
        try {
          message = JSON.parse(text);
        } catch (e) {
          this.log("malformed extension message:", e);
          continue;
        }
        if (message.id !== undefined && this.callbacks.has(message.id)) {
          const callback = this.callbacks.get(message.id)!;
          if (message.error !== undefined) callback.reject(new ExtensionRefusal(message.error));
          else callback.resolve(message.result);
          this.answersLanding ??= new Promise((landed) => setImmediate(() => { this.answersLanding = null; landed(); }));
          continue;
        }
        if (!message.method) continue;
        if (this.answersLanding) await this.answersLanding;
        try { this.onEvent?.(message.method, message.params ?? []); }
        catch (e) { this.warn(`handling ${message.method} from the extension failed:`, e); }
      }
    } finally {
      this.handling = false;
    }
  }

  private dispose(): void {
    for (const callback of [...this.callbacks.values()]) callback.reject(new Error("Extension connection closed"));
    this.callbacks.clear();
    this.onClose?.();
    this.onClose = null;
  }
}

/** The tab a `chrome.debugger.sendCommand` is for; undefined for every other call. */
function debuggeeTab(method: string, params: unknown[]): number | undefined {
  if (method !== "chrome.debugger.sendCommand") return undefined;
  const tabId = (params[0] as { tabId?: unknown } | undefined)?.tabId;
  return typeof tabId === "number" ? tabId : undefined;
}

/** What a `chrome.*` call is doing, for one log line. Nearly every call is
 *  `chrome.debugger.sendCommand`, so the CDP method and debuggee in `params`
 *  (`[{ tabId, sessionId? }, method, params?]`) are what tell two calls apart. Slow path only. */
function callLabel(method: string, params: unknown[]): string {
  if (method !== "chrome.debugger.sendCommand") return method;
  const debuggee = params[0] as { tabId?: number; sessionId?: string } | undefined;
  const cdpMethod = typeof params[1] === "string" ? params[1] : method;
  const where = [
    debuggee?.tabId === undefined ? null : `tab=${debuggee.tabId}`,
    debuggee?.sessionId ? `session=${debuggee.sessionId}` : null,
  ].filter(Boolean);
  return where.length ? `${cdpMethod} ${where.join(" ")}` : cdpMethod;
}
