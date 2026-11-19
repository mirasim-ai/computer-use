/**
 * What a first call that gets something wrong is told, in a browser tab —
 * `node scripts/test.mjs first-use-browser`.
 *
 * The browser half of `first-use`: the verbs and notes only a tab has (openUrl, runJs, newTab,
 * selectOption), against a throwaway headless Chrome and a local page.
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
const head = (s: string) => s.split("\n")[0] ?? "";
const line = (s: string, re: RegExp) => (s.split("\n").find((l) => re.test(l)) ?? head(s)).slice(0, 400);

const APP = `<!doctype html><title>Tasks</title><h1>Tasks</h1>
<label>Quantity <input aria-label="Quantity" value="1"></label>
<label>Priority <select aria-label="Priority"><option>Low</option><option>High</option></select></label>`;

function serve(): Promise<{ port: number; close: () => void }> {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(APP);
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
  const profile = resolveProfile({ driver: "browser" });
  const tool = Object.fromEntries(profile.tools.map((t) => [t.name, t.execute]));
  const call = async (params: Record<string, unknown>) => allText(await tool.computer_repl!({ observation: "brief", ...params }) as Result);
  const run = (code: string) => call({ code });

  try {
    await run(`const w = await computer.surface(); await w.openUrl({url: '${at("/app.html")}'}); return 1;`);

    // ── Verb names from Playwright and Puppeteer ───────────────────────────────────────────
    const goto = head(await run(`await w.goto('${at("/app.html")}');`));
    check("w.goto names openUrl with its url option", /w\.goto is not a function — a surface handle has no goto — instead: await w\.openUrl\(\{url: "https:\/\/…"\}\)/.test(goto), goto);
    const evaluate = head(await run("return await w.evaluate('document.title');"));
    check("w.evaluate names runJs with its code option", /instead: await w\.runJs\(\{code: "document\.title"\}\)/.test(evaluate), evaluate);
    const select = head(await run("await w.select('Priority', 'High');"));
    check("w.select names selectOption with ref and option", /instead: await w\.selectOption\(\{ref: t, option: "…"\}\)/.test(select), select);
    const top = head(await run(`await computer.openUrl({url: '${at("/app.html")}'});`));
    check("computer.openUrl says to bind a handle first",
      /openUrl is a verb on a surface handle, bound first: const w = await computer\.surface\(\); await w\.openUrl\(\{url: "https:\/\/…"\}\)/.test(top), top);
  } finally {
    for (const driver of profile.drivers) await driver.close().catch(() => {});
    fixtures.close();
    chrome.cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall first-use browser checks passed");
  process.exit(failures ? 1 : 0);
}

void line;
void main();
