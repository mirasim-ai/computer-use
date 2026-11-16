/**
 * A call that does not come back is ended, and what comes after it works —
 * `node scripts/test.mjs stuck-call`.
 *
 * One verb the surface never answers used to hold everything behind it: the call's time cap is
 * read when a verb starts, so it never saw that verb; every later call queued behind it; ending
 * the turn waited on it and left the server answering "cleanup in progress" for good; and a
 * server told to stop (SIGTERM, stdin closed) waited on it too and never exited.
 *
 * Against a throwaway headless Chrome:
 *
 *   · with one window of an app hung, a verb on another window still answers (an Electron
 *     driver, attached to Chrome as the other suites attach it);
 *   · a call waiting on something that is no verb, a verb a hung page never answers, and code
 *     that catches a cap and calls on are each ended, saying why, and the next call runs;
 *   · over the real MCP server: ending the turn does not wait on a stuck call, the server takes
 *     calls afterwards, and SIGTERM ends it while a call is stuck.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { BrowserDriver } from "../src/platform/browser/driver.ts";
import { ElectronDriver } from "../src/platform/electron/driver.ts";
import { createComputerUseTools } from "../src/platform/tools/index.ts";
import { sleep, spawnChrome } from "./helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Result = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const allText = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").split("\nAPI reference")[0]!;
const head = (s: string) => s.split("\n")[0]!.slice(0, 260);
const ownership = { claim: async () => {}, release: async () => {}, releaseAll: async () => {} };

/** `work`'s text and how long it took, or null when it had not answered within `capMs`. */
async function timed(work: Promise<unknown>, capMs: number): Promise<{ text: string; ms: number } | null> {
  const started = Date.now();
  const text = await Promise.race([work.then((r) => allText(r as Result), (e) => `THREW ${(e as Error).message}`), sleep(capMs).then(() => null)]);
  return text === null ? null : { text, ms: Date.now() - started };
}

const MAIN = "data:text/html,<title>Main window</title><h1>Main</h1><button onclick=\"document.title='clicked'\">Do it</button>";
const OTHER = "data:text/html,<title>Other window</title><h1>Other</h1><input aria-label='Field'>";

/** Two pages in a throwaway Chrome; the second can be hung for good. */
async function twoPages(): Promise<{ chrome: Awaited<ReturnType<typeof spawnChrome>>; hang: () => Promise<void> }> {
  const chrome = await spawnChrome({});
  const raw = await chromium.connectOverCDP(chrome.cdpUrl);
  const context = raw.contexts()[0]!;
  const main = context.pages()[0] ?? await context.newPage();
  await main.goto(MAIN);
  await (await context.newPage()).goto(OTHER);
  await raw.close();
  return {
    chrome,
    hang: async () => {
      const again = await chromium.connectOverCDP(chrome.cdpUrl);
      const other = again.contexts()[0]!.pages().find((p) => p.url() === OTHER)!;
      await other.evaluate("setTimeout(() => { for (;;) {} }, 200)");
      await again.close();
      await sleep(600);
    },
  };
}

