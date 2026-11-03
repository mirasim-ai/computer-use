/**
 * MCP call-log test (`node scripts/test.mjs mcp-log`).
 *
 * The `mcp` entry is the one path that records nothing on its own: stdout is protocol-only
 * and `details` (url / verdict / elementCount) is consumed by the exit and dropped. The
 * COMPUTER_USE_MCP_LOG knob is the only way back to that evidence, so this test drives the real
 * server over stdio against a throwaway Chrome and asserts the file it leaves:
 *
 *   1. a `server_start` line naming the platforms and tool names;
 *   2. one `call` line per tool call, carrying the ARGUMENTS the host sent and the `details`
 *      the response threw away;
 *   3. a tool-declared failure (a stale ref) logged with `isError: true`;
 *   4. an unknown tool logged too — a host typo must not vanish silently;
 *   5. each computer_repl call's steps timed (`details.timing`), which the model's journal omits.
 *
 * Plus the one thing the handshake itself has to carry: the `instructions` a host learns
 * grounding from, since it never sees a system prompt.
 *
 * Two traps this test respects: the server does NOT exit on stdin EOF, so we kill it; and
 * replies come back OUT OF ORDER (a stale-ref check answers from memory while an observe waits
 * on the browser), so we wait on the set of ids, never on the last one sent.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnChrome } from "./helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Reply { id: number; result?: { isError?: boolean; instructions?: string; content?: Array<{ text?: string }> }; error?: unknown }

/** Send requests, resolve once every id has replied (order is not guaranteed). */
function rpc(proc: ChildProcess, requests: Array<Record<string, unknown>>, timeoutMs = 60000): Promise<Map<number, Reply>> {
  const wanted = new Set(requests.map((r) => r.id as number));
  const got = new Map<number, Reply>();
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ids ${[...wanted].join(",")}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      for (const line of buf.split("\n").slice(0, -1)) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as Reply;
        if (wanted.delete(msg.id)) got.set(msg.id, msg);
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
      if (wanted.size === 0) { clearTimeout(timer); proc.stdout!.off("data", onData); resolve(got); }
    };
    proc.stdout!.on("data", onData);
    for (const r of requests) proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
  });
}

const chrome = await spawnChrome();
const logDir = mkdtempSync(join(tmpdir(), "computer-use-mcplog-"));
// A subdirectory that does not exist yet: the knob must create its parent, not silently no-op.
const logFile = join(logDir, "nested", "calls.jsonl");

// `process.execPath` + tsx's own entry, never `npx`: npx re-enters npm, which enforces the
// repo's devEngines contract and fails the spawn on a mismatched Node before the server
// starts — a failure that reads as "the MCP server does not answer".
const TSX_CLI = fileURLToPath(import.meta.resolve("tsx/cli"));
const server = spawn(process.execPath, [TSX_CLI, join(ROOT, "src/entries/cli.ts"), "mcp"], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, COMPUTER_USE_CDP_URL: chrome.cdpUrl, COMPUTER_USE_MCP_LOG: logFile },
});

try {
  const init = await rpc(server, [{
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-log-test", version: "0" } },
  }]);
  // The handshake is the ONLY place this path can teach grounding: an MCP host runs its own
  // loop and never sees a system prompt, so a missing `instructions` means it learns the
  // addressing model (ref vs x/y, viewport clipping) by trial and error.
  const instructions = init.get(1)?.result?.instructions;
  check("initialize carries the grounding instructions",
    typeof instructions === "string" && instructions.includes("Act by ref") && instructions.includes("verbatim"),
    JSON.stringify(instructions ?? null));
  server.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // Sent together on purpose: the stale ref answers from memory while the observe waits on
  // Chrome, so the replies interleave — exactly the ordering trap the doc-comment names.
  // id 3 calls the OLD name on purpose: it must reach the same runtime (`w` from id 2) and be
  // logged under the listed name.
  const replies = await rpc(server, [
    { id: 2, method: "tools/call", params: { name: "computer_repl", arguments: { code: "w = (await computer.surfaces())[0]; await w.observe();" } } },
    { id: 3, method: "tools/call", params: { name: "computer_repl", arguments: { code: "await w.click('e999');" } } },
    { id: 4, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
  ]);
  check("every request answered", replies.size === 3);
  check("unknown tool answered with isError", replies.get(4)?.result?.isError === true);

  const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const start = lines.find((l) => l.type === "server_start");
  const calls = lines.filter((l) => l.type === "call");

  check("server_start line written", !!start, JSON.stringify(start ?? null));
  check("server_start names the configuration",
    start?.platforms === "browser" && Array.isArray(start?.tools) && start.tools.includes("computer_repl"));
  check("one call line per tool call", calls.length === 3, `got ${calls.length}`);
  check("every line is timestamped", lines.every((l) => typeof l.ts === "string" && !Number.isNaN(Date.parse(l.ts))));

  const [observe, stale] = calls.filter((c) => c.tool === "computer_repl");
  check("observe logs the arguments the host sent", observe?.args?.code === "w = (await computer.surfaces())[0]; await w.observe();", JSON.stringify(observe?.args));
  check("observe logs the details the MCP response drops",
    typeof observe?.details?.url === "string" && typeof observe?.details?.elementCount === "number",
    JSON.stringify(observe?.details));
  check("observe is not flagged an error", observe?.isError === false);
  check("duration is recorded", typeof observe?.ms === "number" && observe.ms >= 0);
  // Per-step timing rides the log only: the model reads the journal without it.
  const timing = observe?.details?.timing;
  check("the call's steps are timed in the log", Array.isArray(timing?.steps) && timing.steps.length > 0
    && timing.steps.every((st: { ms?: unknown }) => typeof st.ms === "number"), JSON.stringify(timing));
  check("the closing observation is timed apart from the steps", typeof timing?.observeMs === "number" && typeof timing?.runMs === "number",
    JSON.stringify(timing));
  const shown = replies.get(2)?.result as { content?: Array<{ text?: string }> } | undefined;
  check("the model's journal carries no step timing", !JSON.stringify(shown?.content ?? []).includes('"ms"')
    && !/\bms\b/.test(shown?.content?.[0]?.text?.split("\n").slice(0, 4).join(" ") ?? ""), shown?.content?.[0]?.text?.slice(0, 160));

  check("a run that stopped is logged as an error", stale?.isError === true && stale?.details?.error === "run_stopped",
    JSON.stringify(stale?.details));

  const unknown = calls.find((c) => c.tool === "no_such_tool");
  check("unknown tool logged too", unknown?.isError === true && unknown?.details?.error === "unknown_tool");
} finally {
  // The server does not exit on stdin EOF — ending stdin would hang here forever.
  server.kill("SIGKILL");
  chrome.cleanup();
  rmSync(logDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nmcp-log: OK" : `\nmcp-log: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
