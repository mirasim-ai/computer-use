/**
 * Run plumbing for `computer_repl`: the one-verb-in-flight gate, the way a script's value becomes
 * text, and how the journal is rendered. Touches neither the API closure nor a driver.
 */

import type { JournalLine } from "./api-contract.ts";

/**
 * ONE verb in flight across everything wrapped by the same gate — a second one started before
 * the first finished is REFUSED, by name. `log` and non-functions pass through.
 *
 * `over` says the code calling a verb belongs to a call that has ended (or was told to stop). Such
 * a verb is neither run nor refused: it never settles. Refusing would hand the code an error it
 * can catch, and code that catches and tries again (`while (true) { try { await w.click(t) }
 * catch {} }`) then spins without ever yielding: measured, no timer and no signal handler runs
 * again, so the whole server is lost. Code left waiting on a promise nobody holds is just garbage.
 */
export function verbGate(onRefusal: (note: string) => void, over: () => boolean = () => false) {
  let inFlight: string | null = null;
  let pending: Promise<unknown> | null = null;
  const wrap = <T extends Record<string, unknown>>(fns: T): T => Object.fromEntries(Object.entries(fns).map(([name, fn]) => {
    if (name === "log" || typeof fn !== "function") return [name, fn];
    const verb = fn as (...a: unknown[]) => Promise<unknown>;
    return [name, (...a: unknown[]) => {
      if (over()) return new Promise(() => {});
      if (inFlight) {
        const note = `${name} was started while ${inFlight} was still running — verbs run `
          + "one at a time, because the surface has one focus and one caret. Two chains in "
          + "flight put their input wherever the LAST one clicked. Await each verb before the next.";
        onRefusal(note);
        throw new Error(note);
      }
      inFlight = name;
      let out: unknown;
      try { out = verb(...a); }
      catch (e) { inFlight = null; throw e; }
      // A synchronous member (computer.help) holds nothing and releases at once.
      if (!(out instanceof Promise)) { inFlight = null; return out; }
      const p = out.finally(() => { inFlight = null; pending = null; });
      pending = p;
      // An un-awaited verb that fails would be an unhandled rejection, which ends the whole
      // process. Mark it handled; whoever awaits `p` still sees the rejection.
      p.catch(() => {});
      return p;
    }];
  })) as T;
  return Object.assign(wrap, {
    // A forgotten await must not outlive its ledger or let reset release a still-used target.
    async drain(): Promise<void> { while (pending) await pending; },
    /** The verb in flight right now, by name. */
    running: (): string | null => inFlight,
    /** Stop counting a verb that will never come back (its call was abandoned), so the next call
     *  is not refused in its name for the rest of the session. */
    forget(): void { inFlight = null; pending = null; },
  });
}

/** JSON where it can be, a string otherwise — a script may return anything. */
export function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}


/** Journal lines kept at each end when a run is longer than 2×this. */
const JOURNAL_EDGE = 12;

/** A step the reader has to see wherever it sits: one that failed, was refused, or whose effect is unknown. */
const tells = (l: JournalLine): boolean => !l.ok || l.outcome === "blocked" || l.outcome === "uncertain";

/**
 * The journal as the result prints it. A long run keeps both ends and counts the middle, but only
 * the steps that went through are counted away: a step in the middle that failed and was caught by
 * the code, or that came back uncertain, used to vanish into "16 steps not listed", and the model
 * then read a run it could not tell from a clean one.
 */
export function renderJournal(journal: JournalLine[]): string[] {
  const line = (l: JournalLine) =>
    `  ${l.i}. ${l.kind}${l.target ? ` ${l.target}` : ""}${l.ok ? "" : " FAILED"}${l.outcome ? ` [${l.outcome}]` : ""}${l.note ? `: ${l.note}` : ""}`;
  if (journal.length <= JOURNAL_EDGE * 2) return journal.map(line);
  const out = journal.slice(0, JOURNAL_EDGE).map(line);
  let skipped = 0;
  const flush = () => {
    if (skipped) out.push(`  … ${skipped} ${skipped === 1 ? "step that went through is" : "steps that went through are"} not listed …`);
    skipped = 0;
  };
  for (const l of journal.slice(JOURNAL_EDGE, -JOURNAL_EDGE)) {
    if (tells(l)) { flush(); out.push(line(l)); }
    else skipped++;
  }
  flush();
  out.push(...journal.slice(-JOURNAL_EDGE).map(line));
  return out;
}