async function main() {
  // ── One window hung, another driven ──────────────────────────────────────────────────────
  {
    const { chrome, hang } = await twoPages();
    const driver = new ElectronDriver({ cdpUrl: chrome.cdpUrl });
    try {
      const tools = Object.fromEntries(createComputerUseTools([{ driver }], { ownership }).map((t) => [t.name, t]));
      const run = (code: string) => tools.computer_repl!.execute({ code, observation: "none" });
      const bound = await timed(run("const w = await computer.surface('Main window'); return w.title;"), 20_000);
      check("an app's window is bound while every window answers", !!bound && /Returned: Main window/.test(bound.text), bound ? head(bound.text) : "no answer");
      await hang();
      const clicked = await timed(run("return await w.click(await w.find('Do it', { role: 'button' }));"), 20_000);
      check("with another window hung, a verb on this one still answers",
        !!clicked && /Returned: click/.test(clicked.text) && clicked.ms < 8_000, clicked ? `${clicked.ms} ms: ${head(clicked.text)}` : "no answer in 20 s");
      const listed = await timed(run("return (await computer.surfaces()).map((s) => s.title);"), 20_000);
      check("...and the listing answers too, naming the hung window by its address",
        !!listed && listed.ms < 8_000 && /Returned: \[/.test(listed.text) && /Other/.test(listed.text), listed ? `${listed.ms} ms: ${listed.text.split("\n").find((l) => l.startsWith("Returned")) ?? head(listed.text)}`.slice(0, 260) : "no answer in 20 s");
    } finally {
      await driver.closeWithin(3_000);
      chrome.cleanup();
    }
  }

  // ── A call that does not come back ───────────────────────────────────────────────────────
  {
    const { chrome, hang } = await twoPages();
    process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
    const driver = new BrowserDriver(chrome.cdpUrl);
    try {
      // A short clock, so a stuck call is ended in seconds: 2 s of work, then 2 s of patience.
      const tools = Object.fromEntries(createComputerUseTools([{ driver }], { ownership, maxMs: 2_000, stuckGraceMs: 2_000 }).map((t) => [t.name, t]));
      const run = (code: string) => tools.computer_repl!.execute({ code, observation: "none" });

      const waiting = await timed(run("globalThis.kept = 1; await new Promise(() => {}); return 'never';"), 15_000);
      check("a call waiting on something that is not a verb is ended, saying so",
        !!waiting && /Run STOPPED/.test(waiting.text) && /not a verb/.test(waiting.text) && /fresh runtime/.test(waiting.text) && waiting.ms < 8_000,
        waiting ? `${waiting.ms} ms: ${head(waiting.text)}` : "no answer in 15 s");
      const after = await timed(run("return typeof kept;"), 10_000);
      check("the next call runs, in a fresh runtime", !!after && /Returned: undefined/.test(after.text), after ? head(after.text) : "no answer");

      // A page whose script never returns does not answer a key press, and nothing times it out.
      const tabs = await timed(run("return (await computer.surfaces()).map((s) => s.id + ' ' + s.title);"), 10_000);
      const otherId = /"(t\d+) Other window"/.exec(tabs?.text ?? "")?.[1] ?? "";
      await timed(run(`const o = await computer.surface('${otherId}'); await o.click(await o.find('Field')); return 1;`), 10_000);
      await hang();
      const pressed = await timed(run("await o.keys('a'); return 'typed';"), 25_000);
      check("a verb the page never answers is ended by name, with what is known about it",
        !!pressed && /Run STOPPED/.test(pressed.text) && /keys had not come back/.test(pressed.text) && /unknown/.test(pressed.text),
        pressed ? `${pressed.ms} ms: ${head(pressed.text)}` : "no answer in 25 s");
      // The hung tab is closed, as the person whose browser it is would close it: connecting to
      // a browser waits on every tab, and getting past one that answers nothing is its own matter
      // (the managed browser closes it itself, managed-stalled-tab).
      const targets = await (await fetch(`${chrome.cdpUrl}/json/list`)).json() as Array<{ id: string; url: string }>;
      await fetch(`${chrome.cdpUrl}/json/close/${targets.find((t) => t.url === OTHER)!.id}`);
      await sleep(800);
      const next = await timed(run(`const m = await computer.surface('Main window'); return await m.click(await m.find('Do it', { role: 'button' }));`), 20_000);
      check("...and the next call binds another tab and acts on it",
        !!next && /Returned: click/.test(next.text), next ? `${next.ms} ms: ${head(next.text)}` : "no answer in 20 s");

      // Code that swallows a cap: refusing its every verb would hand it an error to catch, and
      // the loop would then never yield again.
      const looping = await timed(run("const m2 = await computer.surface(); while (true) { try { await m2.observe(); } catch {} }"), 15_000);
      // Whichever cap it meets first (a hundred observes take half a second here).
      check("code that catches a cap and calls on is ended instead of spinning",
        !!looping && /Run STOPPED/.test(looping.text) && /(step|time) cap reached/.test(looping.text) && looping.ms < 8_000,
        looping ? `${looping.ms} ms: ${head(looping.text)}` : "no answer in 15 s");
      const alive = await timed(run("return 2 + 2;"), 10_000);
      check("...and the runtime still answers", !!alive && /Returned: 4/.test(alive.text), alive ? head(alive.text) : "no answer");
    } finally {
      await driver.closeWithin(3_000);
      chrome.cleanup();
    }
  }

  // ── Over the server: a turn's end, and a shutdown ────────────────────────────────────────
  {
    const chrome = await spawnChrome({});
    const TSX_CLI = fileURLToPath(import.meta.resolve("tsx/cli"));
    const server: ChildProcess = spawn(process.execPath, [TSX_CLI, join(ROOT, "src/entries/cli.ts"), "mcp"], {
      cwd: ROOT, stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, COMPUTER_USE_CDP_URL: chrome.cdpUrl, COMPUTER_USE_ENDING_WAIT_MS: "1000" },
    });
    const replies = new Map<number, { result?: { isError?: boolean; content?: Array<{ text?: string }> } }>();
    let buffer = "";
    server.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n").slice(0, -1)) {
        if (!line.trim()) continue;
        try { const message = JSON.parse(line); if (typeof message.id === "number") replies.set(message.id, message); } catch { /* not ours */ }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
    const send = (id: number, method: string, params: object) => server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const reply = async (id: number, capMs: number): Promise<string | null> => {
      for (const end = Date.now() + capMs; Date.now() < end;) {
        const r = replies.get(id);
        if (r) return (r.result?.content ?? []).map((c) => c.text ?? "").join("\n").split("\nAPI reference")[0]!;
        await sleep(50);
      }
      return null;
    };
    const call = (id: number, name: string, args: object) => send(id, "tools/call", { name, arguments: args });
    let exited: number | null | undefined;
    server.once("exit", (code) => { exited = code; });
    try {
      send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stuck-call", version: "0" } });
      await reply(1, 30_000);
      server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      call(2, "computer_repl", { code: "return 1 + 1;", observation: "none" });
      check("the server answers a call", /Returned: 2/.test((await reply(2, 30_000)) ?? ""));

      call(3, "computer_repl", { code: "await new Promise(() => {}); return 'never';", observation: "none" });
      await sleep(500);
      const started = Date.now();
      call(4, "turn_ended", { session_id: "s", turn_id: "t1" });
      const ended = await reply(4, 15_000);
      check("ending the turn does not wait on a call that is stuck",
        !!ended && /turn_ended applied/.test(ended) && Date.now() - started < 8_000, `${ended} after ${Date.now() - started} ms`);
      const stuck = await reply(3, 5_000);
      check("...and the stuck call is answered, saying the host ended the turn", !!stuck && /Run STOPPED/.test(stuck) && /host ended the turn/.test(stuck), head(stuck ?? "no answer"));
      call(5, "computer_repl", { code: "return 3 + 3;", observation: "none" });
      const later = await reply(5, 20_000);
      check("the server takes calls after that turn", !!later && /Returned: 6/.test(later), head(later ?? "no answer in 20 s"));

      call(6, "computer_repl", { code: "await new Promise(() => {}); return 'never';", observation: "none" });
      await sleep(500);
      const told = Date.now();
      server.kill("SIGTERM");
      for (const end = Date.now() + 15_000; exited === undefined && Date.now() < end;) await sleep(50);
      check("SIGTERM ends the server while a call is stuck", exited !== undefined && Date.now() - told < 10_000,
        exited === undefined ? "still running after 15 s" : `exit ${exited} after ${Date.now() - told} ms`);
    } finally {
      if (exited === undefined) server.kill("SIGKILL");
      chrome.cleanup();
    }
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall stuck-call checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
