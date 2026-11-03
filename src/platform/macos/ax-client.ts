/**
 * The client half of the macOS accessibility helper (`ax/*.swift`).
 *
 * ONE resident child per driver, JSON Lines both ways, requests matched by id. Spawned lazily (a
 * driver does no I/O until a primitive is called) and long-lived: `AXUIElement` handles have no
 * identity outside the process that copied them, so a `tree` call's element keys are valid only
 * while THAT process lives. A per-call process would re-mint every key between calls.
 *
 * Wire: request `{id, op, ...params}` → response `{id, ok:true, result}` or
 * `{id, ok:false, error:{code, message, ax?}}`. The op list and shapes are in `ax/main.swift`;
 * {@link AxRequestError} carries the code so the driver can word `not_trusted` and `stale_key`
 * honestly instead of as a generic failure.
 *
 * Where the binary comes from, in order: `COMPUTER_USE_MACOS_AX_BIN` (explicit override); else
 * `computer-use-ax-helper` BESIDE the bundle (a packaged build); else the prebuilt from this
 * platform's optional npm package (`../platform-package.ts`); else a dev build: the `.swift`
 * sources next to this file compiled once with `swiftc` and cached under
 * `<home>/macos-ax/<source hash>/`. A build that has neither fails saying exactly that.
 */

