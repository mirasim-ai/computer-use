/**
 * A session's tabs are still its own, under the same ids and with the same one active, after its
 * connection to the browser is made again — `node scripts/test.mjs tab-identity`.
 *
 * Every page object is new after a reconnect (the connection dropped, or a turn ended and the
 * next one connected again), so what the driver knew by object is gone and Chrome's targetId is
 * what names a tab. Before, three things went wrong on an endpoint the driver did not launch:
 * the session's own tabs came back listed as the user's (not closable, never the default
 * surface), each under a new id, and the session was put on a fresh blank tab; and where it WAS
 * taken back to a tab, that was the one it had last been moved to by the driver, not the one the
 * script had since chosen with focus() or been left on by close_tab.
 *
 * A session that was on a tab NOT its own when the connection went comes back on one of its own
 * that is still open; it is given a fresh tab only when it has none.
 */

import { createServer } from "node:http";
import { BrowserDriver } from "../src/platform/browser/driver.ts";
import type { TargetInfo } from "../src/platform/types.ts";
import { sleep, spawnChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function serve(): Promise<{ base: string; close: () => void }> {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Page ${(req.url ?? "/x").slice(1, 2).toUpperCase()}</title><button>ok</button>`);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    resolve({ base: `http://127.0.0.1:${port}`, close: () => srv.close() });
  }));
}

/** The session's own tabs as the model is shown them: `<id> <title>`, the active one starred. */
const shown = (ts: TargetInfo[]) => ts.filter((t) => t.title.startsWith("Page "))
  .map((t) => `${t.active ? "*" : ""}${t.id} ${t.title}${t.own ? "" : " (user's)"}${t.mine ? "" : " (not mine)"}`).sort().join(", ");

async function main() {
  const chrome = await spawnChrome({});
  const pages = await serve();
  const previous = process.env.COMPUTER_USE_CDP_URL;
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  delete process.env.COMPUTER_USE_TAB;
  const driver = new BrowserDriver();
  /** Cut the driver's connection the way a network drop does: the browser and its tabs stay. */
  const drop = () => (driver as unknown as { browser: { close(): Promise<void> } }).browser.close();
  try {
    await driver.perform("open_url", { url: `${pages.base}/a` });
    await driver.perform("new_tab", { url: `${pages.base}/b` });
    await driver.perform("new_tab", { url: `${pages.base}/c` });
    const first = await driver.listTargets();
    const idOf = (title: string) => first.find((t) => t.title === title)?.id ?? "";
    check("three tabs of the session's own, on the last one opened",
      first.filter((t) => t.mine).length === 3 && first.find((t) => t.active)?.title === "Page C", shown(first));

    // ── The script chooses a tab; the connection drops and returns ───────────────────────
    await driver.focusTarget(idOf("Page A"));
    const chosen = shown(await driver.listTargets());
    await drop();
    const afterDrop = await driver.listTargets();
    check("after a reconnect the session's tabs are still its own, under the same ids", shown(afterDrop) === chosen,
      `${chosen}  →  ${shown(afterDrop)}`);
    check("...it is on the tab the script chose, not the one the driver last moved it to",
      afterDrop.find((t) => t.active)?.title === "Page A", shown(afterDrop));
    check("...and no tab was opened for it", afterDrop.length === first.length, `${first.length} → ${afterDrop.length}`);
    const note = driver.takeNoteForResult() ?? "";
    check("...and the run is told its refs died with the connection", /connection to this browser dropped and came back/.test(note),
      note || "(no note)");

    // ── close_tab leaves the session on another of its tabs; the same again ──────────────
    await driver.perform("close_tab", {});
    const left = await driver.listTargets();
    const leftOn = left.find((t) => t.active)?.title ?? "";
    check("closing the tab it is on leaves the session on another of its own", /^Page [BC]$/.test(leftOn), shown(left));
    await drop();
    const afterClose = await driver.listTargets();
    check("after a reconnect it is still on the tab close_tab left it on", shown(afterClose) === shown(left),
      `${shown(left)}  →  ${shown(afterClose)}`);

    // ── A turn ends (the driver disconnects) and the next one connects again ─────────────
    await driver.close();
    const nextTurn = await driver.listTargets();
    check("a session that connects again after closing finds its tabs, and the one it was on", shown(nextTurn) === shown(left),
      `${shown(left)}  →  ${shown(nextTurn)}`);
    check("...with no blank tab opened for the new connection", nextTurn.length === afterClose.length, `${afterClose.length} → ${nextTurn.length}`);

    // ── On a tab that is not its own when the connection drops ───────────────────────────
    await fetch(`${chrome.cdpUrl}/json/new?${pages.base}/u`, { method: "PUT" });
    let users: TargetInfo | undefined;
    for (let i = 0; i < 40 && !users; i++) {
      users = (await driver.listTargets()).find((t) => t.title === "Page U");
      if (!users) await sleep(100);
    }
    check("a tab somebody else opened is listed as not the session's", !!users && users.own === false && users.mine === false,
      JSON.stringify(users));
    await driver.focusTarget(users?.id ?? "");
    const onUsers = await driver.listTargets();
    await drop();
    const afterUsers = await driver.listTargets();
    check("dropped while on a tab that is not its own, the session comes back on one of its own",
      /^Page [BC]$/.test(afterUsers.find((t) => t.active)?.title ?? ""), shown(afterUsers));
    check("...opens none for that, and takes nothing that was not its own", afterUsers.length === onUsers.length
      && afterUsers.find((t) => t.title === "Page U")?.own === false, `${onUsers.length} → ${afterUsers.length}`);
    const closedAll = await driver.perform("close_tab", { all: true });
    const remaining = await driver.listTargets().catch(() => [] as TargetInfo[]);
    check("...and may close its own, and only those", shown(remaining) === `${users?.id} Page U (user's) (not mine)`,
      `${closedAll.note ?? ""} | ${shown(remaining)}`);
  } finally {
    await driver.close().catch(() => {});
    chrome.cleanup();
    pages.close();
    if (previous === undefined) delete process.env.COMPUTER_USE_CDP_URL; else process.env.COMPUTER_USE_CDP_URL = previous;
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall tab-identity checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
