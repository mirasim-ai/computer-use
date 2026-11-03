/**
 * What the debugging port says BEFORE playwright attaches.
 *
 * `chromium.connectOverCDP` initialises EVERY page target behind the port, and one renderer that
 * never answers (e.g. a detached DevTools window) hangs the whole connection until the timeout,
 * reported as "no Electron app is listening" while the port itself answers.
 *
 * So: read the port's own target list first, to tell a dead port from a live one with a stuck
 * target. And close an auxiliary target (DevTools, chrome://) whose renderer no longer answers —
 * this driver never lists it ({@link isAuxUrl}) and it blocks the window we drive. A DevTools
 * window that still answers is left alone: the operator may be using it.
 *
 * Raw HTTP plus one websocket per probe, never playwright: the point is to act before it attaches.
 */
import { WebSocket } from "ws";

export interface CdpTarget { id: string; type: string; url: string; webSocketDebuggerUrl?: string }

/** Page targets that are not the app: DevTools windows and Chromium's own pages. */
export const isAuxUrl = (url: string): boolean => /^(devtools|chrome|chrome-extension|chrome-devtools):/.test(url);

/**
 * The port's `/json/list`. `null` when nothing answers there — the port is closed;
 * `undefined` when the endpoint is not HTTP (a `ws://` URL has no `/json`; playwright alone
 * speaks it, so there is nothing to read and nothing to clear).
 */
export async function listTargets(cdpUrl: string, timeoutMs = 3000): Promise<CdpTarget[] | null | undefined> {
  if (!/^https?:/i.test(cdpUrl)) return undefined;
  try {
    const res = await fetch(new URL("/json/list", cdpUrl), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as CdpTarget[]) : null;
  } catch {
    return null;
  }
}

/**
 * Close every auxiliary page target whose renderer does not answer a trivial evaluate within
 * `probeMs`. Returns the urls closed — the caller names them when attaching still fails.
 */
export async function closeWedgedAuxTargets(cdpUrl: string, targets: CdpTarget[], probeMs = 2000): Promise<string[]> {
  const closed: string[] = [];
  for (const t of targets) {
    if (t.type !== "page" || !isAuxUrl(t.url) || !t.webSocketDebuggerUrl) continue;
    if (await answers(t.webSocketDebuggerUrl, probeMs)) continue;
    // Chromium's own close endpoint — what Target.closeTarget does, without a browser session.
    await fetch(new URL(`/json/close/${t.id}`, cdpUrl), { signal: AbortSignal.timeout(probeMs) }).catch(() => {});
    closed.push(t.url);
  }
  return closed;
}

/** One `Runtime.evaluate` over the target's own socket: true when any reply arrives in time. */
function answers(wsUrl: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const done = (ok: boolean): void => { clearTimeout(timer); ws.terminate(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1" } })));
    ws.on("message", () => done(true));
    ws.on("error", () => done(false));
  });
}
