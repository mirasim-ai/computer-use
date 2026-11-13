/**
 * `wait` — the one verb whose whole job is to decide WHEN the surface is worth reading again.
 * Several conditions sit behind one name, and each must say WHICH answer it gives: a wait that
 * gave up looks exactly like one that succeeded unless it says so.
 */

import type { ComputerUseDriver } from "../driver.ts";
import type { ActResult } from "../types.ts";
import { noteOf, options, type RunLedger } from "./api-contract.ts";

/** Longest a bare `wait({ms})` may sleep — the run's own wall clock is the real cap. */
const MAX_WAIT_MS = 60_000;

/**
 * How long a wait for something to APPEAR ({text}, {control}, {url}) polls when the call names no
 * `ms`. Half the drivers' own 16 s, which the other conditions keep: "until it is gone" and
 * {loaded} wait out work whose length nobody knows, while an appearance is as often a guess at a
 * name or a wording, and a wrong guess costs the whole budget. Measured over 818 front-end
 * benchmark runs: of 187 such waits that named no `ms` and were met, 184 were met inside 3 s and
 * the slowest took 7.2 s; the 9 never met each waited out all 16.
 */
export const APPEAR_WAIT_MS = 8_000;

/** What a condition that was never met is owed besides "it did not happen": the controls whose
 *  names are nearest the one waited for (find()'s own miss wording), or "" when it cannot say. */
export type ClosestControls = (name: string) => Promise<string>;

/**
 * What the readable text says NEAR the words that were waited for — the lines sharing at least
 * half of them, or that the words are all there with other spacing. A guess at a page's wording
 * is usually one word off; without this the next call is another guess. "" when nothing is near.
 */
export function nearText(text: string, needle: string): string {
  const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (squash(text).includes(squash(needle))) {
    return "the readable text carries these words with different spacing or line breaks — match one line of it";
  }
  const words = [...new Set(needle.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))];
  if (!words.length) return "";
  const seen = new Set<string>();
  const near = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && l.length <= 400)
    .map((l) => ({ l, score: words.filter((w) => l.toLowerCase().includes(w)).length / words.length }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.l.length - b.l.length)
    .filter((x) => (seen.has(x.l) ? false : (seen.add(x.l), true)))
    .slice(0, 2);
  return near.length ? `closest in the readable text: ${near.map((x) => `«${x.l.length > 80 ? `${x.l.slice(0, 80)}…` : x.l}»`).join(", ")}` : "";
}

/** The verb, over the driver's own wait primitives and the run's ledger. */
export function waitVerb(driver: ComputerUseDriver, ledger: () => RunLedger, closest?: ClosestControls) {
  return async (raw: unknown = {}) => {

    const opts = options<Record<string, unknown>>("wait", raw,
      "wait({}) waits for the content to stop changing; wait({ms:2000}) sleeps; wait({text}) / ({control}) / "
      + "({text_gone}) / ({control_gone}) / ({url}) / ({url_gone}) / ({loaded:true}) wait for a condition");
    ledger().charge("wait");
    driver.noteAction("wait", opts);
    const needle = typeof opts.text === "string" ? opts.text : typeof opts.text_gone === "string" ? opts.text_gone : null;
    // A CONTROL condition is its own channel, not a text search: a button's name is in the
    // page text too, so waiting on text ends when the page stops MENTIONING it (driver-wait.ts).
    const control = typeof opts.control === "string" ? opts.control : typeof opts.control_gone === "string" ? opts.control_gone : null;
    // Where the surface IS, and whether it has finished arriving, are not content conditions: an
    // empty read is the same text whether the document is loading or empty. Checked first only
    // because they are cheaper.
    const url = typeof opts.url === "string" ? opts.url : typeof opts.url_gone === "string" ? opts.url_gone : null;
    // The caller's own budget, else the short default for an APPEARANCE; "gone", {loaded} and the
    // bare settle keep their driver's default (see APPEAR_WAIT_MS).
    const ms = opts.ms as number | undefined;
    const budget = (gone: boolean) => (gone ? ms : ms ?? APPEAR_WAIT_MS);
    const urlGone = typeof opts.url_gone === "string";
    const controlGone = typeof opts.control_gone === "string";
    const textGone = typeof opts.text_gone === "string";
    const appearing = url !== null ? !urlGone : opts.loaded ? false : control !== null ? !controlGone : needle !== null && !textGone;
    let res = url !== null
      ? await driver.waitForUrl(url, urlGone, budget(urlGone))
      : opts.loaded
        ? await driver.waitForLoad(ms)
        : control !== null
          ? await driver.waitForControl(control, controlGone, budget(controlGone))
          : needle !== null
            ? await driver.waitForText(needle, textGone, budget(textGone))
            : typeof opts.ms === "number"
              ? await new Promise<ActResult>((r) => setTimeout(() => r({ ok: true }), Math.min(Number(opts.ms), MAX_WAIT_MS)))
              : await driver.waitSettled();
    // A wait that gave up on something APPEARING says what is there instead: the name or the
    // wording was a guess, and the journal line is where the next guess gets made. Paid only on
    // the miss — one more read after the seconds already spent polling.
    if (!res.ok && url === null && !opts.loaded) {
      const hint = control !== null
        ? (typeof opts.control === "string" && closest ? await closest(control) : "")
        : needle !== null && typeof opts.text === "string"
          ? nearText(await driver.readTextForWait().catch(() => ""), needle)
          : "";
      if (hint) res = { ...res, note: `${noteOf(res)}; ${hint}` };
    }
    // The short default is right for a guess and wrong for something slow, and only the caller
    // knows which this was: a miss on the default says that the budget was the default.
    if (!res.ok && appearing && ms === undefined) {
      res = { ...res, note: `${noteOf(res)}; that was the default ${APPEAR_WAIT_MS / 1000}s for an appearance — pass ms to give something slow longer` };
    }
    ledger().push("wait", url ?? control ?? needle ?? (opts.loaded ? "loaded" : String(opts.ms ?? "")), res.ok, noteOf(res));
    return res.ok;
  };
}
