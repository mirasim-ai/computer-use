/**
 * The suites' way into a driver.
 *
 * Two halves, both product code: verbs go through `createComputerUseApi` — the SAME object the repl
 * injects into a run, so a click here is the click a model gets — and every rendered answer
 * comes from the driver's own channels (`observeElements`, `observeImage`, `readPage`, …), the
 * text a model reads at the end of a run. The harness only wires the two together the way one
 * `computer_repl` step does: one verb, then the observation.
 *
 * Nothing here is a tool: no schema, no MCP spec, no argument normalization — those belong to
 * `computer_repl` and are covered by `test/repl.ts` and `test/blank-args.ts`. A suite that wants the
 * model-facing shape verbatim calls the repl tool instead.
 *
 * WHAT IT HANDS BACK — three surfaces, and they are not interchangeable:
 *   `observe(args)` / `act(kind, args)` / `targets()` return a rendered `ToolResult`; read the
 *     text out of it with `firstText` (below).
 *   `api.*` is the injected API itself, and every READ lives there and NOWHERE else:
 *     `api.text()`, `api.find(name)`, `api.page(opts)`, `api.screenshot(opts)`,
 *     `api.diagnostics(opts)`, `api.observe()`. There is no `h.text()`: a suite that wants the
 *     model's own rendering of a read goes through `observe`/`act` instead.
 *   `api.click/hover/setText/keys/scroll/...` act WITHOUT the trailing observation, so a suite
 *     that wants the verb's note and the observation uses `act(kind, args)`.
 */

import type { ComputerUseDriver } from "../src/platform/driver.ts";
import { createComputerUseApi, isReadVerb, type RunLedger, type WriteRound } from "../src/platform/tools/api.ts";
import { SurfaceGoneError, SurfaceUnreadableError, text, type ShotScope, type ToolResult } from "../src/platform/types.ts";

/** The repl's API as the suites call it: the universal verbs plus whatever the driver adds. */
type Box = { x: number; y: number; w: number; h: number };
export interface ComputerUseApi {
  observe(opts?: { screenshot?: boolean }): Promise<{ url: string; title: string;
    elements: Array<{ ref: string; role: string; name: string; state?: string; offscreen?: boolean; rect: Box }>;
    headings?: Array<{ name: string; level: number; rect: Box }> }>;
  find(name: string, scope?: { role?: string; within?: unknown; visible?: boolean; near?: string }): Promise<{ ref: string; name: string } | null>;
  text(): Promise<string>;
  value(t: unknown): Promise<string>;
  page(opts?: { ref?: string; depth?: number; node?: string }): Promise<string>;
  screenshot(opts?: ShotScope): Promise<string>;
  diagnostics(opts?: { id?: string }): Promise<string>;
  targets(): Promise<Array<{ id: string; kind: string; title: string; active: boolean }>>;
  // Every action answers with the driver's own note — "" when a clean dispatch had
  // nothing to report. setText and wait are the two that answer a QUESTION instead.
  click(t: unknown, opts?: Record<string, unknown>): Promise<string>;
  hover(t: unknown): Promise<string>;
  setText(t: unknown, value: unknown): Promise<boolean | undefined>;
  setTextBestEffort(t: unknown, value: unknown): Promise<boolean | undefined>;
  keys(chord: string, count?: number | { focus?: unknown }, opts?: { focus?: unknown }): Promise<string>;
  scroll(opts?: Record<string, unknown>): Promise<string>;
  wait(opts?: Record<string, unknown>): Promise<boolean>;
  focus(target: string): Promise<string>;
  act(kind: string, args?: Record<string, unknown>): Promise<string>;
  [verb: string]: unknown;
}

/** What a read asks for — one channel, chosen by `what`. */
export interface Look {
  what?: "elements" | "text" | "page" | "screenshot" | "full" | "diagnostics";
  query?: string;
  ref?: string;
  depth?: number;
  node?: string;
  id?: string;
  region?: { x: number; y: number; width: number; height: number };
  fullPage?: boolean;
  padding?: number;
  /** Focus this target first (a tab, a window, an app). */
  target?: string;
}

/** One verb's outcome, shaped like a tool result so `firstText(...)` and `.details` keep
 *  working across the suites: `ok` is whether it dispatched, `note` the driver's own words,
 *  and the text is the observation that followed (prefixed by the note when there is one) —
 *  or, when it did not dispatch, the reason, with the observation under it when one could
 *  still be read (the surface may have acted anyway). */
export interface Acted extends ToolResult {
  ok: boolean;
  note: string;
}

export interface Harness {
  api: ComputerUseApi;
  /** Image parts a READ attached to the run (screenshot(), observe({screenshot:true})). The repl
   *  pushes these onto its result; the harness only collects them so a suite can assert one
   *  arrived. Cleared by the suite, never by the harness. */
  attached: ToolResult["content"];
  /** A rendered read — what the model sees at the end of a run. */
  observe(look?: Look): Promise<ToolResult>;
  /** One verb through the repl's API, then the rendered observation. Never throws. */
  act(kind: string, args?: Record<string, unknown>): Promise<Acted>;
  /** The surfaces, rendered one per line as `<id> [<kind>] <title>`. */
  targets(): Promise<ToolResult>;
  /** The last note the ledger received: a verb's outcome, or a find() miss's reason. */
  lastNote(): string;
}

