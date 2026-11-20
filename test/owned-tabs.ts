/**
 * A session's tabs across a respawn — `node scripts/test.mjs owned-tabs`.
 *
 * Hermetic, over fake pages (only what the ledger reads of one: its Chrome targetId) and a
 * scratch state home:
 *
 *   · with neither a host session (`COMPUTER_USE_SESSION`) nor a tab claim nothing is kept;
 *   · what one driver's ledger owned, was on and called its tabs is what a NEW ledger for the
 *     same session and browser takes back: its tabs are its own again, under the ids the model
 *     knows them by, and the next new tab gets a fresh id (N6, N15);
 *   · another session, or the same session on another browser, takes back nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { browserConfigFromEnv } from "../src/platform/browser/config.ts";
import { ownedTabsStore } from "../src/platform/browser/owned-tabs.ts";
import { TabLedger } from "../src/platform/browser/tab-ledger.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const settle = () => new Promise((r) => setTimeout(r, 20));

/** A page as the ledger sees one: a CDP session that answers its target id. */
function fakePage(targetId: string): Page {
  const page = {
    isClosed: () => false,
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId, browserContextId: "" } }),
        detach: async () => {},
      }),
    }),
  };
  return page as unknown as Page;
}

const home = mkdtempSync(join(tmpdir(), "cu-owned-tabs-"));
try {
  const cfg = (env: Record<string, string>) => browserConfigFromEnv({}, { COMPUTER_USE_HOME: home, ...env });

  check("no session and no claim keeps nothing", ownedTabsStore(cfg({ COMPUTER_USE_TAB: "reuse" }), "extension") === null);
  check("a tab claim alone is enough to keep them", ownedTabsStore(cfg({ COMPUTER_USE_TAB: "name:m-abc-default" }), "cdp:x") !== null);

  // The first process of the session: opens two tabs and is on the second.
  const session = { COMPUTER_USE_TAB: "reuse", COMPUTER_USE_SESSION: "claude:abc" };
  const a = fakePage("T-A"), b = fakePage("T-B");
  let active: Page | undefined = b;
  const first = new TabLedger(() => active);
  first.keepIn(ownedTabsStore(cfg(session), "extension")!);
  first.claim(a);
  first.claim(b);
  const ids = [first.idOf(a), first.idOf(b)];
  first.noteActive(b);
  await settle();

  // The respawned process: the same tabs under NEW page objects, one more that is the user's.
  const a2 = fakePage("T-A"), b2 = fakePage("T-B"), user = fakePage("T-USER");
  active = undefined;
  const second = new TabLedger(() => active);
  second.keepIn(ownedTabsStore(cfg(session), "extension")!);
  await second.identify([a2, b2, user]);
  const known = [await second.recognise(a2), await second.recognise(b2), await second.recognise(user)];
  check("its tabs are its own again, the one it was on recognised as such", known.join() === "ours,same,", known.join());
  check("…and owned", second.owns(a2) && second.owns(b2) && !second.owns(user));
  check("…under the ids the model knows them by", second.idOf(a2) === ids[0] && second.idOf(b2) === ids[1], `${ids} → ${second.idOf(a2)},${second.idOf(b2)}`);
  check("…and a new tab gets an id of its own", ![...ids].includes(second.idOf(user)), second.idOf(user));

  const other = new TabLedger(() => undefined);
  other.keepIn(ownedTabsStore(cfg({ ...session, COMPUTER_USE_SESSION: "claude:other" }), "extension")!);
  check("another session takes back nothing", !other.ownsAny());
  const elsewhere = new TabLedger(() => undefined);
  elsewhere.keepIn(ownedTabsStore(cfg(session), "managed:/somewhere")!);
  check("the same session on another browser takes back nothing", !elsewhere.ownsAny());
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} owned-tabs check(s) failed`);
  process.exit(1);
}
console.log("\nall owned-tabs checks passed");
