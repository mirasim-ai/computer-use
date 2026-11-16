/**
 * The "always allow" answers a platform keeps on disk itself — for a host that asks its user but
 * keeps no approvals of its own (a generic MCP client). One JSON file per platform, holding one
 * list of app names under one field.
 *
 * A host that DOES keep them (an allow-list in its own settings, say) turns a platform's store
 * off by setting its variable to `""`, so exactly one list decides and removing an app there is
 * the whole of revoking it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { computerUseHome } from "./home.ts";

/** What tells one platform's store from another's. */
export interface ApprovalsShape {
  /** The environment variable that moves the file, or turns the store off when set to `""`. */
  variable: string;
  /** The file's name under computer-use's home when the variable is unset. */
  fileName: string;
  /** The JSON field the list sits under. */
  field: string;
  /** How an app's name is compared and stored; as written when absent. */
  key?: (app: string) => string;
}

export class ApprovalsStore {
  /** null = this host keeps approvals itself; nothing is read or written. */
  readonly file: string | null;
  private readonly field: string;
  private readonly key: (app: string) => string;

  constructor(env: NodeJS.ProcessEnv, shape: ApprovalsShape) {
    const raw = env[shape.variable];
    this.file = raw === undefined ? join(computerUseHome(env), shape.fileName) : raw.trim() || null;
    this.field = shape.field;
    this.key = shape.key ?? ((app) => app);
  }

  /** Read fresh every time: another session may have added or removed one since. */
  has(app: string): boolean {
    return this.read().includes(this.key(app));
  }

  list(): string[] {
    return this.read();
  }

  add(app: string): void {
    const now = this.read(), k = this.key(app);
    if (!now.includes(k)) this.write([...now, k]);
  }

  remove(app: string): void {
    const now = this.read(), k = this.key(app);
    if (now.includes(k)) this.write(now.filter((a) => a !== k));
  }

  private read(): string[] {
    if (!this.file) return [];
    try {
      const apps = (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>)[this.field];
      return Array.isArray(apps) ? apps.filter((v): v is string => typeof v === "string").map(this.key) : [];
    } catch {
      return []; // absent or unreadable: nothing is approved, which only means the user is asked
    }
  }

  private write(apps: string[]): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ [this.field]: apps }, null, 2) + "\n");
    } catch { /* an unwritable store costs the user one more question, never the action */ }
  }
}