import { spawn as nodeSpawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { CaptureClient } from "./capture-client.ts";
import { AxRequestError, type AxErrorCode, type CaptureFailure } from "./ax-errors.ts";
import { computerUseHome } from "../home.ts";
import { platformPackageHelper } from "../platform-package.ts";
export { AxRequestError } from "./ax-errors.ts";

/** The seam a test stubs: the driver only ever calls these two. */
export interface AxTransport {
  /** Optional: swap the helper's element keys for the caller's refs in every error message this
   *  transport builds; installed by the driver. @see AxHelperProcess.nameKeys */
  nameKeys?: (msg: string) => string;
  /** Process-owned element keys died; the driver must discard its corresponding refs. */
  onReset?: () => void;
  request(op: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export type SpawnFn = typeof nodeSpawn;

export interface AxHelperOptions {
  /** The dedicated capture worker never connects back to its own service. */
  captureLocal?: boolean;
  /** A managed host records this executor before any request can be dispatched to it. */
  onStart?: (pid: number) => Promise<void>;
  /** Explicit binary; default `COMPUTER_USE_MACOS_AX_BIN` from `env`, else a cached dev build. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  /** Per-request ceiling. The helper caps each AX call at 1.5 s itself; this is the backstop. */
  timeoutMs?: number;
  /**
   * Every complete line the helper writes to stderr, as it arrives (its own log). Without this
   * they reach nobody unless the helper DIES (the tail rides the exit message).
   */
  onLog?: (line: string) => void;
  /** Observer notifications from a dedicated video helper; never used by action requests. */
  onEvent?: (event: Record<string, unknown>) => void;
}

const STDERR_TAIL_MAX = 2000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AxHelperProcess implements AxTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private generation = 0;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = "";
  private gone: Error | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;
  private readonly binOverride: string | undefined;
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly onEvent: AxHelperOptions["onEvent"];
  private readonly onStart: AxHelperOptions["onStart"];
  private readonly capture: CaptureClient | null;
  /** stderr arrives in chunks, not lines: what is held back until its newline shows up. */
  private stderrPartial = "";

  constructor(opts: AxHelperOptions = {}) {
    this.env = opts.env ?? process.env;
    this.capture = opts.captureLocal ? null : CaptureClient.fromEnv(this.env);
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.binOverride = opts.bin;
    this.onLog = opts.onLog;
    this.onEvent = opts.onEvent;
    this.onStart = opts.onStart;
  }

  async request(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.capture && (op === "shot" || op === "shotscoped")) {
      // Resolve AX keys in THIS session's helper. Only verified window geometry crosses
      // into the shared capture worker; another session can never resolve our keys.
      const captureGeneration = this.generation;
      const plan = await this.request("captureplan", { ...params, scoped: op === "shotscoped" }) as Record<string, unknown>;
      if (captureGeneration !== this.generation) throw new AxRequestError("helper_gone", "The capture owner changed during preparation.");
      const result = await this.capture.request(op, plan);
      if (captureGeneration !== this.generation) throw new AxRequestError("helper_gone", "The capture owner closed before its screenshot returned.");
      return result;
    }
    const generation = this.generation;
    await this.start();
    // A close during startup must cancel THIS request, even if another caller has since
    // opened a new helper. Never replay an action against that replacement process.
    if (generation !== this.generation) throw this.gone ?? new AxRequestError("helper_gone", "ax helper changed before the request was sent");
    if (this.gone) throw this.gone;
    const child = this.child;
    if (!child) throw new AxRequestError("helper_gone", "ax helper is not running");
    const id = this.nextId++;
    const line = `${JSON.stringify({ id, op, ...params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A timed-out helper can still post input. Stop it before the caller can release its
        // ownership or dispatch a follow-up operation against another target.
        void this.close().then(() => reject(new AxRequestError("ax_error", `ax helper: '${op}' did not answer within ${this.timeoutMs} ms; helper stopped`)));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(line);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    }).catch(async (e: unknown) => { await this.closing; throw e; });
  }

  close(): Promise<void> {
    this.capture?.abortRequests();
    if (this.closing) return this.closing;
    const child = this.child;
    this.fail("ax helper closed; any in-flight action's outcome is unknown — observe before acting again");
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const closing = new Promise<void>((done) => {
      // Sending a signal is not proof of exit: ownership stays held until the executor stops.
      const t = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
      child.once("exit", () => { clearTimeout(t); done(); });
      child.stdin.end(); // register the exit listener before asking the helper to exit
    });
    this.closing = closing;
    const clear = () => { if (this.closing === closing) this.closing = null; };
    void closing.then(clear, clear);
    return closing;
  }

  private start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    const generation = this.generation;
    const starting = (async () => {
      await this.closing;
      const bin = this.binOverride ?? (await resolveAxHelper(this.env));
      if (generation !== this.generation) throw new AxRequestError("helper_gone", "ax helper startup was cancelled by close");
      const child = this.spawnFn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env: this.env });
      // A fresh child is a fresh transport: clear the previous one's death and stderr, or every
      // request after a crash would throw the old error.
      this.gone = null;
      this.stderrTail = "";
      this.stderrPartial = "";
      this.child = child;
      child.stdin.on("error", () => undefined); // EPIPE on a dead child is reported via 'exit'
      child.stderr.on("data", (chunk: Buffer) => {
        if (this.child !== child) return;
        const chars = chunk.toString();
        this.stderrTail = `${this.stderrTail}${chars}`.slice(-STDERR_TAIL_MAX);
        if (!this.onLog) return;
        // Line-buffered: a chunk can split a line; the last fragment waits for its newline.
        const parts = `${this.stderrPartial}${chars}`.split("\n");
        this.stderrPartial = parts.pop() ?? "";
        for (const line of parts) {
          const clean = line.replace(/^computer-use-ax-helper:\s*/, "").trim();
          if (clean) this.onLog(clean);
        }
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (this.child === child) this.onLine(line);
      });
      child.on("error", (e) => {
        if (this.child === child) this.fail(`ax helper could not start: ${e.message}`);
      });
      child.on("exit", (code, signal) => {
        if (this.child === child) this.fail(`ax helper exited (${code ?? signal ?? "?"})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`);
      });
      try {
        if (child.pid && this.onStart) await this.onStart(child.pid);
      } catch (e) {
        await this.close();
        throw e;
      }
    })();
    this.starting = starting;
    // Cache only an in-progress start. Failure must be retryable, and an old start's
    // completion must not clear a newer start created after close.
    const clear = () => { if (this.starting === starting) this.starting = null; };
    void starting.then(clear, clear);
    return starting;
  }

  /**
   * Swap the helper's own element keys for the refs the CALLER holds (installed by the driver,
   * which owns the ref map). The helper names a failed element by key (`AXPress on k53`), which
   * the model never saw; these messages reach it verbatim. Here because this is the ONE place
   * every helper error is built.
   */
  nameKeys: (msg: string) => string = (msg) => msg;
  onReset?: () => void;

  private onLine(line: string): void {
    let msg: { id?: number; event?: string; ok?: boolean; result?: unknown; error?: {
      code?: string; message?: string; ax?: number; postedCount?: number; requestedCount?: number; capture?: CaptureFailure;
    } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours — the helper logs to stderr, but be tolerant
    }
    if (msg.event) { this.onEvent?.(msg as Record<string, unknown>); return; }
    const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result ?? {});
    else {
      const said = msg.error?.message ?? "ax helper error";
      p.reject(new AxRequestError((msg.error?.code as AxErrorCode) ?? "ax_error", this.nameKeys(said), msg.error?.ax,
        msg.error?.postedCount, msg.error?.requestedCount, msg.error?.capture));
    }
  }

  private fail(message: string): void {
    this.generation++;
    this.gone = new AxRequestError("helper_gone", message);
    this.child = null;
    this.starting = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.gone);
      this.pending.delete(id);
    }
    this.onReset?.();
  }
}

// ── Binary resolution ─────────────────────────────────────────────────────────

/** The helper's Swift sources sit beside this file; a bundled build has none. */
function sourceDir(): string | null {
  const dir = fileURLToPath(new URL("./ax/", import.meta.url));
  return existsSync(dir) ? dir : null;
}

/** What a packager names the prebuilt it lays down beside the bundle. */
const BUNDLED_HELPER_NAME = "computer-use-ax-helper";

/**
 * A prebuilt helper packed BESIDE the bundle, the packaged mirror of {@link sourceDir}. The two
 * never both answer: a checkout has `ax/` beside this module and no binary; a packaged build
 * (`dist/entries/cli.cjs`) has the binary and no sources.
 */
function bundledHelper(): string | null {
  const bin = fileURLToPath(new URL(`./${BUNDLED_HELPER_NAME}`, import.meta.url));
  return existsSync(bin) ? bin : null;
}

/**
 * Which binary answers, and whether it is the one THESE sources build.
 *
 * A packaged app points `COMPUTER_USE_MACOS_AX_BIN` at its own prebuilt, and a shell inside that
 * app passes the variable on, so a checkout's Swift edits are silently shadowed by a binary from
 * another tree. Anything that REPORTS on the helper must name the binary that answered.
 */
export interface AxHelperInfo {
  bin: string;
  /** `env` = a prebuilt from COMPUTER_USE_MACOS_AX_BIN; `bundle` = the prebuilt packed beside the bundle;
   *  `package` = the prebuilt from the platform's npm package; `sources` = compiled from this checkout. */
  origin: "env" | "bundle" | "package" | "sources";
  /** Hash over the sorted `ax/*.swift` of this checkout; null when there are no sources beside us. */
  sourceHash: string | null;
  /** What the binary claims it was built from (a `<bin>.sha` sidecar, which no shipped build writes
   *  yet), so `null` on a prebuilt means "unknown provenance", never "matches". */
  binHash: string | null;
}

/** The cache key the dev build is stored under: sha256 over the sorted sources, 16 hex. Not
 *  exported: callers want `resolveAxHelperInfo`, and an out-of-tree-only export is dead to knip. */
function axSourceHash(): string | null {
  const dir = sourceDir();
  if (!dir) return null;
  const hash = createHash("sha256");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".swift")).sort()) hash.update(readFileSync(join(dir, f)));
  return hash.digest("hex").slice(0, 16);
}

