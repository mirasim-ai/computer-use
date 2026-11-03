/**
 * The client half of the Windows UI Automation helper (`uia/`, Rust).
 *
 * ONE resident child per driver, JSON Lines both ways, requests matched by id — the same wire as
 * the macOS helper (`macos/ax-client.ts`). It has to be resident: the element keys a `tree` call
 * hands out are COM objects held by that process, so a per-call process would re-mint them.
 *
 * Wire: request `{id, op, ...params}` → `{id, ok:true, result}` or `{id, ok:false, error:{code,
 * message}}`. The op list is `uia/src/main.rs`.
 *
 * Where the binary comes from, in order: `COMPUTER_USE_WINDOWS_UIA_BIN` (an explicit prebuilt); else
 * `computer-use-uia-helper.exe` BESIDE the bundle, which is how a packaged build carries its native half;
 * else the prebuilt from this platform's optional npm package (`../platform-package.ts`); else a
 * dev build — `cargo build --release` of the sources next to this file, cached under
 * `<home>/windows-uia/<source hash>/`. A checkout has the sources and no binary, a bundle the
 * binary and no sources.
 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { computerUseHome } from "../home.ts";
import { platformPackageHelper } from "../platform-package.ts";

/** The seam a test stubs: the driver only ever calls these. */
export interface UiaTransport {
  /** Element keys died with the process; the driver must drop the refs that name them. */
  onReset?: () => void;
  request(op: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** A refusal from the helper, with its stable code (`stale_key`, `no_action`, `minimized`, …). */
export class UiaRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "UiaRequestError";
  }
}

export interface UiaHelperOptions {
  env?: NodeJS.ProcessEnv;
  /** A managed host records this executor before any request is dispatched to it. */
  onStart?: (pid: number) => Promise<void>;
  /** Each line the helper logs on stderr — this platform's diagnostics channel. */
  onLog?: (line: string) => void;
  /** Per-request ceiling; the helper bounds each UIA call itself (2 s connect, 8 s transaction). */
  timeoutMs?: number;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class UiaHelperProcess implements UiaTransport {
  onReset?: () => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<ChildProcessWithoutNullStreams> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = "";
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(private readonly opts: UiaHelperOptions = {}) {
    this.env = opts.env ?? process.env;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async request(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const child = await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A helper that stopped answering may still be posting input: stop it before anyone acts again.
        void this.close().then(() => reject(new UiaRequestError("timeout", `uia helper: '${op}' did not answer within ${this.timeoutMs} ms; helper stopped`)));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.fail("uia helper closed; any in-flight action's outcome is unknown — observe before acting again");
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((done) => {
      const t = setTimeout(() => child.kill(), 2000);
      child.once("exit", () => { clearTimeout(t); done(); });
      child.stdin.end();
    });
  }

  private start(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child) return Promise.resolve(this.child);
    this.starting ??= (async () => {
      const bin = await resolveUiaHelper(this.env);
      const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env: this.env, windowsHide: true });
      this.stderrTail = "";
      child.stdin.on("error", () => undefined); // EPIPE on a dead child is reported via 'exit'
      child.stderr.on("data", (chunk: Buffer) => {
        const s = chunk.toString();
        this.stderrTail = `${this.stderrTail}${s}`.slice(-2000);
        for (const line of s.split("\n")) {
          const clean = line.replace(/^computer-use-uia-helper:\s*/, "").trim();
          if (clean) this.opts.onLog?.(clean);
        }
      });
      createInterface({ input: child.stdout }).on("line", (line) => { if (this.child === child) this.onLine(line); });
      child.on("exit", (code) => {
        if (this.child === child) this.fail(`uia helper exited (${code ?? "?"})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`);
      });
      child.on("error", (e) => { if (this.child === child) this.fail(`uia helper could not start: ${e.message}`); });
      this.child = child;
      if (child.pid) await this.opts.onStart?.(child.pid);
      return child;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  private onLine(line: string): void {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    try { msg = JSON.parse(line); } catch { return; }
    const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result ?? {});
    else p.reject(new UiaRequestError(msg.error?.code ?? "uia_error", msg.error?.message ?? "uia helper error"));
  }

  private fail(message: string): void {
    this.child = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new UiaRequestError("helper_gone", message));
      this.pending.delete(id);
    }
    this.onReset?.();
  }
}

