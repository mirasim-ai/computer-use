/**
 * A session that closed its last tab gets the browser back, at the tool surface.
 *
 * close_tab tells the model "open_url or new_tab starts a fresh one", and that has to be true on
 * the handles a script actually holds: the handle whose tab was closed, and the one
 * computer.surface() hands back once nothing of the session's is open. Other verbs on either
 * say how to get a tab back instead of only "gone". Before, computer.surface() threw "this driver
 * has no surface right now" and the old handle's newTab first tried to bind the closed tab, so a
 * multi-turn task could not get back to the page it was checking.
 */

import { createServer } from "node:http";
import { spawnChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Result = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const allText = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
const line = (s: string, re: RegExp) => s.split("\n").find((l) => re.test(l)) ?? s.split("\n")[0];

function serve(): Promise<{ base: string; close: () => void }> {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url === "/b.html" ? "<!doctype html><title>Page B</title><button>Bee</button>" : "<!doctype html><title>Page A</title><button>Ay</button>");
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    resolve({ base: `http://127.0.0.1:${port}`, close: () => srv.close() });
  }));
}

async function main() {
  // The throwaway Chrome holds about:blank tabs that are not this session's: what the session
  // gets back must be a tab of its own, never one of those.
  const chrome = await spawnChrome({});
  const fixtures = await serve();
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  delete process.env.COMPUTER_USE_WINDOW;
  delete process.env.COMPUTER_USE_TAB;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const tool = Object.fromEntries(profile.tools.map((t) => [t.name, t.execute]));
  const run = async (code: string) => allText(await tool.computer_repl({ code }) as Result);

  try {
    await run(`const w = await computer.surface(); await w.openUrl({ url: '${fixtures.base}/a.html' });`);
    const closed = await run(`await w.closeTab({ all: true });`);
    check("closing the last tab says a fresh one can be opened", /open_url or new_tab starts a fresh one/.test(closed), line(closed, /closed/));

    const looked = await run(`await w.observe();`);
    check("another verb on the closed tab's handle says how to get one back",
      /Run STOPPED/.test(looked) && /openUrl\(\{url\}\) or newTab\(\{url\}\) on this handle opens a fresh one/.test(looked), line(looked, /STOPPED/));

    const reopened = await run(`await w.openUrl({ url: '${fixtures.base}/b.html' }); return { title: w.title, mine: w.mine };`);
    check("openUrl on the closed tab's handle opens a fresh tab and the handle follows it",
      /Returned: \{"title":"Page B","mine":true\}/.test(reopened) && !/STOPPED/.test(reopened), line(reopened, /Returned|STOPPED/));
    const acted = await run(`await w.click(w.find ? (await w.find('Bee')).ref : 'e1'); return (await w.text()).includes('Bee');`);
    check("…and the handle acts on that tab afterwards", /Returned: true/.test(acted), line(acted, /Returned|STOPPED/));
    const owned = await run(`return (await computer.surfaces()).filter((s) => s.mine).length;`);
    check("…which is the session's only tab of its own", /Returned: 1/.test(owned), line(owned, /Returned|STOPPED/));

    await run(`await w.closeTab({ all: true });`);
    const stand = await run(`const v = await computer.surface(); return { id: v.id, mine: v.mine };`);
    check("computer.surface() after the last tab closed hands back a stand-in, not an error",
      /Returned: \{"id":"new","mine":true\}/.test(stand), line(stand, /Returned|STOPPED/));
    const early = await run(`await v.click('e1');`);
    check("a verb other than openUrl / newTab on the stand-in says what opens a tab",
      /Run STOPPED/.test(early) && /holds no tab yet — openUrl\(\{url\}\) or newTab\(\{url\}\) on it opens one/.test(early), line(early, /STOPPED/));
    const opened = await run(`await v.newTab({ url: '${fixtures.base}/a.html' }); return { title: v.title, id: v.id === 'new' };`);
    check("newTab on the stand-in opens the session's tab and the stand-in becomes its handle",
      /Returned: \{"title":"Page A","id":false\}/.test(opened) && !/STOPPED/.test(opened), line(opened, /Returned|STOPPED/));
    const ownTabs = await run(`return (await computer.surfaces()).filter((s) => s.mine).map((s) => s.title);`);
    check("…and opens only that one tab, no blank one beside it", /Returned: \["Page A"\]/.test(ownTabs), line(ownTabs, /Returned|STOPPED/));
    const again = await run(`const u = await computer.surface(); return u === v;`);
    check("…and computer.surface() binds that tab again", /Returned: true/.test(again), line(again, /Returned|STOPPED/));
  } finally {
    fixtures.close();
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nLAST TAB OK" : `\nLAST TAB FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
