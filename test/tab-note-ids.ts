/**
 * The id a note gives a tab is the id that binds it — `node scripts/test.mjs tab-note-ids`.
 *
 * With several platforms mounted in one session every surface id carries its platform
 * (`browser/t3`), and a note is where a script learns of a tab it did not list: the tab a page
 * opened, the tab newTab made, the tab the target moved to when its own was closed. Each of those
 * notes named the tab without the platform (`t3`), so the line it told the model to write,
 * `computer.surface('t3')`, matched no surface. Here every id a note hands over is taken from the
 * note as written and bound, with two platforms mounted.
 *
 * One platform mounted, where ids have no prefix, is pinned by `page-opened-tabs`.
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
const line = (s: string, re: RegExp) => (s.split("\n").find((l) => re.test(l)) ?? s.split("\n")[0] ?? "").slice(0, 300);
const returned = <T>(s: string): T | null => {
  try { return JSON.parse(/Returned: (.*)/.exec(s)?.[1] ?? "null") as T; } catch { return null; }
};

const page = (title: string, body: string) => `<!doctype html><title>${title}</title>${body}`;

function serve(): Promise<{ port: number; close: () => void }> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/list.html") res.end(page("List", `<h1>List</h1><a href="/doc.html?from=link" target="_blank">New document</a>`));
    else res.end(page(`Doc ${url.searchParams.get("from") ?? ""}`.trim(), "<h1>Document</h1>"));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    resolve({ port: (srv.address() as { port: number }).port, close: () => srv.close() });
  }));
}

async function main() {
  const chrome = await spawnChrome({});
  const fixtures = await serve();
  const at = (path: string) => `http://127.0.0.1:${fixtures.port}${path}`;
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  delete process.env.COMPUTER_USE_WINDOW;
  delete process.env.COMPUTER_USE_TAB;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  // Two platforms, as a host that drives a browser and an app in one session mounts them. The
  // second is never reached: every call is about the browser, and drivers connect lazily.
  const profile = resolveProfile({ driver: "browser,electron" });
  const tool = Object.fromEntries(profile.tools.map((t) => [t.name, t.execute]));
  const run = async (code: string) => allText(await tool.computer_repl({ code, platform: "browser", observation: "none" }) as Result);
  const listed = async () => returned<string[]>(await run("return (await computer.surfaces()).map((s) => s.id);")) ?? [];
  /** Bind the id exactly as a note wrote it, and say where that tab is. */
  const bind = async (id: string) => await run(`const t = await computer.surface(${JSON.stringify(id)}); return { id: t.id, url: (await t.observe()).url };`);

  try {
    const first = await run(`const w = await computer.surface(); await w.openUrl({ url: '${at("/list.html")}' }); return w.id;`);
    // A returned string is printed as it is, not as JSON.
    const own = /Returned: (\S+)/.exec(first)?.[1] ?? "";
    check("with two platforms mounted the session's tab is listed under its platform", /^browser\/t\d+$/.test(own), line(first, /Returned|STOPPED/));

    // ── The tab a page opened ───────────────────────────────────────────────────────────────
    const clicked = await run(`return await w.click(await w.find('New document', { role: 'link' }));`);
    const opened = /the page opened a new tab, (\S+) \(/.exec(clicked)?.[1] ?? "";
    const toBind = /computer\.surface\('([^']+)'\) binds the new one/.exec(clicked)?.[1] ?? "";
    check("the note for a tab the page opened names it as the listing does",
      !!opened && opened === toBind && (await listed()).includes(opened), line(clicked, /the page opened a new tab|STOPPED/));
    const boundOpened = await bind(toBind);
    check("…and the line it says to write binds that tab",
      returned<{ id: string; url: string }>(boundOpened)?.url === at("/doc.html?from=link"), line(boundOpened, /Returned|STOPPED/));

    // ── The tab newTab made ─────────────────────────────────────────────────────────────────
    const second = await run(`return await w.newTab({ url: '${at("/doc.html?from=new-tab")}' });`);
    const made = /opened new tab (\S+) —/.exec(second)?.[1] ?? "";
    const toBindMade = /computer\.surface\('([^']+)'\) binds the new one/.exec(second)?.[1] ?? "";
    check("newTab's note names its tab as the listing does", !!made && made === toBindMade && (await listed()).includes(made),
      line(second, /new tab|STOPPED/));
    const boundMade = await bind(toBindMade);
    check("…and the line it says to write binds that tab",
      returned<{ id: string; url: string }>(boundMade)?.url === at("/doc.html?from=new-tab"), line(boundMade, /Returned|STOPPED/));

    // ── The tab the target moved to ─────────────────────────────────────────────────────────
    const closed = await run(`const t = await computer.surface(${JSON.stringify(made)}); return await t.closeTab();`);
    const moved = /closed tab (\S+); the target moved to (\S+) —/.exec(closed);
    const after = await listed();
    check("closing the tab a session is on names the closed tab and the one it moved to as the listing does",
      moved?.[1] === made && !!moved[2] && after.includes(moved[2]) && !after.includes(made), line(closed, /closed tab|STOPPED/));
    const boundNext = await bind(moved?.[2] ?? "");
    check("…and the tab it moved to binds by that id", !!moved?.[2] && returned<{ id: string }>(boundNext)?.id === moved[2], line(boundNext, /Returned|STOPPED/));

    // ── The first tab of a session that had closed them all ─────────────────────────────────
    await run(`await (await computer.surface(${JSON.stringify(moved?.[2] ?? "")})).closeTab({ all: true });`);
    const woke = await run(`const again = await computer.surface(); return await again.newTab({ url: '${at("/doc.html?from=woke")}' });`);
    const fresh = /opened new tab (\S+) —/.exec(woke)?.[1] ?? "";
    check("the tab newTab opens for a session holding none is named as the listing does",
      /^browser\/t\d+$/.test(fresh) && (await listed()).includes(fresh), line(woke, /new tab|STOPPED/));
  } finally {
    for (const driver of profile.drivers) await driver.close().catch(() => {});
    fixtures.close();
    chrome.cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