// ── Binary resolution ─────────────────────────────────────────────────────────

const BUNDLED_HELPER_NAME = "computer-use-uia-helper.exe";

/** The Cargo project beside this file; a bundled build has none. */
function sourceDir(): string | null {
  const dir = fileURLToPath(new URL("./uia/", import.meta.url));
  return existsSync(join(dir, "Cargo.toml")) ? dir : null;
}

function bundledHelper(): string | null {
  const bin = fileURLToPath(new URL(`./${BUNDLED_HELPER_NAME}`, import.meta.url));
  return existsSync(bin) ? bin : null;
}

/** sha256 over the manifest, lockfile and every `src/*.rs` — the dev build's cache key. */
function sourceHash(dir: string): string {
  const hash = createHash("sha256");
  for (const f of ["Cargo.toml", "Cargo.lock"]) if (existsSync(join(dir, f))) hash.update(readFileSync(join(dir, f)));
  const src = join(dir, "src");
  for (const f of readdirSync(src).filter((f) => f.endsWith(".rs")).sort()) hash.update(f).update(readFileSync(join(src, f)));
  return hash.digest("hex").slice(0, 16);
}

async function resolveUiaHelper(env: NodeJS.ProcessEnv): Promise<string> {
  const override = env.COMPUTER_USE_WINDOWS_UIA_BIN?.trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`COMPUTER_USE_WINDOWS_UIA_BIN points at ${override}, which does not exist`);
    return override;
  }
  if (process.platform !== "win32") throw new UiaRequestError("unsupported", "the windows driver needs Windows");
  const prebuilt = bundledHelper() ?? platformPackageHelper(BUNDLED_HELPER_NAME);
  if (prebuilt) return prebuilt;
  const dir = sourceDir();
  if (!dir) throw new Error(`windows uia helper: no prebuilt binary (COMPUTER_USE_WINDOWS_UIA_BIN, \`${BUNDLED_HELPER_NAME}\` beside the bundle, or the @mirasim/computer-use-${process.platform}-${process.arch} package) and no Rust sources beside the bundle — a packaged build must ship the helper`);
  const root = join(computerUseHome(), "windows-uia");
  const targetDir = join(root, sourceHash(dir));
  const out = join(targetDir, "release", BUNDLED_HELPER_NAME);
  if (existsSync(out)) return out;
  mkdirSync(targetDir, { recursive: true });
  // First use pays one cargo build per source revision (about a minute with a cold dependency
  // cache); the hash dir makes a stale binary impossible and a rebuild automatic after any edit.
  await new Promise<void>((resolve, reject) => {
    execFile(cargoBin(env), ["build", "--release", "--manifest-path", join(dir, "Cargo.toml"), "--target-dir", targetDir],
      { timeout: 600_000, env, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`windows uia helper: cargo build failed (is the Rust toolchain installed? winget install Rustlang.Rustup): ${String(stderr || err.message).slice(-800)}`));
        else resolve();
      });
  });
  pruneOldBuilds(root, targetDir);
  return out;
}

/** rustup installs to ~/.cargo/bin and adds it to PATH only for shells started afterwards. */
function cargoBin(env: NodeJS.ProcessEnv): string {
  const home = join(env.USERPROFILE ?? homedir(), ".cargo", "bin", "cargo.exe");
  return existsSync(home) ? home : "cargo";
}

/** Keep the newest few builds: one per source revision grows with every edit otherwise. */
function pruneOldBuilds(root: string, keep: string): void {
  try {
    const dirs = readdirSync(root).map((n) => join(root, n)).filter((p) => p !== keep && statSync(p).isDirectory())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const d of dirs.slice(3)) rmSync(d, { recursive: true, force: true });
  } catch {
    // A cache that could not be tidied is not a reason to fail a build that succeeded.
  }
}
