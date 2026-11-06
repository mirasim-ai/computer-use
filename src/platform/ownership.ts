/** Cross-process ownership for cooperating computer-use runtimes. Transactions protect acquisition of
 * several resources together; a process death, not a clock timeout, makes an abandoned claim
 * reclaimable. A slow action must never lose its lock while it can still dispatch input.
 *
 * The one clock is the OWNER's, between calls: a runtime idle for {@link IDLE_RELEASE_MS} lets
 * go of its claims itself (tools/repl.ts). A host that never ends turns (Codex keeps each
 * thread's MCP server alive after the thread is done) would otherwise leave a live, idle
 * process holding a tab the next session needs. Nothing is in flight then, so nothing can be
 * dispatched under a lost lock, and the owner's next call takes the target back unless someone
 * else has it.
 *
 * One store per machine user (`<sharedHome>/ownership/claims.sqlite`), whatever home a host
 * names: every runtime that can reach the same screen and browsers arbitrates in it, whether a
 * desktop app, a standalone MCP session or a second build of either started it. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OwnershipResource } from "./types.ts";
import { sharedHome } from "./home.ts";

interface Claim { owner: string; pid: number; mode: string }

/** How long a runtime with no call in progress keeps its claims. Longer than a model's pause to
 *  edit code between two looks at a page; shorter than the gap before another session starts. */
export const IDLE_RELEASE_MS = 2 * 60_000;

/** Ownership policy: the local store below unless an embedder injects its own. */
export interface OwnershipProvider {
  claim(group: string, resources: OwnershipResource[]): Promise<void>;
  release(group: string): Promise<void>;
  releaseAll(): Promise<void>;
  trackProcess?(pid: number): Promise<void>;
}

export class OwnershipBusyError extends Error {
  constructor(resource: string) {
    super(`Resource ${resource} is in use by another runtime. Nothing was dispatched. `
      + "Use a different target, or wait for its owner to finish and release it (an owner with no call in progress "
      + `lets go within ${IDLE_RELEASE_MS / 60_000} minutes); do not reset another session.`);
    this.name = "OwnershipBusyError";
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * When the process now holding `pid` started, as an opaque string compared only for equality;
 * "" when it cannot be read (Windows, or a process gone), which never proves anything. A pid
 * alone is not an identity: the OS hands a dead owner's pid to a new process, and its claims
 * would then look held forever. Linux reads `/proc` (clock ticks since boot); elsewhere `ps`,
 * in a fixed locale and zone so two runtimes spell the same start alike.
 */
function processStart(pid: number): string {
  if (process.platform === "win32") return "";
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22, counted after the `(comm)` field, which may itself hold spaces and parens.
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
    } catch { /* fall through to ps */ }
  }
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }).trim();
  } catch {
    return "";
  }
}

export class ComputerUseOwnership implements OwnershipProvider {
  private readonly owner = randomUUID();
  private db: DatabaseSync | null = null;
  private started: string | null = null;

  private async database(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    const root = join(sharedHome(), "ownership");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, "claims.sqlite"));
    // `executors`: native helpers an owner started. A helper can outlive its runtime while it
    // still dispatches input, so an owner's claims stay held until its helpers exit too. A row
    // outlives releaseAll (a helper is resident across resets) and goes once both pids are gone.
    db.exec("PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS claims ("
      + "resource TEXT NOT NULL, owner TEXT NOT NULL, group_id TEXT NOT NULL, pid INTEGER NOT NULL, "
      + "mode TEXT NOT NULL, PRIMARY KEY(resource, owner, group_id)); "
      + "CREATE TABLE IF NOT EXISTS executors (owner TEXT NOT NULL, runtime INTEGER NOT NULL, "
      + "pid INTEGER NOT NULL, PRIMARY KEY(owner, pid)); "
      // `runtimes`: when each owner's process started, so a pid the OS has since handed to
      // another process does not keep a dead owner's claims alive. Owners written by a build
      // without this table have no row and are judged by pid alone, as before.
      + "CREATE TABLE IF NOT EXISTS runtimes (owner TEXT PRIMARY KEY, pid INTEGER NOT NULL, started TEXT NOT NULL)");
    this.started ??= processStart(process.pid);
    db.prepare("INSERT OR REPLACE INTO runtimes VALUES (?,?,?)").run(this.owner, process.pid, this.started);
    for (const r of db.prepare("SELECT owner,pid FROM runtimes").all() as unknown as { owner: string; pid: number }[]) {
      if (!alive(r.pid)) db.prepare("DELETE FROM runtimes WHERE owner=?").run(r.owner);
    }
    const rows = db.prepare("SELECT owner,runtime,pid FROM executors").all() as unknown as { owner: string; runtime: number; pid: number }[];
    for (const r of rows) {
      if (!alive(r.runtime) && !alive(r.pid)) db.prepare("DELETE FROM executors WHERE owner=? AND pid=?").run(r.owner, r.pid);
    }
    this.db = db;
    return db;
  }

  /** The runtime and every helper it registered have exited. */
  private gone(db: DatabaseSync, owner: string, pid: number): boolean {
    if (alive(pid) && !this.reused(db, owner, pid)) return false;
    const helpers = db.prepare("SELECT pid FROM executors WHERE owner=?").all(owner) as unknown as { pid: number }[];
    return !helpers.some((h) => alive(h.pid));
  }

  /** The owner's pid now names a process that started at another time than the owner did. */
  private reused(db: DatabaseSync, owner: string, pid: number): boolean {
    const row = db.prepare("SELECT started FROM runtimes WHERE owner=? AND pid=?").get(owner, pid) as { started: string } | undefined;
    if (!row?.started) return false;
    const now = processStart(pid);
    return now !== "" && now !== row.started;
  }

  async claim(group: string, resources: OwnershipResource[]): Promise<void> {
    const db = await this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const resource of resources) {
        const rows = db.prepare("SELECT owner,pid,mode FROM claims WHERE resource=? AND owner<>?")
          .all(resource.key, this.owner) as unknown as Claim[];
        for (const row of rows) {
          if (this.gone(db, row.owner, row.pid)) {
            db.prepare("DELETE FROM claims WHERE owner=?").run(row.owner);
            db.prepare("DELETE FROM executors WHERE owner=?").run(row.owner);
            db.prepare("DELETE FROM runtimes WHERE owner=?").run(row.owner);
          } else if (resource.mode === "exclusive" || row.mode === "exclusive") {
            throw new OwnershipBusyError(resource.key);
          }
        }
        db.prepare("INSERT INTO claims VALUES (?,?,?,?,?) ON CONFLICT(resource,owner,group_id) "
          + "DO UPDATE SET mode=CASE WHEN claims.mode='exclusive' THEN 'exclusive' ELSE excluded.mode END")
          .run(resource.key, this.owner, group, process.pid, resource.mode);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  async release(group: string): Promise<void> {
    this.db?.prepare("DELETE FROM claims WHERE owner=? AND group_id=?").run(this.owner, group);
  }

  async releaseAll(): Promise<void> {
    if (!this.db) return;
    this.db.prepare("DELETE FROM claims WHERE owner=?").run(this.owner);
    this.db.prepare("DELETE FROM runtimes WHERE owner=?").run(this.owner);
    this.db.close();
    this.db = null;
  }

  /** Record a native helper before it receives its first request: written synchronously, so it
   *  is on disk before the helper can dispatch anything. */
  async trackProcess(pid: number): Promise<void> {
    const db = await this.database();
    db.prepare("INSERT OR IGNORE INTO executors VALUES (?,?,?)").run(this.owner, process.pid, pid);
  }
}
