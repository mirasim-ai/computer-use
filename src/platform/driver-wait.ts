/**
 * Condition waiting: the `wait` polls and the wording they answer with. The narrowest seam in the
 * base class: each needs ONE read of the surface, so it takes a function rather than a driver,
 * and nothing here touches the observation pipeline, the verdict ring or refs.
 */

import type { ActResult } from "./types.ts";

/** How often to re-read while waiting. Every read is a FULL one (page evaluate, accessibility
 * walk), so the interval is coarser than a UI frame and BACKS OFF: a condition not met in the
 * first seconds is usually seconds away. On a 24.9 s ChatGPT answer a flat 600 ms cost ~41 walks;
 * this schedule costs 17 and still answers a fast condition inside half a second. */
const POLL_START_MS = 400;
const POLL_MAX_MS = 2000;

/** The wait between attempt `n` and the next: quick while the condition may be imminent,
 *  then doubling to the ceiling. */
function pollDelay(attempt: number): number {
  return Math.min(POLL_MAX_MS, POLL_START_MS * 2 ** Math.max(0, attempt - 2));
}

/**
 * Poll `probe` until it reports the wanted state, or until the cap — and the cap is HARD: the
 * sleep is clamped to the budget left, and no read STARTS with less time left than the last read
 * took (with ~500 ms reads, a poll at 4.8 s of a 5 s budget would return at 6.8 s).
 * `probe` answering null means "cannot tell right now" (mid-navigation) and the poll continues;
 * the caller words the outcome, since only it knows what was waited for.
 */
async function pollUntil(
  probe: () => Promise<boolean | null>,
  gone: boolean,
  capMs: number,
): Promise<{ met: boolean; elapsed: string; overran: string }> {
  const started = Date.now();
  const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);
  let readMs = 0;
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    const hit = await probe();
    readMs = Date.now() - t0;
    if (hit !== null && hit === !gone) return { met: true, elapsed: elapsed(), overran: "" };
    const left = capMs - (Date.now() - started);
    if (left <= readMs) {
      // ms bounds the POLLING; a read in flight cannot be taken back, so one read slower than the
      // budget overruns it (by seconds on a heavy surface). Cutting it off would answer from
      // nothing observed, so the read stands and the result reports the overrun — only if it did.
      const over = Date.now() - started > capMs + 250
        ? ` (the ${capMs}ms budget was spent inside a single read of this surface, which takes ~${(readMs / 1000).toFixed(1)}s here — the wait cost that one read)`
        : "";
      return { met: false, elapsed: elapsed(), overran: over };
    }
    await new Promise((r) => setTimeout(r, Math.min(pollDelay(attempt), left)));
  }
}

/**
 * Poll the CONTROLS until one named `name` is there (or gone), or until `capMs` elapses. The text
 * poll cannot answer this: `{text_gone:'Stop'}` also matches the word in a paragraph, tooltip or
 * typed message, so waiting for a BUTTON to disappear (ChatGPT.app's Stop, its only honest
 * end-of-answer signal) ends only when the page stops mentioning it.
 * Matching is `find`'s rule: exact name first, else a case-insensitive substring, and a real
 * CONTROL beats a text label. A read that throws counts as "cannot tell".
 */
export async function waitForControlImpl(
  list: () => Promise<Array<{ role: string; name: string }>>,
  name: string,
  gone: boolean,
  capMs: number,
): Promise<ActResult> {
  const want = name.trim().toLowerCase();
  const present = async () => {
    const els = await list().catch(() => null);
    if (els === null) return null;
    const named = els.filter((e) => e.role !== "text");
    return named.some((e) => e.name.trim().toLowerCase() === want)
      || named.some((e) => e.name.toLowerCase().includes(want));
  };
  const { met, elapsed, overran } = await pollUntil(present, gone, capMs);
  if (met) {
    return { ok: true, note: gone ? `the control "${name}" is gone after ${elapsed}s` : `the control "${name}" is there after ${elapsed}s` };
  }
  return {
    ok: false,
    // Same two rules as the text poll: no "try another element" tail, and the ELAPSED time.
    note: gone
      ? `waited ${elapsed}s and a control named "${name}" is still listed — it did not go away on its own, `
        + "so observe and act on what is holding it there rather than waiting again" + overran
      : `waited ${elapsed}s and no control named "${name}" appeared — observe to see what the surface lists now; `
        + "the name may differ, or the step before this did not take" + overran,
  };
}

/** Poll `read` until `needle` is present (or absent, with `gone`), or until `capMs` elapses.
 * Case-insensitive substring, no regex — `query`'s rule. A read that throws counts as "cannot
 * tell": mid-navigation is exactly when a wait is wanted. */
