/**
 * Giving held input back when a session ends — `node scripts/test.mjs macos-cleanup`.
 *
 * A stepwise drag leaves a mouse button held between calls. Whatever ends the session (a reset,
 * the end of a turn, two idle minutes) has to bring it up, and used to do so as an ordinary
 * action: resolve the app, check it is still cleared, then release. Cleanup runs exactly when
 * those no longer hold, so with the app quit the release threw, the reset was left half done and
 * the session's claims stayed.
 *
 * Hermetic, over the stubbed helper with a pointer added to it:
 *
 *   · a held button is released although its app has quit, asking the helper for nothing else;
 *   · a clearance the user gave for one call only is not asked for again at cleanup;
 *   · a reset completes and lets go of every claim, also when the helper itself cannot be
 *     reached;
 *   · a press the driver refused (background mode) leaves nothing to release.
 */

import { MacosDriver } from "../src/platform/macos/driver.ts";
import { AxRequestError } from "../src/platform/macos/ax-errors.ts";
import { createComputerUseTools } from "../src/platform/tools/index.ts";
import type { OwnershipResource } from "../src/platform/types.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) => r.content.find((c) => c.type === "text")?.text ?? "";

/** The stubbed helper plus the pointer ops it lacks, an app that can quit and a helper that can break. */
function withPointer() {
  const stub = stubTransport();
  const pointer = { down: false, released: 0, appGone: false, broken: false, asked: [] as string[] };
  const transport = {
    ...stub.transport,
    async request(op: string, params: Record<string, unknown> = {}) {
      pointer.asked.push(op);
      if (pointer.broken) throw new AxRequestError("ax_error", "the helper cannot be reached");
      if (op === "ptrstate") return { x: 10, y: 10, down: pointer.down, owned: true, grabbed: pointer.down };
      if (op === "ptrpress") { pointer.down = true; return { x: 10, y: 10, button: String(params.button ?? "left") }; }
      if (op === "ptrrelease") { const was = pointer.down; pointer.down = false; pointer.released += 1; return { x: 10, y: 10, wasHolding: was }; }
      if (pointer.appGone && op !== "capabilities") throw new AxRequestError("ax_error", "the app is not running");
      return stub.transport.request(op, params);
    },
  };
  return { transport, pointer };
}

function session(interaction: "desktop" | "background" = "desktop", perCall = false) {
  const { transport, pointer } = withPointer();
  // A user who allows the app for the call that asks, and no longer than that.
  const asks: string[] = [];
  const consent = {
    available: () => true,
    ask: async (message: string) => { asks.push(message); return asks.length === 1 ? { allowed: true } : { allowed: false, reason: "asked again at cleanup" }; },
    onRevoke: () => {},
  };
  const driver = new MacosDriver({ transport, ...ONE_APP, ...(perCall ? { consent } : {}) });
  const log: string[] = [];
  const ownership = {
    claim: async (group: string, _rs: OwnershipResource[]) => { log.push(`claim ${group}`); },
    release: async (group: string) => { log.push(`release ${group}`); },
    releaseAll: async () => { log.push("releaseAll"); },
  };
  const tools = Object.fromEntries(createComputerUseTools([{ driver }], { ownership, idleReleaseMs: 60_000 }).map((t) => [t.name, t]));
  // The mode is the call's: the driver stays in it between calls, as it does for a real session.
  const run = async (code: string) => firstText(await tools.computer_repl!.execute({ code, observation: "none", interaction }) as never);
  const reset = () => tools.computer_repl_reset!.execute({}).then((r) => firstText(r as never), (e: Error) => `threw: ${e.message}`);
  return { driver, pointer, log, run, reset, asks };
}
const BIND = "w = await computer.surface('49403:62106'); await w.observe(); return 'bound'";

async function main() {
  // ── The app quit while a button was held ─────────────────────────────────────────────────
  {
    const s = session();
    await s.run(BIND);
    const pressed = await s.driver.perform("pointer_press", {});
    check("a press holds the button", pressed.ok && s.pointer.down, pressed.note ?? "");
    s.pointer.appGone = true;
    s.pointer.asked.length = 0;
    const released = await s.driver.releaseInputResources().then(() => "released", (e: Error) => `threw: ${e.message}`);
    check("the held button is released although its app has quit", released === "released" && !s.pointer.down && s.pointer.released === 1, released);
    check("...asking the helper for nothing but the pointer", s.pointer.asked.every((op) => op === "ptrstate" || op === "ptrrelease"), s.pointer.asked.join(", "));
    await s.driver.close();
  }

  // ── The app was allowed for one call only ────────────────────────────────────────────────
  {
    const s = session("desktop", true);
    s.driver.interactionMode = "desktop";
    const pressed = await s.driver.perform("pointer_press", {});
    check("a press in a call the user allowed the app for holds the button", pressed.ok && s.pointer.down && s.asks.length === 1, `asked ${s.asks.length} time(s)`);
    s.driver.endCall(); // the call is over, and with it what was allowed for that call alone
    const said = await s.reset();
    check("the reset after it releases the button without asking for the app again", /runtime was reset/.test(said) && !s.pointer.down && s.asks.length === 1,
      `${said.split("\n")[0]!.slice(0, 70)}; asked ${s.asks.length} time(s), ${s.pointer.released} release(s)`);
    check("...and lets go of every claim", s.log.includes("releaseAll"), s.log.join(" | "));
    await s.driver.close();
  }

  // ── A reset after the app quit ───────────────────────────────────────────────────────────
  {
    const s = session();
    await s.run(BIND);
    await s.driver.perform("pointer_press", {});
    s.pointer.appGone = true;
    const said = await s.reset();
    check("a reset completes with the app gone", /runtime was reset/.test(said), said.split("\n")[0]);
    check("...having released the button and every claim", !s.pointer.down && s.log.includes("releaseAll"), `${s.pointer.released} release(s); ${s.log.join(" | ")}`);
    await s.driver.close();
  }

  // ── A reset when the helper itself is out of reach ───────────────────────────────────────
  {
    const s = session();
    await s.run(BIND);
    await s.driver.perform("pointer_press", {});
    s.pointer.broken = true;
    const said = await s.reset();
    check("a reset completes although the helper cannot be reached", /runtime was reset/.test(said), said.split("\n")[0]);
    check("...and still lets go of every claim", s.log.includes("releaseAll"), s.log.join(" | "));
    await s.driver.close().catch(() => {});
  }

  // ── A press that was refused ─────────────────────────────────────────────────────────────
  {
    const s = session("background");
    await s.run(BIND);
    const pressed = await s.driver.perform("pointer_press", {});
    check("background mode refuses the press before it is sent", !pressed.ok && !s.pointer.down, pressed.note?.slice(0, 80) ?? "");
    s.pointer.appGone = true;
    const said = await s.reset();
    check("a reset after a refused press completes, with nothing to release", /runtime was reset/.test(said) && s.pointer.released === 0 && s.log.includes("releaseAll"),
      `${said.split("\n")[0]}; ${s.pointer.released} release(s)`);
    await s.driver.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall macos-cleanup checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
