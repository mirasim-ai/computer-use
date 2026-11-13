/**
 * The bridge's line to the extension when a call goes unanswered — `node scripts/test.mjs extension-line`.
 *
 * Hermetic: a fake extension on an in-memory channel. No browser.
 *
 *   · a call to a page that stopped answering (a renderer busy or frozen) fails on its own, and
 *     the line stays up while the extension still answers a ping: every other tab and session
 *     keeps the browser;
 *   · an extension that answers nothing at all, the ping included, is dropped, so native
 *     messaging reconnects.
 */

import { ExtensionConnection } from "../src/platform/browser/bridge/server-core.ts";
import type { ExtensionChannel } from "../src/platform/browser/bridge/extension-channel.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake extension: answers every call at once, except the ones `stuck` picks, which it never
 *  answers. `deaf` makes it answer nothing at all. */
function fakeExtension(stuck: (method: string, params: unknown[]) => boolean) {
  let open = true;
  let deaf = false;
  let onMessage: (text: string) => void = () => {};
  const onClose: Array<() => void> = [];
  const channel: ExtensionChannel = {
    kind: "native",
    get isOpen() { return open; },
    send(text) {
      const { id, method, params } = JSON.parse(text) as { id: number; method: string; params: unknown[] };
      if (deaf || stuck(method, params)) return;
      queueMicrotask(() => onMessage(JSON.stringify({ id, result: {} })));
    },
    close() {
      if (!open) return;
      open = false;
      for (const cb of onClose) cb();
    },
    onMessage(cb) { onMessage = cb; },
    onClose(cb) { onClose.push(cb); },
  };
  return { channel, goDeaf: () => { deaf = true; } };
}

async function main() {
  // The bridge unrefs its timers (they must not keep a host alive); this suite waits on them.
  const hold = setInterval(() => {}, 1_000);
  const timing = { commandMs: 300, probeMs: 200 };
  const warned: string[] = [];
  const quiet = () => {};

  // ── One page stops answering: its call fails, the line stays ─────────
  {
    const ext = fakeExtension((method, params) => method === "chrome.debugger.sendCommand" && (params[0] as { tabId?: number })?.tabId === 7);
    const line = new ExtensionConnection(ext.channel, quiet, (...a) => warned.push(a.join(" ")), timing);
    let closed = false;
    line.onClose = () => { closed = true; };
    const stuck = line.send("chrome.debugger.sendCommand", [{ tabId: 7 }, "Page.enable"]).then(() => "answered", (e: Error) => e.message);
    const verdict = await stuck;
    check("a call to the page that stopped answering fails on its own",
      /^Extension did not answer Page\.enable tab=7 within 300ms$/.test(verdict), verdict);
    await sleep(timing.probeMs + 100);
    check("...and the line stays up while the extension answers a ping", !closed && line.isOpen,
      `closed=${closed} open=${line.isOpen}`);
    const other = await line.send("chrome.debugger.sendCommand", [{ tabId: 8 }, "Runtime.evaluate"]).then(() => "answered", (e: Error) => e.message);
    check("...so another tab is still reached through it", other === "answered", other);
    check("...and the bridge log says which call timed out and that the line was kept",
      warned.some((l) => l.includes("Page.enable tab=7")) && warned.some((l) => /keeping the line/.test(l)), warned.join(" | "));
    line.close("done");
  }

  // ── Several calls to that page time out together (a driver attaching it) ──
  {
    let pings = 0;
    const ext = fakeExtension((method, params) => {
      if (method === "bridge.ping") pings++;
      return method === "chrome.debugger.sendCommand" && (params[0] as { tabId?: number })?.tabId === 7;
    });
    const line = new ExtensionConnection(ext.channel, quiet, quiet, timing);
    await Promise.allSettled(["Page.enable", "Page.getFrameTree", "Runtime.enable"]
      .map((m) => line.send("chrome.debugger.sendCommand", [{ tabId: 7 }, m])));
    await sleep(timing.probeMs + 100);
    check("several calls to that page timing out together leave the line up", line.isOpen, `${pings} ping(s)`);
    line.close("done");
  }

  // ── The extension answers nothing at all: the line goes ─────────────
  {
    const ext = fakeExtension(() => false);
    const line = new ExtensionConnection(ext.channel, quiet, quiet, timing);
    let closed = false;
    line.onClose = () => { closed = true; };
    ext.goDeaf();
    const verdict = await line.send("chrome.debugger.sendCommand", [{ tabId: 7 }, "Page.enable"]).then(() => "answered", (e: Error) => e.message);
    check("with an extension that answers nothing, the call still fails", /did not answer/.test(verdict), verdict);
    await sleep(timing.probeMs + 100);
    check("...and the line is dropped when the ping goes unanswered too, so native messaging reconnects",
      closed && !line.isOpen, `closed=${closed} open=${line.isOpen}`);
  }

  // ── A keepalive ping that times out is a dead line by itself ─────────
  {
    const ext = fakeExtension(() => false);
    const line = new ExtensionConnection(ext.channel, quiet, quiet, timing);
    let closed = false;
    line.onClose = () => { closed = true; };
    ext.goDeaf();
    await line.send("bridge.ping", []).catch(() => {});
    check("an unanswered keepalive ping drops the line at once", closed && !line.isOpen);
  }

  clearInterval(hold);
  console.log(failures ? `\n${failures} check(s) failed` : "\nall extension-line checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
