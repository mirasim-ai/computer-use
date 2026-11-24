/**
 * How long a request to the macOS helper may take — `node scripts/test.mjs macos-helper-limits`.
 *
 * Each request gets its own execution budget. A late reply is distinguished from a dead
 * helper before retiring the process; launch has a longer budget for a slow cold start.
 *
 * Hermetic: a script stands in for the helper and answers each request after the delay the
 * request names.
 */

import { spawn } from "node:child_process";
import { AxHelperProcess, type SpawnFn } from "../src/platform/macos/ax-client.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Answers `{id, ok, result: {op}}` after the request's own `after` ms. */
const SLOW_HELPER = `
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, op, after } = JSON.parse(line);
    setTimeout(() => process.stdout.write(JSON.stringify({ id, ok: true, result: { op, pid: process.pid } }) + "\\n"), after);
  });
  // Asked to stop (its stdin closed), the real helper exits at once.
  process.stdin.on("end", () => process.exit(0));
`;
const fake = ((_bin: string, _args: readonly string[], options: object) => spawn(process.execPath, ["-e", SLOW_HELPER], options)) as unknown as SpawnFn;

async function main() {
  const CEILING = 400;
  const helper = new AxHelperProcess({ bin: "unused", spawn: fake, timeoutMs: CEILING, env: {} });
  try {
    const quick = await helper.request("apps", { after: 10 }) as { op: string; pid: number };
    check("a request answered in time is answered", quick.op === "apps");

    const t0 = Date.now();
    const launched = await helper.request("launch", { bundle: "com.example.slow", after: CEILING * 4 }).then((r) => r as { op: string }, (e: Error) => e);
    check("a launch that takes longer than the ordinary ceiling is still answered",
      !(launched instanceof Error) && launched.op === "launch", launched instanceof Error ? launched.message : `${Date.now() - t0} ms`);
    const after = await helper.request("apps", { after: 10 }).then((r) => r as { op: string }, (e: Error) => e);
    check("...and the helper was not stopped for it", !(after instanceof Error) && after.op === "apps", after instanceof Error ? after.message : "");

    const t1 = Date.now();
    const hung = await helper.request("tree", { after: CEILING * 4 }).then(() => null, (e: Error) => e);
    check("a late request times out without retiring a responding helper",
      hung instanceof Error && /'tree' did not answer within 400 ms; its outcome is uncertain/.test(hung.message) && Date.now() - t1 < CEILING * 3,
      hung instanceof Error ? `${hung.message} (${Date.now() - t1} ms)` : "answered");
    const recovered = await helper.request("tree", { after: 1 }) as { pid: number };
    check("the next read succeeds on the live helper", recovered.pid === quick.pid);
    const queuedAt = Date.now();
    const first = helper.request("tree", { after: 260 });
    const second = helper.request("tree", { after: 260 });
    const replies = await Promise.all([first, second]);
    check("two individually healthy reads receive full budgets in FIFO order", replies.length === 2 && Date.now() - queuedAt >= 500);
  } finally {
    await helper.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall macos-helper-limits checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
