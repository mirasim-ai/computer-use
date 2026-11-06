/**
 * Cross-runtime ownership — `node scripts/test.mjs ownership`.
 *
 * Hermetic, over the stubbed macOS helper and the real claims database (the runner gives every
 * suite a scratch HOME, so `~/.mirasim-computer-use/ownership` is this run's own):
 *
 *   · a runtime with no call in progress lets go of its claims once it has been idle, and never
 *     while a call runs;
 *   · its next call takes the target back when nobody else did, and is refused when another
 *     runtime took it meanwhile — the stale-MCP-server case: a host that keeps an idle server
 *     alive must not hold a window from the next session.
 */

import { MacosDriver } from "../src/platform/macos/driver.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";
import { createComputerUseTools } from "../src/platform/tools/index.ts";
import { ComputerUseOwnership, type OwnershipProvider } from "../src/platform/ownership.ts";
import type { OwnershipResource } from "../src/platform/types.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";
const IDLE_MS = 80;

function runtime(ownership: OwnershipProvider) {
  const driver = new MacosDriver({ transport: stubTransport().transport, ...ONE_APP });
  const tools = Object.fromEntries(createComputerUseTools([{ driver }], { ownership, idleReleaseMs: IDLE_MS }).map((t) => [t.name, t]));
  const run = async (code: string) => firstText(await tools.computer_repl!.execute({ code, observation: "brief" }) as never);
  return { driver, run };
}

async function main() {
  // ── The idle clock, against a recording provider ─────────────────────────────────────
  {
    const log: string[] = [];
    const ownership = {
      claim: async (group: string, _rs: OwnershipResource[]) => { log.push(`claim ${group}`); },
      release: async (group: string) => { log.push(`release ${group}`); },
      releaseAll: async () => { log.push("releaseAll"); },
    };
    const a = runtime(ownership);
    await a.run("w = await computer.surface('49403:62106'); await w.observe(); return 1");
    check("binding a surface claims it", log.some((l) => l.startsWith("claim macos:")), log.join(" | "));
    const released = () => log.filter((l) => l === "releaseAll").length;
    check("…and the claim is still held right after the call", released() === 0, log.join(" | "));

    // A call that outlasts the idle limit: the clock is between calls, never inside one.
    await a.run(`await w.wait({ms: ${IDLE_MS * 3}}); return 1`);
    check("a call longer than the idle limit keeps its claims while it runs", released() === 0, log.join(" | "));

    await sleep(IDLE_MS * 3);
    check("an idle runtime lets go of its claims", released() === 1, log.join(" | "));
    await sleep(IDLE_MS * 2);
    check("…once, not on every tick", released() === 1, log.join(" | "));

    const before = log.filter((l) => l.startsWith("claim ")).length;
    const back = await a.run("await w.observe(); return 'back'");
    check("the next call through the same handle takes the target back",
      /Returned: "?back"?/.test(back) && log.filter((l) => l.startsWith("claim ")).length > before, back.split("\n")[0]);

    await sleep(IDLE_MS / 2);
    await a.run("return 2");
    await sleep(IDLE_MS / 2 + 10);
    check("a call within the limit restarts the clock", released() === 1, log.join(" | "));
    await a.driver.close();
  }

  // ── Two runtimes on the real claims database ─────────────────────────────────────────
  {
    const a = runtime(new ComputerUseOwnership());
    const b = runtime(new ComputerUseOwnership());
    const bind = "w = await computer.surface('49403:62106'); await w.observe(); return 'bound'";
    check("runtime A binds the window", /Returned: "?bound"?/.test(await a.run(bind)));
    const refused = await b.run(bind);
    check("runtime B is refused while A holds it", /in use by another runtime/.test(refused), refused.split("\n")[0]);

    await sleep(IDLE_MS * 3);
    const took = await b.run(bind);
    check("once A has been idle, B takes the window", /Returned: "?bound"?/.test(took), took.split("\n")[0]);
    const lost = await a.run("await w.observe(); return 'again'");
    check("…and A's next call is refused instead of acting under B", /in use by another runtime/.test(lost), lost.split("\n")[0]);
    await a.driver.close();
    await b.driver.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall ownership checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
