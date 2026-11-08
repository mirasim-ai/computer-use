/**
 * The API's CONTRACT with its caller: the verb names the script sees, the ledger the run is
 * charged against, the hooks a host may supply, and the shapes everything answers with. Types and
 * tiny pure helpers only, so a caller that needs the shape does not pay for `api.ts`.
 */

import type { ActResult, ToolResult } from "../types.ts";

/** Universal verbs, as functions. Names are camelCase because the script is JavaScript; the
 *  VERB names underneath never change (the `act(kind, …)` escape hatch takes the real ones). */
const SUGAR: Record<string, string> = {
  open_url: "openUrl",
  select_option: "selectOption",
  select_text: "selectText",
  launch_app: "launchApp",
  ax_action: "axAction",
  run_js: "runJs",
  text_gone: "textGone",
};
export const fnName = (kind: string) => SUGAR[kind] ?? kind.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

type ActionOutcome = "verified" | "dispatched" | "blocked" | "uncertain";
/** `ms`: from the step's first charge to its journal line. Never rendered to the model; it rides
 *  `details.timing` into the COMPUTER_USE_MCP_LOG file (repl.ts). */
export interface JournalLine { i: number; kind: string; target: string; ok: boolean; note: string; outcome?: ActionOutcome; ms?: number }

/** What one RUN keeps. The API is built once per session (the repl) or per run (a script);
 *  the ledger is always per run, which is why it is reached through a getter. */
export interface RunLedger {
  /** Called before every action. Throws when a cap is reached — that is how a run stops. */
  charge(kind: string): void;
  /** `read`: the verb only looked (a menu listing) — journaled, never counted as an action. */
  push(kind: string, target: string, ok: boolean, note: string, read?: boolean, outcome?: ActionOutcome): void;
  /** An image a read produced. It rides the run's result, since the script cannot see pixels. */
  attach(part: ToolResult["content"][number]): void;
  /** The write round this run is building ({@link ComputerUseDriver.noteWriteRound}): fields
   *  written, how many read back verified, and the last non-write verb. Handed to the driver
   *  before the next observation, so a frozen screen after a verified write is not blamed on it. */
  round?: WriteRound;
  /** What is left of the call's wall-clock budget, in ms — for a verb that WAITS by its own
   *  clock (run_js), which the cap checked before each verb cannot interrupt. */
  remainingMs?(): number;
}

export interface WriteRound { fields: number; verified: number; ended: string | null }

export interface ApiHooks {
  /** Every ref a read handed the script (observe / find). The repl records which surface minted it. */
  onRefs?(refs: string[]): void;
  /** Every ref the script is about to act on. The repl refuses one minted on another surface. */
  onTarget?(ref: string): void;
  beforeAction?(kind: string, args: Record<string, unknown>): Promise<void>;
}

/** The first line of an action's note — what one journal line has room for. */
export function noteOf(res: ActResult): string {
  return (res.note ?? "").split("\n")[0] ?? "";
}

/**
 * The options object a verb was handed, or a refusal naming what to write instead.
 *
 * JavaScript hands a string straight through: every property read misses, so the verb runs its
 * DEFAULT and reports success (`scroll('up')` scrolls down, `wait(2000)` waits for settle). The
 * schema-validated platform verbs already refuse this; this is the same check for the rest.
 */
export function options<T>(verb: string, value: unknown, shape: string): T {
  if (value === undefined || value === null) return {} as T;
  if (typeof value === "object" && !Array.isArray(value)) return value as T;
  throw new Error(`${verb} takes an options object, not ${typeof value === "string" ? JSON.stringify(value) : String(value)} — ${shape}`);
}

export const firstText = (r: ToolResult) => r.content.find((c) => c.type === "text")?.text ?? "";
export const firstLine = (r: ToolResult) => firstText(r).split("\n")[0] ?? "";