export async function waitForTextImpl(
  read: () => Promise<string>,
  needle: string,
  gone: boolean,
  capMs: number,
): Promise<ActResult> {
  const want = needle.toLowerCase();
  const present = async () => {
    const t = await read().catch(() => null);
    return t === null ? null : t.toLowerCase().includes(want);
  };
  const { met, elapsed, overran } = await pollUntil(present, gone, capMs);
  if (met) {
    return { ok: true, note: gone ? `"${needle}" is gone after ${elapsed}s` : `"${needle}" appeared after ${elapsed}s` };
  }
  // Report the ELAPSED time, not the cap: this wording's job is to say exactly what was observed.
  return {
    ok: false,
    note: gone
      ? `waited ${elapsed}s and "${needle}" is still in the readable text — it did not go away on its own, `
        + "so observe and act on what is holding it there rather than waiting again" + overran
      : `waited ${elapsed}s and "${needle}" never appeared in the readable text — `
        + "observe to see what the surface shows now; the wording may differ, or the step before this did not take",
  };
}

/** Wait until the surface's LOCUS (the browser's URL; elsewhere whatever `Snapshot.url` means)
 * contains `want`, or no longer does — "did my click take me somewhere". Substring, not equality
 * or glob: URLs carry query strings and fragments nobody spells out, and it is `find`'s rule. */
export async function waitForUrlImpl(
  read: () => Promise<string>,
  want: string,
  gone: boolean,
  capMs: number,
): Promise<ActResult> {
  const needle = want.toLowerCase();
  let last = "";
  const present = async () => {
    const u = await read().catch(() => null);
    if (u === null) return null;
    last = u;
    return u.toLowerCase().includes(needle);
  };
  const { met, elapsed, overran } = await pollUntil(present, gone, capMs);
  if (met) return { ok: true, note: gone ? `left "${want}" after ${elapsed}s` : `at ${last} after ${elapsed}s` };
  return {
    ok: false,
    note: gone
      ? `waited ${elapsed}s and the address still contains "${want}" (${last}) — nothing moved away from it, `
        + "so observe and act rather than waiting again" + overran
      : `waited ${elapsed}s and the address never contained "${want}" — it is ${last}. `
        + "Observe what the surface shows now: the step before this may not have gone anywhere" + overran,
  };
}

/**
 * Wait until the document has finished LOADING — not until it is quiet or some text appears. A
 * document can parse and never finish (x.com, intermittently): `readyState` stays "interactive"
 * while reads come back empty, which neither a fixed `ms` nor a settle can tell from an empty page,
 * so the note says which state was hit.
 * LOADED IS NOT RENDERED (x.com: "complete" at 1.8 s, no posts drawn): this answers for the
 * DOCUMENT; on a single-page app wait for it, then for the content.
 */
export async function waitForLoadImpl(
  read: () => Promise<string>,
  capMs: number,
): Promise<ActResult> {
  let last = "";
  const present = async () => {
    const st = await read().catch(() => null);
    if (st === null) return null;
    last = st;
    return st === "complete";
  };
  const { met, elapsed, overran } = await pollUntil(present, false, capMs);
  if (met) return { ok: true, note: `loaded after ${elapsed}s` };
  return {
    ok: false,
    note: `waited ${elapsed}s and the document is still "${last}", not "complete" — it is STILL LOADING, `
      + "so an empty read means not-yet, never nothing-there. Wait again with a longer ms, or report "
      + "that the page has not finished loading" + overran,
  };
}

/**
 * "Has it stopped changing" over the READABLE TEXT — the settle every driver can run, and the poll
 * the API reference promises wherever Chromium's override (which also samples `readyState`) does
 * not run. On a self-drawn app the text is the only signal, the alternative a guessed `wait({ms})`.
 * Two equal samples one poll apart is settled; the first is taken before waiting, so an
 * already-quiet surface costs one poll. The answer says how long it took (0.6 s ≠ 9 s).
 */
export async function waitSettledOverText(
  readText: () => Promise<string>,
  capMs: number,
  pollMs = 600,
): Promise<ActResult> {
  const started = Date.now();
  const sample = () => readText().then((t) => t.slice(0, 20_000), () => null);
  let prev = await sample();
  while (Date.now() - started < capMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    const cur = await sample();
    if (cur !== null && cur === prev) {
      return { ok: true, note: `the readable text settled after ${((Date.now() - started) / 1000).toFixed(1)}s` };
    }
    prev = cur ?? prev;
  }
  // Not a failure, a fact about the surface: this cannot tell still-working from a never-quiet
  // spinner, so the caller decides.
  return {
    ok: true,
    note: `the readable text was still changing when the ${Math.round(capMs / 1000)}s budget ran out — it may still be `
      + "working, or it may be a surface that never goes quiet (a clock, a progress line). Read it as it is, or wait "
      + "for something specific: wait({text:'…'}) or wait({control_gone:'…'})",
  };
}
