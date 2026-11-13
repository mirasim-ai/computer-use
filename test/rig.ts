/**
 * The rigs the browser tests share: a Chromium that still loads an extension, a raw
 * CDP client against the REAL browser (to interrogate the bridge extension's service worker),
 * and a tiny page server — data: URLs abort under chrome.debugger navigation.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { MIRASIM_EXTENSION_ID } from "../src/platform/browser/bridge/extension-id.ts";
import { chromeBinary, spawnChrome, type ThrowawayChrome } from "./helpers.ts";

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

/**
 * A throwaway browser with the bridge extension loaded. Playwright's Chromium takes it on the
 * command line; with `COMPUTER_USE_TEST_BRANDED_CHROME=1` the installed Google Chrome is used
 * instead, which ignores that switch and is handed the extension over its debugging pipe
 * (`Extensions.loadUnpacked`). The branded one is how a suite meets what the Chrome people
 * actually run does: it is several versions ahead of Playwright's. Null: neither is available.
 */
export async function spawnChromeWithExtension(dir: string, extraArgs: string[] = []): Promise<ThrowawayChrome | null> {
  if (!process.env.COMPUTER_USE_TEST_BRANDED_CHROME) {
    const binary = findLoadableChromium();
    return binary ? await spawnChrome({ binary, extraArgs: [`--load-extension=${dir}`, ...extraArgs] }) : null;
  }
  const binary = chromeBinary();
  if (!existsSync(binary)) return null;
  const port: number = await new Promise((resolve) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); });
  });
  const profileDir = mkdtempSync(join(tmpdir(), "computer-use-chrome-"));
  const proc = spawn(binary, [
    "--remote-debugging-pipe", `--remote-debugging-port=${port}`, "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check",
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []), ...extraArgs, "--headless=new", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const reap = () => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } };
  process.on("exit", reap);
  const cleanup = () => {
    reap();
    process.removeListener("exit", reap);
    try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir */ }
  };
  // The pipe speaks CDP as NUL-terminated JSON; one command is all it is used for.
  const answer = new Promise<string>((resolve) => {
    let buffer = "";
    (proc.stdio[4] as NodeJS.ReadableStream).on("data", (d) => { buffer += String(d); const end = buffer.indexOf("\0"); if (end >= 0) resolve(buffer.slice(0, end)); });
    setTimeout(() => resolve(""), 15_000).unref();
  });
  (proc.stdio[3] as NodeJS.WritableStream).write(`${JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: dir } })}\0`);
  const loaded = await answer;
  const cdpUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 75; i++) {
    try { await fetch(`${cdpUrl}/json/version`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!/"result"/.test(loaded)) { cleanup(); throw new Error(`Chrome did not load the extension: ${loaded || "no answer"}`); }
  return { cdpUrl, pid: proc.pid!, profileDir, cleanup };
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
