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

/** The verb, over the driver's own wait primitives and the run's ledger. */
export function waitVerb(driver: ComputerUseDriver, ledger: () => RunLedger) {
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
    const res = url !== null
      ? await driver.waitForUrl(url, typeof opts.url_gone === "string", opts.ms as number | undefined)
      : opts.loaded
        ? await driver.waitForLoad(opts.ms as number | undefined)
        : control !== null
          ? await driver.waitForControl(control, typeof opts.control_gone === "string", opts.ms as number | undefined)
          : needle !== null
            ? await driver.waitForText(needle, typeof opts.text_gone === "string", opts.ms as number | undefined)
            : typeof opts.ms === "number"
              ? await new Promise<ActResult>((r) => setTimeout(() => r({ ok: true }), Math.min(Number(opts.ms), MAX_WAIT_MS)))
              : await driver.waitSettled();
    ledger().push("wait", url ?? control ?? needle ?? (opts.loaded ? "loaded" : String(opts.ms ?? "")), res.ok, noteOf(res));
    return res.ok;
  };
}
