/**
 * A call its client cancelled ends, and what comes after it works —
 * `node scripts/test.mjs cancelled-call`.
 *
 * An MCP client takes a request back with `notifications/cancelled` (its user stopped the turn,
 * or its own timeout ran out). The answer is then nobody's, but the call used to run on to its
 * own end all the same, a 30 s wait for the whole 30 s, and every later call queued behind it.
 *
 * Hermetic, over the stubbed macOS helper (the contract is the shared tool layer's):
 *
 *   · a call cancelled while a verb is out lets that verb finish and starts no other, and the
 *     runtime it leaves is the one the next call runs in;
 *   · code that swallows that stop and calls on is ended rather than left running;
 *   · a call still out after the grace is ended, by name when it is a verb that had not come
 *     back, and the next call runs in a fresh runtime;
 *   · a call cancelled while it waited its turn is never started;
 *   · the API reference a session's first answer carries is not spent on an answer nobody reads;
 *   · a call nobody cancelled is answered as before, with its observation.
 */

import { MacosDriver } from "../src/platform/macos/driver.ts";
import { createComputerUseTools } from "../src/platform/tools/index.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
type Result = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const allText = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").split("\nAPI reference")[0]!;
const head = (s: string) => s.split("\n")[0]!.slice(0, 240);
const ownership = { claim: async () => {}, release: async () => {}, releaseAll: async () => {} };

/** How long a cancelled call may stay out here before it is ended. */
const GRACE_MS = 300;

