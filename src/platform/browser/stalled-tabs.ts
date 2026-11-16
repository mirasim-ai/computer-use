/**
 * Which TABS of a browser have stopped answering, asked of the browser itself.
 *
 * Playwright's handshake (`connectOverCDP`) waits for every open page to answer its first
 * commands, and a page whose renderer is busy for good (a script that never returns) answers
 * none: measured on Chrome 157, the handshake then fails at ANY deadline (3 s, 10 s, 45 s) while
 * the browser and every other tab are fine. So a handshake that timed out says nothing about the
 * browser. This asks over a socket of its own: the browser endpoint first, then each page.
 *
 * Read-only apart from {@link closeTabs}: a page is attached, asked to evaluate `1`, and let go.
 */

import WebSocket from "ws";

export interface StalledTab {
  targetId: string;
  title: string;
  url: string;
}

/** How long the browser endpoint itself gets for each of its own answers. */
const BROWSER_ANSWER_MS = 1_500;

interface Reply { result?: any; error?: { message: string } }

/** One raw CDP socket to the browser endpoint; null when it cannot be opened in time. */
async function browserSocket(cdpUrl: string): Promise<{ send: (method: string, params?: object, sessionId?: string, ms?: number) => Promise<Reply | null>; close: () => void } | null> {
  let wsUrl: string;
  try {
    const res = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(BROWSER_ANSWER_MS) });
    const version = (await res.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
    // Never the extension bridge: a page asked there is a tab of the user's the bridge would
    // attach a debugger to, and it has its own answer for a tab that stops answering.
    if (version.Browser === "mirasim-bridge") return null;
    wsUrl = version.webSocketDebuggerUrl ?? "";
  } catch {
    return null;
  }
  if (!wsUrl) return null;
  const ws = new WebSocket(wsUrl);
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), BROWSER_ANSWER_MS);
    ws.once("open", () => { clearTimeout(timer); resolve(true); });
    ws.once("error", () => { clearTimeout(timer); resolve(false); });
  });
  if (!opened) { ws.terminate(); return null; }
  ws.on("error", () => {});
  let nextId = 0;
  const pending = new Map<number, (reply: Reply | null) => void>();
  ws.on("message", (data) => {
    let message: { id?: number } & Reply;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message.id === undefined) return;
    pending.get(message.id)?.(message);
  });
  return {
    /** The reply, or null when none came within `ms`. */
    send: (method, params = {}, sessionId, ms = BROWSER_ANSWER_MS) => new Promise((resolve) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); resolve(null); }, ms);
      pending.set(id, (reply) => { clearTimeout(timer); pending.delete(id); resolve(reply); });
      try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); pending.delete(id); resolve(null); }
    }),
    close: () => { try { ws.close(); } catch { /* already gone */ } },
  };
}

/**
 * The page targets that do not answer within `ms`, each asked at the same time. An empty list:
 * every tab answers. Null: the BROWSER did not answer, which is the frozen leftover the caller
 * replaces. DevTools windows are passed by, as the page count is (acquire.ts `hasPageTarget`).
 */
export async function unansweringTabs(cdpUrl: string, ms: number): Promise<StalledTab[] | null> {
  const socket = await browserSocket(cdpUrl);
  if (!socket) return null;
  try {
    const listed = await socket.send("Target.getTargets");
    const infos = listed?.result?.targetInfos as Array<{ targetId: string; type: string; title?: string; url?: string }> | undefined;
    if (!infos) return null;
    const pages = infos.filter((t) => t.type === "page" && !String(t.url ?? "").startsWith("devtools://"));
    const silent = await Promise.all(pages.map(async (t): Promise<StalledTab | null> => {
      const attached = await socket.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      const sessionId = attached?.result?.sessionId as string | undefined;
      // A tab that closed between the listing and the attach is not one that is stuck.
      if (!sessionId) return null;
      const answer = await socket.send("Runtime.evaluate", { expression: "1" }, sessionId, ms);
      void socket.send("Target.detachFromTarget", { sessionId });
      // An error is an answer too: the page is reachable, whatever it refused.
      return answer ? null : { targetId: t.targetId, title: t.title ?? "", url: t.url ?? "" };
    }));
    return silent.filter((t): t is StalledTab => t !== null);
  } finally {
    socket.close();
  }
}

/** Close these tabs and wait (briefly) until the browser no longer lists them. Closing is the
 *  browser's own doing, so it works on a tab whose page answers nothing. */
export async function closeTabs(cdpUrl: string, targetIds: string[]): Promise<void> {
  const socket = await browserSocket(cdpUrl);
  if (!socket) return;
  try {
    for (const targetId of targetIds) await socket.send("Target.closeTarget", { targetId });
    for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
      const listed = await socket.send("Target.getTargets");
      const left = (listed?.result?.targetInfos as Array<{ targetId: string }> | undefined) ?? [];
      if (!left.some((t) => targetIds.includes(t.targetId))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    socket.close();
  }
}
