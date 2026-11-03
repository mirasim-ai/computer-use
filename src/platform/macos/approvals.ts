/**
 * The "always allow" answers this platform keeps itself — for a host that asks its user but keeps
 * no approvals of its own (a generic MCP client). Codex Computer Use keeps the same thing on the
 * tool side (`ComputerUseAppApprovals.json`, `approvedBundleIdentifiers`), which is why a
 * `persist: "always"` answer outlives the session there and here.
 *
 * A host that DOES keep them (an allow-list in its own settings, say) turns this off with
 * `COMPUTER_USE_MACOS_APPROVALS=""`, so exactly one list decides and removing an app there is the whole of
 * revoking it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { computerUseHome } from "../home.ts";

export class MacosApprovals {
  /** null = this host keeps approvals itself; nothing is read or written. */
  readonly file: string | null;

  constructor(env: NodeJS.ProcessEnv) {
    const raw = env.COMPUTER_USE_MACOS_APPROVALS;
    this.file = raw === undefined ? join(computerUseHome(env), "macos-approvals.json") : raw.trim() || null;
  }

  /** Read fresh every time: another session may have added or removed one since. */
  has(bundle: string): boolean {
    return this.read().includes(bundle);
  }

  list(): string[] {
    return this.read();
  }

  add(bundle: string): void {
    const now = this.read();
    if (!now.includes(bundle)) this.write([...now, bundle]);
  }

  remove(bundle: string): void {
    const now = this.read();
    if (now.includes(bundle)) this.write(now.filter((b) => b !== bundle));
  }

  private read(): string[] {
    if (!this.file) return [];
    try {
      const ids = (JSON.parse(readFileSync(this.file, "utf8")) as { approvedBundleIdentifiers?: unknown }).approvedBundleIdentifiers;
      return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return []; // absent or unreadable: nothing is approved, which only means the user is asked
    }
  }

  private write(ids: string[]): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ approvedBundleIdentifiers: ids }, null, 2) + "\n");
    } catch { /* an unwritable store costs the user one more question, never the action */ }
  }
}