function session() {
  const driver = new MacosDriver({ transport: stubTransport().transport, ...ONE_APP });
  const tools = Object.fromEntries(createComputerUseTools([{ driver }], { ownership, cancelGraceMs: GRACE_MS }).map((t) => [t.name, t]));
  /** Run `code`; with `cancelAfterMs`, as a client that takes the call back that long into it. */
  const run = async (code: string, cancelAfterMs?: number, observation = "none") => {
    const cancel = new AbortController();
    const timer = cancelAfterMs === undefined ? undefined : setTimeout(() => cancel.abort(), cancelAfterMs);
    const started = Date.now();
    try {
      const r = await tools.computer_repl!.execute({ code, observation, interaction: "desktop" } as never, { signal: cancel.signal }) as Result;
      return { text: allText(r), details: r.details, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  };
  return { driver, tools, run };
}
const BIND = "w = await computer.surface('49403:62106'); await w.observe(); return 'bound'";

async function main() {
  // The timers that end a call are unref'd (they must not keep a server alive), and a call
  // waiting on a promise nothing settles leaves this process nothing else to stay up for.
  setInterval(() => {}, 1_000);

  // ── Cancelled while a verb is out ────────────────────────────────────────────────────────
  {
    const s = session();
    await s.run(BIND);
    const r = await s.run("globalThis.kept = 1; await w.wait({ ms: 150 }); globalThis.after = 1; await w.observe(); globalThis.reached = 1; return 'done';", 40);
    check("a call cancelled while a verb is out stops at its next verb, saying who stopped it",
      /Run STOPPED/.test(r.text) && /the client cancelled this call, so it stops before its next operation/.test(r.text) && r.ms < GRACE_MS + 150,
      `${r.ms} ms: ${head(r.text)}`);
    check("...is not observed for an answer nobody reads", /Observation skipped: the client cancelled this call/.test(r.text) && r.details.cancelled === true,
      r.text.split("\n").slice(-1)[0]!);
    const next = await s.run("return [typeof kept, typeof after, typeof reached, w.id].join(' ');");
    check("...and the next call runs in the same runtime, with the verb that was out finished and nothing after it run",
      /Returned: number number undefined 49403:62106/.test(next.text), next.text.split("\n").find((l) => l.startsWith("Returned")) ?? head(next.text));

    // Code that catches the stop would otherwise spin on it, with every verb refused again.
    const swallowed = await s.run("await w.wait({ ms: 150 }); while (true) { try { await w.observe(); } catch {} }", 40);
    check("code that swallows the stop and calls on is ended", /Run STOPPED/.test(swallowed.text) && /the client cancelled this call/.test(swallowed.text) && swallowed.ms < 2_000,
      `${swallowed.ms} ms: ${head(swallowed.text)}`);
    const alive = await s.run("return 2 + 2;");
    check("...and the next call is answered", /Returned: 4/.test(alive.text), head(alive.text));
    await s.driver.close();
  }

  // ── Still out after the grace ────────────────────────────────────────────────────────────
  {
    const s = session();
    await s.run(BIND);
    const waiting = await s.run("globalThis.kept = 1; await new Promise(() => {}); return 'never';", 40);
    check("a cancelled call waiting on something that is not a verb is ended after the grace",
      /Run STOPPED/.test(waiting.text) && /the client cancelled this call, and the code had not come back/.test(waiting.text)
        && /fresh runtime/.test(waiting.text) && waiting.ms >= GRACE_MS && waiting.ms < GRACE_MS + 1_500,
      `${waiting.ms} ms: ${head(waiting.text)}`);
    const after = await s.run("return typeof kept;");
    check("...and the next call runs, in a fresh runtime", /Returned: undefined/.test(after.text), head(after.text));

    await s.run(BIND);
    const verb = await s.run("await w.wait({ ms: 1500 }); return 'never';", 40);
    check("a cancelled call whose verb does not come back within the grace is ended by that verb's name",
      /Run STOPPED/.test(verb.text) && /the client cancelled this call, and wait had not come back/.test(verb.text) && /unknown/.test(verb.text) && verb.ms < 4_000,
      `${verb.ms} ms: ${head(verb.text)}`);
    const rebound = await s.run(BIND);
    check("...and the surface is bound again by the next call", /Returned: bound/.test(rebound.text), head(rebound.text));
    await s.driver.close();
  }

  // ── Cancelled while it waited its turn ───────────────────────────────────────────────────
  {
    const s = session();
    await s.run(BIND);
    const first = s.run("await w.wait({ ms: 200 }); return 'first';");
    const queued = s.run("globalThis.ran = 1; return 'queued';", 20);
    const [a, b] = await Promise.all([first, queued]);
    check("the call ahead of a cancelled one is answered as usual", /Returned: first/.test(a.text), head(a.text));
    check("a call cancelled while it waited its turn is never started", /cancelled by the client before it started/.test(b.text) && b.details.error === "cancelled", head(b.text));
    const ran = await s.run("return typeof ran;");
    check("...so nothing of it ran", /Returned: undefined/.test(ran.text), head(ran.text));
    await s.driver.close();
  }

  // ── What the first answer owes its reader ────────────────────────────────────────────────
  {
    const s = session();
    const reference = (r: unknown) => (r as Result).content.some((c) => c.type === "text" && /API reference/.test(c.text ?? ""));
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 40);
    const first = await s.tools.computer_repl!.execute({ code: `${BIND.replace("return 'bound'", "await w.wait({ ms: 150 }); return 'bound'")}`, observation: "none", interaction: "desktop" } as never, { signal: cancel.signal });
    const second = await s.tools.computer_repl!.execute({ code: "return 1;", observation: "none", interaction: "desktop" } as never);
    check("a session's first call, cancelled, does not carry the API reference away with it", !reference(first) && reference(second),
      `cancelled: ${reference(first)}, next: ${reference(second)}`);
    await s.driver.close();
  }

  // ── Nobody cancelled ─────────────────────────────────────────────────────────────────────
  {
    const s = session();
    const r = await s.run(BIND, undefined, "full");
    check("a call nobody cancelled is answered with its observation",
      /Run completed/.test(r.text) && /Returned: bound/.test(r.text) && !/cancelled/.test(r.text) && r.details.cancelled === undefined && r.text.split("\n").length > 4,
      head(r.text));
    await s.driver.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall cancelled-call checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