export function createHarness(driver: ComputerUseDriver, opts: { diagnostics?: boolean } = {}): Harness {
  if (opts.diagnostics && driver.supportsDiagnostics) driver.enableDiagnostics();

  // The ledger is where the API reports each verb's outcome; the harness keeps the last note
  // and, like a repl run, hands the driver the write round before the observation.
  let lastNote = "";
  const attached: ToolResult["content"] = [];
  const ledger: RunLedger & { round: WriteRound } = {
    charge() {},
    push(_kind, _target, _ok, note) { lastNote = note; },
    attach(part) { attached.push(part); },
    round: { fields: 0, verified: 0, ended: null },
  };
  const api = createComputerUseApi(driver, () => ledger) as unknown as ComputerUseApi;

  async function observe(look: Look = {}): Promise<ToolResult> {
    if (look.target) {
      const r = await driver.focusTarget(look.target);
      if (!r.ok) return text(`Cannot focus target: ${r.note}`, { error: "bad_target" });
    }
    if (look.query !== undefined) return driver.observeMatches(look.query);
    switch (look.what ?? "elements") {
      case "text": return driver.observeFullText();
      case "screenshot": {
        const scope: ShotScope = {
          ...(look.ref ? { ref: look.ref } : {}),
          ...(look.region ? { region: look.region } : {}),
          ...(look.fullPage ? { fullPage: true } : {}),
          ...(look.padding !== undefined ? { padding: look.padding } : {}),
        };
        const scoped = !!(scope.ref || scope.region || scope.fullPage || scope.padding !== undefined);
        if (scope.ref && !driver.knownRef(scope.ref)) return text(driver.staleRefNote(scope.ref), { error: "stale_ref" });
        return driver.observeImage({ modelInitiated: true, ...(scoped ? { scope } : {}) });
      }
      case "full": return driver.observeElements({ forceImage: true });
      case "diagnostics": return driver.readDiagnostics({ id: look.id });
      case "page":
        if (!driver.readPage) return text("page reading is not supported on this platform yet — use text()");
        return driver.readPage({ ref: look.ref, depth: look.depth, node: look.node });
      default: return driver.observeElements();
    }
  }

  /** The observation after a verb, worded for the verb — the same call a repl run ends with. A
   *  `kind` of null is a verb that only read (a menu listing): a look, with no verdict on an effect. */
  async function after(kind: string | null, prefix?: string): Promise<ToolResult> {
    const afterAction = kind ? { afterAction: kind } : {};
    try {
      return await driver.observeElements({ prefix, ...afterAction });
    } catch (e) {
      if ((e as { surfaceGone?: boolean }).surfaceGone) throw e;
      return text(`${prefix ?? ""}\n(re-observation failed: ${(e as Error).message})`.trim(), { verdict: "unknown" });
    }
  }

  async function act(kind: string, args: Record<string, unknown> = {}): Promise<Acted> {
    lastNote = "";
    ledger.round = { fields: 0, verified: 0, ended: null };
    // The API refuses an unknown ref by name before dispatch; the harness labels that refusal
    // so a suite can tell it from a verb the surface itself refused.
    const stale = typeof args.ref === "string" && !driver.knownRef(args.ref);
    let failure: string | null = null;
    try {
      if (kind === "wait") await api.wait(args);
      else if (kind === "focus") await api.focus(String(args.target ?? ""));
      else await api.act(kind, args);
    } catch (e) {
      failure = (e as Error).message;
    }
    if (failure !== null) {
      driver.noteWriteRound(ledger.round);
      // A refused verb may still have reached the surface (the app answered an error after the
      // call went out), so the observation is read anyway — a run ends with one regardless.
      const obs = stale ? null : await after(kind, failure).catch(() => null);
      const body = obs ? obs.content.find((c) => c.type === "text") : null;
      const rendered = body && body.type === "text" ? body.text : failure;
      return { content: [{ type: "text", text: rendered }, ...(obs?.content.filter((c) => c.type === "image") ?? [])],
        details: { ...(obs?.details ?? {}), error: stale ? "stale_ref" : "act_failed" }, ok: false, note: failure };
    }
    const note = lastNote;
    driver.noteWriteRound(ledger.round);
    const obs = await after(isReadVerb(kind, args, driver.extraVerbs()) ? null : kind, note ? `NOTE: ${note}` : undefined);
    return { ...obs, ok: true, note };
  }

  async function targets(): Promise<ToolResult> {
    const list = await driver.listTargets();
    const lines = list.map((t) => `${t.id} [${t.kind}] ${t.title}${t.active ? " (active)" : ""}`);
    const note = driver.targetsNote();
    const body = lines.join("\n") || "(no targets)";
    return text(note ? `${body}\n\nNOTE: ${note}` : body, { count: list.length });
  }

  /** A vanished or unreadable surface is an ANSWER, not an exception — the same conversion
   *  `guarded` applies around computer_repl, so a suite reads the reason where the model would. */
  const answered = <T extends ToolResult>(f: (...a: never[]) => Promise<T>) => async (...a: unknown[]): Promise<T> => {
    try {
      return await f(...(a as never[]));
    } catch (e) {
      if (e instanceof SurfaceGoneError) return text(e.message, { error: "surface_gone" }) as T;
      if (e instanceof SurfaceUnreadableError) return text(e.message, { error: "surface_unreadable" }) as T;
      throw e;
    }
  };

  return { api, attached, observe: answered(observe), act: answered(act) as Harness["act"], targets: answered(targets),
    lastNote: () => lastNote };
}

/** The text part of a result — the one every suite reads. */
export const firstText = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.find((c) => c.type === "text")?.text ?? "";