export async function resolveAxHelperInfo(env: NodeJS.ProcessEnv): Promise<AxHelperInfo> {
  const bin = await resolveAxHelper(env);
  const sidecar = `${bin}.sha`;
  return {
    bin,
    origin: env.COMPUTER_USE_MACOS_AX_BIN?.trim() ? "env" : bundledHelper() ? "bundle" : platformPackageHelper(BUNDLED_HELPER_NAME) ? "package" : "sources",
    sourceHash: axSourceHash(),
    binHash: existsSync(sidecar) ? readFileSync(sidecar, "utf8").trim() : null,
  };
}

async function resolveAxHelper(env: NodeJS.ProcessEnv): Promise<string> {
  const override = env.COMPUTER_USE_MACOS_AX_BIN?.trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`COMPUTER_USE_MACOS_AX_BIN points at ${override}, which does not exist`);
    return override;
  }
  if (process.platform !== "darwin") throw new AxRequestError("unsupported", "the macos driver needs macOS");
  // A packaged build finds its own prebuilt here, so no launcher has to remember an env var (one
  // that forgets would leave the `macos` surface silently unavailable).
  const prebuilt = bundledHelper() ?? platformPackageHelper(BUNDLED_HELPER_NAME);
  if (prebuilt) return prebuilt;
  const dir = sourceDir();
  if (!dir) {
    throw new Error(`macos ax helper: no prebuilt binary (COMPUTER_USE_MACOS_AX_BIN, \`${BUNDLED_HELPER_NAME}\` beside the bundle, or the @mirasim/computer-use-${process.platform}-${process.arch} package) and no Swift sources beside the bundle — a packaged build must ship the helper`);
  }
  const sources = readdirSync(dir).filter((f) => f.endsWith(".swift")).sort().map((f) => join(dir, f));
  const out = join(computerUseHome(), "macos-ax", axSourceHash()!, "ax-helper");
  if (existsSync(out)) return out;
  mkdirSync(join(out, ".."), { recursive: true });
  // First use pays ~10 s of swiftc once per source revision; the hash dir makes a stale
  // binary impossible and a rebuild automatic after any edit to the sources.
  await new Promise<void>((resolve, reject) => {
    execFile("swiftc", ["-O", ...sources, "-o", out], { timeout: 180_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`macos ax helper: swiftc failed (is the Xcode command line toolchain installed?): ${String(stderr || err.message).slice(0, 600)}`));
      else resolve();
    });
  });
  // Two levels up: `out` is <root>/<hash>/ax-helper, and the cache is the ROOT of those hash dirs.
  pruneOldBuilds(join(out, "..", ".."));
  return out;
}

/** How many source revisions' helpers to keep: switching between a couple of branches costs no
 *  rebuild. */
const KEEP_BUILDS = 6;

/**
 * Drop the oldest cached helpers: every edit to the Swift sources adds one, so unpruned the cache
 * grows with the work. Best-effort, and never touches the one just built.
 */
function pruneOldBuilds(root: string): void {
  try {
    const dirs = readdirSync(root)
      .map((name) => ({ name, path: join(root, name) }))
      .filter((d) => statSync(d.path).isDirectory())
      .map((d) => ({ ...d, at: statSync(d.path).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const d of dirs.slice(KEEP_BUILDS)) rmSync(d.path, { recursive: true, force: true });
  } catch {
    // Not a reason to fail; the next build tries again.
  }
}
