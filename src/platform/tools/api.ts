/**
 * The GUI as a JavaScript API — the one implementation behind `computer_repl`.
 *
 * Each function is a thin binding over a driver primitive (`driver.perform`, the same walk); the
 * host language supplies control flow. What a script needs beyond a single tool call:
 *
 *  - **A journal, not a transcript.** One line per call; the caller renders first N + last N + a
 *    count. A platform verb hands its WHOLE note back to the script, since `menu` without a path
 *    IS its listing and a journal line holds one line of it.
 *  - **Caps charged per action**, before every dispatch, so a runaway loop stops between two
 *    actions, not mid-action at an outer timeout.
 *  - **Lazy handles.** `find(name)` re-resolves at use, so a loop over re-minted rows is safe.
 *  - **One verb in flight.** One focus and one caret: two chains put their input wherever the LAST
 *    one clicked, both reporting success. A queue keeps order, not chain integrity, so the second
 *    verb is refused. `log` touches no surface and is exempt.
 *
 * The final observation is the caller's, diffed against the screen before the run.
 */

import type { ComputerUseDriver } from "../driver.ts";
import { STATE_CHANGING_ACTIONS } from "../driver.ts";
import type { ActResult, ShotScope, ToolResult, VerbSpec } from "../types.ts";
import { withoutBlankOptionals } from "./normalize.ts";
// The name -> element ranking, and the shapes it answers with.
import { ambiguityNote, findScope, scopeLabel } from "./find-target.ts";
import { argComplaint } from "./validate.ts";
import { createTargeting } from "./api-target.ts";
import { waitVerb } from "./api-wait.ts";
import { expectVerb } from "./api-expect.ts";
import { checkShotPath, saveShot } from "./shot-file.ts";
import { fnName, firstLine, firstText, noteOf, options, type ApiHooks, type JournalLine, type RunLedger, type WriteRound } from "./api-contract.ts";

// Re-exported so callers keep importing the contract from here.
export { fnName, noteOf, type ApiHooks, type JournalLine, type RunLedger, type WriteRound };

/** How long `find` keeps looking after a miss that followed an action, and how often: a few
 *  frames plus a render for a popup to paint, not a network round trip (that is `wait()`). */
const FIND_SETTLE_BUDGET_MS = 600;
const FIND_SETTLE_INTERVAL_MS = 150;

/** Does this dispatched verb only READ? Shared by the repl and `test/harness.ts` so they never
 *  drift apart. */
export function isReadVerb(kind: string, args: Record<string, unknown>, verbs: readonly VerbSpec[]): boolean {
  return (kind === "menu" && !args.path) || verbs.some(v => v.kind === kind && v.readOnly);
}

/**
 * The verbs and reads, unserialized. Callers wrap the result with {@link verbGate} — the repl
 * needs one gate shared between the bare verbs and every surface handle, so the gate cannot be
 * applied here.
 */
