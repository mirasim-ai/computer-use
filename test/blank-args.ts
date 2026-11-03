/**
 * Blank-argument normalization test (`node scripts/test.mjs blank-args`).
 *
 * Some models materialize EVERY property of a tool schema instead of omitting the ones they do not
 * mean. Measured with a GPT model on a public homepage: 16 of 53 calls were refused
 * by our own argument validation because the guards read presence, not intent.
 * `withoutBlankOptionals` (tools/normalize.ts) is the answer, and it runs once at the tool boundary
 * — `guarded` in tools/index.ts — ahead of validation.
 *
 * The shapes below are the ones that run produced, replayed against schemas of the same shape:
 * blank optionals, an all-zero region, a REQUIRED blank that is a real value, a discriminated
 * union, a flattened wrapper, an array that must not be walked. Then the boundary itself, on the
 * one tool a session registers. Hermetic: a stub driver, no browser.
 */

import { Type } from "typebox";
import { ComputerUseDriver } from "../src/platform/driver.ts";
import { createComputerUseTools } from "../src/platform/tools/index.ts";
import { withoutBlankOptionals } from "../src/platform/tools/normalize.ts";
import type { ActResult, Element, Snapshot, TargetInfo } from "../src/platform/types.ts";

const EL: Element = { ref: "e1", role: "textbox", name: "Email", state: "empty", rect: { x: 0, y: 0, w: 100, h: 20 } };

class StubDriver extends ComputerUseDriver {
  readonly platform = "stub";
  protected snapshot(): Promise<Snapshot> {
    return Promise.resolve({ url: "u", title: "t", elements: [EL], text: "body", meta: { scrollY: 0, viewportH: 800, docH: 800 } });
  }
  screenshot(): Promise<Buffer> { return Promise.resolve(Buffer.from("img")); }
  readText(): Promise<string> { return Promise.resolve("page body"); }
  listTargets(): Promise<TargetInfo[]> { return Promise.resolve([{ id: "t1", kind: "tab", title: "t", active: true }]); }
  focusTarget(): Promise<ActResult> { return Promise.resolve({ ok: true }); }
  perform(): Promise<ActResult> { return Promise.resolve({ ok: true, verified: true }); }
  close(): Promise<void> { return Promise.resolve(); }
  promptFragment(): string { return ""; }
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const json = (v: unknown) => JSON.stringify(v);

/** The observe arguments exactly as the model sent them: every optional materialized. */
const LOOK = Type.Object({
  what: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  node: Type.Optional(Type.String()),
  depth: Type.Optional(Type.Integer()),
  region: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() })),
  fullPage: Type.Optional(Type.Boolean()),
});
const BLANK_LOOK = { what: "text", depth: 4, fullPage: false, node: "", query: "", ref: "", region: { height: 0, width: 0, x: 0, y: 0 } };

/** A discriminated action union: `text` is REQUIRED for set_text and optional for wait. */
const ACTION = Type.Union([
  Type.Object({ kind: Type.Literal("set_text"), ref: Type.Optional(Type.String()), name: Type.Optional(Type.String()), text: Type.String() }),
  Type.Object({ kind: Type.Literal("wait"), ms: Type.Optional(Type.Number()), text: Type.Optional(Type.String()), text_gone: Type.Optional(Type.String()) }),
]);
const ACT = Type.Object({ action: Type.Optional(ACTION), then: Type.Optional(Type.Array(Type.Object({ do: Type.String(), ref: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }))) });

async function main(): Promise<void> {
  // ── Blank optionals carry no intent ──────────────────────────────────────────────────
  const look = withoutBlankOptionals(BLANK_LOOK, LOOK) as Record<string, unknown>;
  check("blank optional strings are dropped", !("query" in look) && !("ref" in look) && !("node" in look), json(look));
  check("an all-zero region is dropped — no caller can mean that crop", !("region" in look), json(look));
  check("real values stay: what, depth, and a false boolean", look.what === "text" && look.depth === 4 && look.fullPage === false, json(look));
  check("the original is untouched — the transcript keeps what the model sent", BLANK_LOOK.query === "" && BLANK_LOOK.region.width === 0);

  // ── The union: required blanks are real values, optional blanks are not ─────────────
  const clear = withoutBlankOptionals({ action: { kind: "set_text", ref: "e1", name: "", text: "" } }, ACT) as { action: Record<string, unknown> };
  check("set_text text:'' survives — a required blank clears the field", clear.action.text === "", json(clear));
  check("the optional name:'' beside it is dropped", !("name" in clear.action), json(clear));
  const wait = withoutBlankOptionals({ action: { kind: "wait", ms: 3000, text: "AI will have a vast impact", text_gone: "" } }, ACT) as { action: Record<string, unknown> };
  check("wait's blank text_gone is dropped, its real text stays", wait.action.text_gone === undefined && wait.action.text === "AI will have a vast impact", json(wait));
  const flat = withoutBlankOptionals({ kind: "wait", ms: 3000, text: "ready", text_gone: "" }, ACT) as Record<string, unknown>;
  check("a FLATTENED action (the wrapper omitted) is normalized by the variant it matches", flat.text_gone === undefined && flat.text === "ready", json(flat));

  // ── Arrays are not walked: one step shape covers several verbs, so `required` says nothing ──
  const seq = withoutBlankOptionals({ action: { kind: "wait", ms: 1 }, then: [{ do: "set_text", ref: "e1", text: "" }] }, ACT) as { then: Array<Record<string, unknown>> };
  check("a blank inside an array step is left alone", seq.then[0]!.text === "", json(seq.then));

  // ── The boundary itself, on the tool a session actually registers ────────────────────
  const [repl] = createComputerUseTools({ driver: new StubDriver() });
  const blankCode = await repl!.execute({ code: "   " } as never);
  check("computer_repl with blank code is answered, not thrown", blankCode.details.error === "bad_args", String(blankCode.details.error));
  const runs = await repl!.execute({ code: "return 1;", extra: "" } as never);
  check("a blank property the schema does not know is harmless", runs.details.error === undefined && /Returned: 1/.test(runs.content.map((c) => c.type === "text" ? c.text : "").join("\n")),
    String(runs.details.error ?? "ok"));
  const wrongType = await repl!.execute({ code: 42 } as never);
  check("a wrong type is refused by the schema, in a sentence", wrongType.details.error === "bad_arguments" && /invalid arguments for computer_repl/.test(wrongType.content[0]!.type === "text" ? wrongType.content[0]!.text : ""),
    String(wrongType.details.error));

  console.log(failures === 0 ? "\nblank-args: all checks passed" : `\nblank-args: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
