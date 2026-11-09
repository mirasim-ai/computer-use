/**
 * The rigs the browser tests share: a Chromium that still loads an extension, a raw
 * CDP client against the REAL browser (to interrogate the bridge extension's service worker),
 * and a tiny page server — data: URLs abort under chrome.debugger navigation.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { MIRASIM_EXTENSION_ID } from "../src/platform/browser/bridge/extension-id.ts";

/** A Chromium-flavored binary that still honors --load-extension. Branded Chrome
 *  dropped the flag, so the test needs Playwright's Chrome for Testing. */
export function findLoadableChromium(): string | null {
  const explicit = process.env.COMPUTER_USE_TEST_CHROMIUM?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || join(homedir(), "Library", "Caches", "ms-playwright");
  try {
    const dirs = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const dir of dirs) {
      for (const arch of readdirSync(join(cache, dir))) {
        const bin = join(cache, dir, arch, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
        if (existsSync(bin)) return bin;
        const chromium2 = join(cache, dir, arch, "Chromium.app", "Contents", "MacOS", "Chromium");
        if (existsSync(chromium2)) return chromium2;
        // Linux (`chrome-linux/chrome`) and Windows (`chrome-win/chrome.exe`) keep a bare binary.
        for (const bare of ["chrome", "chrome.exe"]) if (existsSync(join(cache, dir, arch, bare))) return join(cache, dir, arch, bare);
      }
    }
  } catch {
    /* no cache */
  }
  return null;
}

/** Minimal raw CDP client against the REAL browser — used to interrogate the
 *  extension's service worker about actual tab-group state. */
export class RawCdp {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const cb = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) cb.reject(new Error(msg.error.message));
        else cb.resolve(msg.result);
      }
    });
  }
  static async connect(httpUrl: string): Promise<RawCdp> {
    const version = (await (await fetch(`${httpUrl}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new RawCdp(ws);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close(): void {
    this.ws.close();
  }
}

/** Evaluate an expression inside the bridge extension's service worker. */
export async function evalInExtension(cdp: RawCdp, expression: string): Promise<any> {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const sw = targetInfos.find(
    (t: { type: string; url: string }) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${MIRASIM_EXTENSION_ID}/`),
  );
  if (!sw) throw new Error("bridge extension service worker not found");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(`extension eval failed: ${JSON.stringify(exceptionDetails)}`);
  await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  return result?.value;
}

/**
 * The extension's access settings (extension/access.js), written where the panel writes them.
 * Retries while the service worker is still starting.
 */
export async function setAccess(cdp: RawCdp, settings: Record<string, unknown>): Promise<void> {
  const expression = `chrome.storage.sync.set({ "mirasim-access": ${JSON.stringify(settings)} }).then(() => true)`;
  for (let attempt = 0; ; attempt++) {
    try {
      await evalInExtension(cdp, expression);
      return;
    } catch (e) {
      if (attempt >= 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** data: URLs abort under chrome.debugger navigation, so pages come from here. */
export async function servePages(routes: Record<string, string>): Promise<{ url: (path: string) => string; close: () => void }> {
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    const body = routes[req.url ?? ""] ?? "<title>404</title>";
    res.writeHead(routes[req.url ?? ""] ? 200 : 404, { "Content-Type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as { port: number }).port;
  return { url: (path) => `http://127.0.0.1:${port}${path}`, close: () => srv.close() };
}