export function createComputerUseApi(
  driver: ComputerUseDriver,
  ledger: () => RunLedger,
  hooks: ApiHooks = {},
): Record<string, unknown> {
  const verbs = driver.extraVerbs();
  const specs = new Map(verbs.map((v) => [v.kind, v.schema]));
  const extras = [...specs.keys()];
  // How a target argument becomes a ref — one job, its own file (api-target.ts).
  const { findWithMiss, missNote, asPoint, resolve, requireFocus, whereNow } = createTargeting(driver, ledger, hooks, firstLine);

  /** The controls nearest a name nothing carried, in find()'s miss wording — what a wait or an
   *  expect that gave up on a control says instead of only "it did not appear". */
  const closestControls = async (name: string): Promise<string> => {
    try {
      const { h, miss } = await findWithMiss(name);
      // find() matches more loosely than a control wait (a word inside a longer name, a value):
      // its pick, with its own caveat, is the nearest thing there is.
      if (h) return `a find() for it answers ${ambiguityNote(h)}`;
      return miss.replace(/^no match(?: — )?/, "");
    } catch {
      return "";
    }
  };

  /** The last dispatched action's kind, or null once a `find` has paid the settle for it. */
  let sinceAction: string | null = null;


  /**
   * The verb's own schema, applied to what the SCRIPT passed — the same check a tool call gets at
   * the boundary. Blanks are dropped first; only verbs with a schema are checked (the universal
   * ones take positional arguments).
   */
  const checkArgs = (kind: string, args: Record<string, unknown>): string | null => {
    const schema = specs.get(kind);
    if (!schema) return null;
    const cleaned = withoutBlankOptionals({ kind, ...args }, schema);
    return argComplaint(schema, fnName(kind), cleaned);
  };

  /** Dispatch one verb and journal it; a failure throws, which stops the run. */
  const run = async (kind: string, args: Record<string, unknown>, target: string, strictWrite = false): Promise<ActResult> => {
    ledger().charge(kind);
    const invalid = checkArgs(kind, args);
    if (invalid) {
      // Journaled before it throws, so the ledger says why the run stopped.
      ledger().push(kind, target, false, invalid, false, "blocked");
      throw new Error(invalid);
    }
    // run_js waits by its own clock, and the time cap is only checked before a verb: a wait that
    // outlasts what the call has left would hold the call past its budget (and the host's timeout).
    // The driver gets what is left (after the schema check: it is not the script's to pass).
    if (kind === "run_js") {
      const left = ledger().remainingMs?.();
      if (left !== undefined) args = { ...args, budgetMs: Math.floor(left) };
    }
    // Reads wearing a verb's name (`menu` without a path, `run_js`) are not actions for the
    // repeat-action escalation nor the frozen verdict: a read does not change the screen, so
    // judging it by whether the screen changed can only accuse it.
    const isRead = isReadVerb(kind, args, verbs);
    if (!isRead) {
      try { await hooks.beforeAction?.(kind, args); }
      catch (e) {
        ledger().push(kind, target, false, (e as Error).message, false, "blocked");
        throw e;
      }
    }
    // The driver keeps the last two action signatures (repeat-action escalation) and the
    // observations-without-acting counter; both are fed here, once per dispatched verb.
    if (!isRead) driver.noteAction(kind, args);
    if (!isRead) sinceAction = kind;
    // A read verb reads CONTENT the way text() does, not the control list.
    else driver.noteContentRead();
    // The element-list settle needs the state from before this action.
    if (!isRead) await driver.ensureSettleBaseline(kind);
    let res: ActResult;
    try {
      res = kind === "focus"
        ? await driver.focusTarget(String(args.target ?? ""))
        : await driver.perform(kind, args);
    } catch (e) {
      ledger().push(kind, target, false, `${(e as Error).message}; outcome unknown — observe before retrying`, isRead, isRead ? undefined : "uncertain");
      throw e;
    }
    if (res.ok) driver.publishPreview(isRead ? undefined : kind, args);
    const mismatch = (strictWrite || kind === "type") && res.ok && res.verified === false;
    const note = kind === "set_text" && res.ok && res.verified === undefined
      ? `${noteOf(res) || "write dispatched"}; read-back unavailable — the value was not verified`
      : noteOf(res);
    const outcome = res.mayHaveActed || res.verified === false ? "uncertain" : !res.ok ? "blocked"
      : res.verified === true ? "verified" : "dispatched";
    ledger().push(kind, target, res.ok && !mismatch, note, isRead, isRead ? undefined : outcome);
    const round = ledger().round;
    if (round && res.ok) {
      if (kind === "set_text") { round.fields += 1; if (res.verified === true) round.verified += 1; }
      else round.ended = `${kind}${args.chord ? ` ${String(args.chord)}` : ""}${target ? ` ${target}` : ""}`;
    }
    if (!res.ok) {
      // A ref that named nothing any more: say where that control is now (api-target.ts).
      const moved = res.targetGone && typeof args.ref === "string" ? await whereNow(args.ref) : "";
      throw new Error(`${kind}${target ? ` ${target}` : ""} failed: ${res.note ?? "no reason given"}${moved ? `.${moved}` : ""}`);
    }
    if (mismatch) {
      const error = new Error(`${kind === "type" ? "type" : "setText"} ${target}: ${res.note ?? "the field did not retain the requested text"}. `
        + "The write was dispatched, but verification failed; subsequent actions were not run. "
        + (kind === "type" ? "Observe the focused field before continuing." : "Use setTextBestEffort only when you intend to handle a mismatched value yourself."));
      error.name = "WriteVerificationError";
      throw error;
    }
    return res;
  };

  const setText = async (t: unknown, value: unknown, strict: boolean, raw?: unknown) => {
    const opts = options<{ ifValue?: unknown }>("setText", raw, "setText(target, text, {ifValue:previousValue})");
    if (Object.keys(opts).some(k => k !== "ifValue") || (opts.ifValue !== undefined && typeof opts.ifValue !== "string")) {
      throw new Error("setText's only option is ifValue:string");
    }
    const { ref, name } = await resolve(t, { write: true });
    if (opts.ifValue !== undefined) {
      ledger().charge("precondition");
      if (!driver.readValue || !driver.valueMatches(await driver.readValue(ref), opts.ifValue)) {
        const note = "The field no longer matches ifValue, or cannot be read. Nothing was written; observe and reconcile the edit.";
        ledger().push("set_text", ref, false, note, false, "blocked");
        throw new Error(note);
      }
    }
    const res = await run("set_text", { ref, ...(name ? { name } : {}), text: String(value ?? "") }, ref, strict);
    // undefined means no read-back channel, not a verified success or a confirmed mismatch.
    return res.verified;
  };

  /**
   * {@link run}, answering as a STRING — what every action verb hands back to the script.
   *
   * A driver writes no `note` when it has nothing to add, and `""` is falsy — `if (await
   * w.click(x))` would read success as failure. The fallback is worded like the journal line; it
   * is never made a note (that would journal "click e12: click e12").
   */
  const acted = async (kind: string, args: Record<string, unknown>, target: string): Promise<unknown> => {
    const res = await run(kind, args, target);
    // A verb that computed something (`run_js`) answers with the VALUE, not its clipped,
    // prefixed note. `in`, not truthiness: undefined, 0 and "" are real answers.
    if ("value" in res) return res.value;
    return res.note || (target ? `${kind} ${target}` : kind);
  };

  /** A read that is not an action: charged and journaled like one, so a loop of reads is
   *  still a loop that has to stop. */
  const read = <T>(kind: string, target: string, note: (v: T) => string, get: () => Promise<T>) => async (): Promise<T> => {
    ledger().charge(kind);
    // Reading CONTENT is not re-looking at the control list: it exempts the round from the
    // "you keep observing without acting" nudge (see ComputerUseDriverSelect.contentRead).
    driver.noteContentRead();
    const v = await get();
    driver.publishPreview();
    ledger().push(kind, target, true, note(v));
    return v;
  };

  /**
   * A read that takes NOTHING, and says so when handed something: a silently dropped option
   * leaves the caller believing it asked for something. The refusal names what the read does.
   */
  const takesNothing = <T>(name: string, does: string, fn: () => Promise<T>) => async (...args: unknown[]): Promise<T> => {
    if (args.length) throw new Error(`${name}() takes no arguments — ${does}`);
    return fn();
  };

  const api: Record<string, unknown> = {
    // ── Reads ────────────────────────────────────────────────────────────────
    /**
     * The element list, and — asked for — the picture of the same screen (for a caller that needs
     * coordinates, see `asPoint`). Options that would NARROW it are refused by name.
     *
     * NOT an atomic capture: the walk and the shot are two reads a beat apart, each charged.
     */
    observe: async (raw: unknown = {}) => {
      const opts = options<{ screenshot?: unknown }>("observe", raw,
        "observe() lists every element; observe({screenshot: true}) also attaches the picture");
      const extra = Object.keys(opts).filter((k) => k !== "screenshot");
      if (extra.length) {
        throw new Error(`observe() does not take ${extra.join(", ")} — it already answers with EVERY element, on screen `
          + "and beyond it (each one off-viewport carries `offscreen: true`); narrow it by filtering the array it "
          + "returns. Its one option is screenshot: true.");
      }
      ledger().charge("observe");
      const { url, title, elements, groups, headings, partial, coverage, target } = await driver.readElements();
      hooks.onRefs?.(elements.map((e) => e.ref));
      let shot = "";
      if (opts.screenshot) {
        ledger().charge("screenshot");
        const r = await driver.observeImage();
        for (const part of r.content) if (part.type === "image") { ledger().attach(part); shot = " + image"; }
        // A capture that answered with words instead of pixels (a locked screen, an off-screen
        // window) is said here, not swallowed: the caller asked to SEE something.
        if (!shot) shot = ` (no image — ${firstLine(r)})`;
      }
      ledger().push("observe", "", true, `${elements.length} elements${shot}`);
      // `groups` rides along so a script need not rebuild the grouping from rects. Absent, not
      // empty, where there are none.
      return { url, title, elements, coverage, ...(target ? { target } : {}), ...(groups?.length ? { groups } : {}),
        ...(headings?.length ? { headings } : {}), ...(partial ? { partial } : {}) };
    },
    find: async (name: unknown, opts: unknown = {}) => {
      ledger().charge("find");
      const scope = findScope(opts, driver.readsOffscreen);
      // Not part of the scope: it changes what a miss ANSWERS, never what is searched, so a
      // handle's re-resolution must not carry it.
      const explain = !!(opts && typeof opts === "object" && (opts as { why?: unknown }).why);
      let { h, miss, why } = await findWithMiss(String(name ?? ""), scope);
      // A miss right after an action may read the tree from BEFORE the popup it opened painted
      // (`click` returns when the DOM event fired). Retry briefly, once per action. Not a wait
      // inside `click`: that would tax every click (see driver-settle.ts); this pays only on a
      // miss, which already costs a round trip.
      if (!h && STATE_CHANGING_ACTIONS.has(sinceAction ?? "")) {
        sinceAction = null;
        for (let waited = 0; !h && waited < FIND_SETTLE_BUDGET_MS; waited += FIND_SETTLE_INTERVAL_MS) {
          await new Promise((r) => setTimeout(r, FIND_SETTLE_INTERVAL_MS));
          ({ h, miss, why } = await findWithMiss(String(name ?? ""), scope));
        }
      }
      // ok:true either way: `find` ANSWERS null and the run continues; a FAILED line would read
      // like a real failure, which stops the run.
      ledger().push("find", `${String(name ?? "")}${scopeLabel(scope)}`, true, h ? ambiguityNote(h) : miss);
      // Without `why` a miss stays null, so every `if (!el)` already written keeps working.
      return h ?? (explain ? why : null);
    },
    text: takesNothing("text", "it returns the surface's whole readable text",
      read("text", "", (t: string) => `${t.length} chars`, () => driver.readText())),
    // One element, where text() is the whole surface. A read, not a verb, so it never feeds the
    // repeat-action escalation nor the "no element changed" verdict.
    value: async (t: unknown) => {
      if (!driver.readValue) {
        throw new Error("value() is not supported on this platform — text() reads the whole surface instead");
      }
      const tgt = await resolve(t);
      return read("value", tgt.ref, (v: string) => `${v.length} chars`, () => driver.readValue!(tgt.ref))();
    },
    page: async (raw: unknown = {}) => {
      const opts = options<{ ref?: string; depth?: number; node?: string }>("page", raw,
        "page() reads the whole page and page({ref}) one node — to NAVIGATE, openUrl({url})");
      if (!driver.readPage) throw new Error("page reading is not supported on this platform — use text()");
      if (opts.ref && !driver.knownRef(opts.ref)) throw new Error(driver.staleRefNote(opts.ref));
      const get = read("page", opts.ref ?? opts.node ?? "", (r: ToolResult) => firstLine(r), () => driver.readPage!(opts));
      return firstText(await get());
    },
    screenshot: async (raw: unknown = {}) => {
      const { path, ...opts } = options<ShotScope & { path?: unknown }>("screenshot", raw,
        "screenshot() takes the viewport; screenshot({ref}) / ({region}) / ({fullPage:true}) narrow it");
      if (opts.ref && !driver.knownRef(opts.ref)) throw new Error(driver.staleRefNote(opts.ref));
      if (path !== undefined && typeof path !== "string") throw new Error("screenshot path must be a string");
      // Checked before capturing: a bad path costs nothing and names its problem.
      if (path) checkShotPath(path, driver.screenshotMimeType);
      // padding counts as a scope request so that, without ref, the refusal says why.
      const scoped = !!(opts.ref || opts.region || opts.fullPage || opts.padding !== undefined);
      // The picture still rides the result for the model to SEE; the file is what the script keeps.
      let saved: ReturnType<typeof saveShot> | null = null;
      const outcome = (r: ToolResult) => saved ? `saved ${saved.path}` : `no image — ${firstLine(r)}`;
      const get = read("screenshot", opts.ref ?? (opts.fullPage ? "full page" : opts.region ? "region" : ""),
        outcome, async () => {
          const r = await driver.observeImage(scoped ? { scope: opts } : {});
          const img = r.content.find((c) => c.type === "image");
          if (img && img.type === "image") saved = saveShot(img.data, img.mimeType, path || undefined);
          return r;
        });
      const r = await get();
      for (const part of r.content) if (part.type === "image") ledger().attach(part);
      // No image is an answer, not a failure (a locked screen, a window off-screen): path is null
      // and the note says why, so a script can branch on it instead of losing the run.
      return saved ? { ...(saved as object), note: firstLine(r), ...(r.details.capture ? { capture: r.details.capture } : {}) }
        : { path: null, note: outcome(r) };
    },
    diagnostics: async (raw: unknown = {}) => {
      const opts = options<{ id?: string }>("diagnostics", raw, "diagnostics() reads every channel, diagnostics({id}) one of them");
      return firstText(await read("diagnostics", opts.id ?? "", firstLine, async () => driver.readDiagnostics(opts))());
    },
    targets: takesNothing("targets", "it lists every surface there is",
      read("targets", "", (t: unknown[]) => `${t.length} targets`, () => driver.listTargets())),

    // ── Actions ──────────────────────────────────────────────────────────────
    click: async (t: unknown, opts: Record<string, unknown> = {}) => {
      // A point carries no identity: no stale-ref gate, no name agreement, no surface ownership.
      const at = asPoint(t);
      if (at) return acted("click", { ...at, ...opts }, `${at.x},${at.y}`);
      const { ref, name } = await resolve(t, { write: true });
      return acted("click", { ref, ...(name ? { name } : {}), ...opts }, ref);
    },
    hover: async (t: unknown) => {
      const at = asPoint(t);
      if (at) return acted("hover", { ...at }, `${at.x},${at.y}`);
      const { ref, name } = await resolve(t);
      return acted("hover", { ref, ...(name ? { name } : {}) }, ref);
    },
    setText: (t: unknown, value: unknown, opts?: unknown) => setText(t, value, true, opts),
    setTextBestEffort: (t: unknown, value: unknown, opts?: unknown) => setText(t, value, false, opts),
    keys: async (chord: unknown, count?: unknown, opts?: unknown) => {
      // `keys('Enter', {focus: field})` as well as `keys('Enter', 2, {focus: field})`: the count
      // is the older second argument and stays where it is.
      const o = (typeof count === "object" && count !== null ? count : opts) as { focus?: unknown } | undefined;
      const n = typeof count === "number" ? count : undefined;
      if (o?.focus !== undefined) await requireFocus(o.focus);
      return acted("keys", { chord: String(chord ?? ""), ...(n ? { count: n } : {}) }, String(chord ?? ""));
    },
    scroll: async (raw: unknown = {}) => {
      const opts = options<Record<string, unknown>>("scroll", raw, "scroll({direction:'down'}) or scroll({to:'bottom'})");
      if (opts.into !== undefined) {
        // A ref or a handle. A covered control has no handle (find answers null), so it comes
        // as the ref its cover note named, or a find(…, {why}) miss's `match.ref`.
        const missed = missNote(opts.into);
        if (missed) throw new Error(missed);
        if (typeof opts.into !== "string" && typeof (opts.into as { ref?: unknown } | null)?.ref !== "string") {
          throw new Error("scroll({into}) takes a ref string or a find() handle");
        }
        // A handle is followed to its control like any target's (a reload or a re-render in the
        // same run left its ref dead); a ref string goes as written, since a covered control's
        // ref is not among the listed ones and must still get through.
        const into = typeof opts.into === "string" ? opts.into : (await resolve(opts.into)).ref;
        if (!driver.scrollsInto) throw new Error("scroll({into}) is not available on this platform — scroll by direction, count or to:");
        const extra = ["direction", "count", "to", "ref"].filter((k) => opts[k] !== undefined);
        if (extra.length) throw new Error(`scroll({into}) moves to one control and takes nothing else — drop ${extra.join(", ")}`);
        hooks.onTarget?.(into);
        const note = await acted("scroll", { into }, into);
        // The move may have uncovered it: a fresh read lets this same script act on its ref.
        await driver.readElements().catch(() => {});
        return note;
      }
      // `ref` names the container the way any target does: a ref string ('window' for the page),
      // or a find() handle, resolved like a click's — null says the find matched nothing. A
      // handle passed through unresolved was dropped as not a string, and the scroll ran bare.
      let ref = opts.ref;
      if (ref !== undefined && typeof ref !== "string") ref = (await resolve(ref)).ref;
      else if (typeof ref === "string") hooks.onTarget?.(ref);
      return acted("scroll", { ...opts, ...(ref === undefined ? {} : { ref }) }, String(ref ?? opts.direction ?? opts.to ?? ""));
    },
    wait: waitVerb(driver, ledger, closestControls),
    expect: expectVerb(driver, ledger, async (target) => {
      if (!driver.readValue) throw new Error("This platform cannot read field values");
      const { ref } = await resolve(target);
      return driver.readValue(ref);
    }, closestControls),
    focus: async (target: unknown) => {
      return acted("focus", { target: String(target ?? "") }, String(target ?? ""));
    },
    log: (...parts: unknown[]) => {
      // Charged like an action: the cap bounds what the JOURNAL can grow to, and a loop
      // that only logs is still a loop that has to stop.
      ledger().charge("log");
      ledger().push("log", "", true, parts.map(stringify).join(" ").slice(0, 200));
    },
    act: async (kind: unknown, args: Record<string, unknown> = {}) => {
      // The wire-name escape hatch gets the same ref gate as the named verbs: it must not be
      // the one route that dispatches onto whatever now carries a stale number.
      if (typeof args.ref === "string") {
        hooks.onTarget?.(args.ref);
        if (!driver.knownRef(args.ref)) throw new Error(driver.staleRefNote(args.ref) + await whereNow(args.ref));
      }
      return acted(String(kind ?? ""), { ...args }, String(args.ref ?? ""));
    },
  };
  // The driver's own verbs, under camelCase names: one object argument forwarded whole (the
  // `extraVerbs` schemas document them). The note returns whole: for `menu` with no path it IS
  // the answer.
  for (const kind of extras) {
    api[fnName(kind)] = async (raw: unknown = {}) => {
      // Shape gate: a string would SPREAD into {0:'h',1:'t',…}, which an all-optional schema
      // would accept and run with its defaults.
      const args = options<Record<string, unknown>>(fnName(kind), raw, `pass its arguments as an object, e.g. ${fnName(kind)}({…})`);
      const t = args.ref !== undefined ? await resolve(args.ref, { write: true }) : null;
      return acted(kind, { ...args, ...(t ? { ref: t.ref } : {}) }, String(args.ref ?? ""));
    };
  }
  return api;
}


// The run plumbing lives in api-run.ts (one verb in flight, value stringifying, journal
// rendering) — re-exported here so callers keep one import site.
export { renderJournal, stringify, verbGate } from "./api-run.ts";
import { stringify } from "./api-run.ts";
