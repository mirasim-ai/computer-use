/**
 * WHICH TABS WERE THIS SESSION'S, kept beyond this process. tab-ledger.ts keeps them for the life
 * of a driver; this keeps them for the life of the SESSION.
 *
 * A host reaps an idle child and starts a new one for the same session (docs/embedding.md,
 * "Respawning"). The new driver knew none of the tabs the old one had opened: a `name:`/`ctx:`
 * claim found its one stamped tab again, and every other tab the session had opened (a page's
 * new-tab link, a second newTab, the tab openUrl opened in the user's own Chrome) was listed as
 * the user's (`own: false`) or, behind a claim, not at all — and close_tab refused it, so the
 * session could neither find nor close its own work (N6 embedded browser, N15 extension).
 *
 * So the Chrome targetIds of the session's tabs, and the one it was on, are written to a file
 * named for the session (`COMPUTER_USE_SESSION`, else the tab claim's key) and the browser
 * (`endpoint`), and a driver for the same session on the same browser takes them back as a
 * reconnect does (driver-connect.ts `reclaimOwn`). Ids only, no URLs or titles: a closed tab's id
 * matches nothing again and ages out. With no session named nothing is kept, as before.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserConfig } from "./config.ts";

/** Enough for a session's tabs; the oldest ids (tabs long closed) go first. */
const KEEP = 64;

export interface OwnedTabs {
  /** Chrome targetIds of the tabs the session opened or claimed, oldest first. */
  owned: string[];
  /** The targetId of the tab the session was on, its own or not. */
  active: string | null;
  /** The ids the model knows the tabs by (`t3`), by targetId, and the next one to hand out: a tab
   *  must not come back under another tab's id, or a close_tab({id}) the model wrote before the
   *  respawn closes the wrong one. */
  ids: Array<[string, string]>;
  next: number;
}

export interface OwnedTabsStore {
  load(): OwnedTabs;
  save(state: OwnedTabs): void;
}

/** Who the tabs are kept for: the host's session, else the tab claim (which is per session by
 *  design: a respawned child re-adopts its stamped tab by it). Null keeps nothing. */
function keeper(cfg: BrowserConfig): string | null {
  if (cfg.session) return `session:${cfg.session}`;
  if (cfg.tab) return `${cfg.tab.isolated ? "ctx" : "name"}:${cfg.tab.key}`;
  return null;
}

/** The store for this session on the browser `endpoint` names, or null when there is no session
 *  to keep them for. Every read and write is best-effort: a lost file only costs the tabs being
 *  the user's again, which is what happened before. */
export function ownedTabsStore(cfg: BrowserConfig, endpoint: string): OwnedTabsStore | null {
  const who = keeper(cfg);
  if (!who) return null;
  const name = createHash("sha256").update(`${who}\n${endpoint}`).digest("hex").slice(0, 24);
  const file = join(cfg.home, "run", "owned-tabs", `${name}.json`);
  return {
    load() {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as { owned?: unknown; active?: unknown; ids?: unknown; next?: unknown };
        const owned = Array.isArray(raw.owned) ? raw.owned.filter((id): id is string => typeof id === "string" && !!id) : [];
        const ids = Array.isArray(raw.ids) ? raw.ids.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string") : [];
        const next = typeof raw.next === "number" && Number.isInteger(raw.next) && raw.next > 0 ? raw.next : 1;
        return { owned: owned.slice(-KEEP), active: typeof raw.active === "string" && raw.active ? raw.active : null, ids: ids.slice(-KEEP), next };
      } catch {
        return { owned: [], active: null, ids: [], next: 1 };
      }
    },
    save(state) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ owned: state.owned.slice(-KEEP), active: state.active, ids: state.ids.slice(-KEEP), next: state.next, updatedAt: new Date().toISOString() }));
        renameSync(tmp, file);
      } catch {
        // Best-effort, see above.
      }
    },
  };
}
