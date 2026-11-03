/**
 * WHEN a page is worth reading: the three waits.
 *
 * A single-page app reaches `load` with nothing drawn, so these answer "has it stopped
 * changing" rather than "has it finished". The chain is `ChromiumPageBase` → `ChromiumPageActs`
 * → this → `ChromiumPageDriver` (the reads).
 */

import { waitForLoadImpl, waitForUrlImpl } from "../driver-wait.ts";
import type { ActResult } from "../types.ts";
import { ChromiumPageActs } from "./page-acts.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long the text must hold still, with no rendering request out, before the content counts as
 *  settled — and how often it is sampled meanwhile. @see ChromiumPageWaits.waitSettled */
const QUIET_MS = 150;
const SAMPLE_MS = 50;
/** The stillness a wait asks for grows with how long the text has been seen CHANGING, to half of
 *  that span, up to {@link QUIET_MAX_MS}: a page that has churned for seconds (a streamed answer,
 *  whose request stops counting after 2 s) must hold still for longer than a pause between
 *  chunks. Time spent waiting on a request does not count, so one late render pays QUIET_MS. */
const quietNeeded = (churnMs: number) => Math.min(QUIET_MAX_MS, Math.max(QUIET_MS, churnMs / 2));
/** The sampling gap on a document that is NOT complete (a quiet gap there says nothing), and the
 *  one sampling backs off to on a page that keeps changing. */
const QUIET_MAX_MS = 1000;

export abstract class ChromiumPageWaits extends ChromiumPageActs {
  /** The locus is free here, so the generic walk-per-poll would be pure waste. */
  override async waitForUrl(want: string, gone: boolean, capMs = 16_000): Promise<ActResult> {
    await this.ensure();
    return waitForUrlImpl(async () => this.page().url(), want, gone, capMs);
  }

  /** `document.readyState`, polled: one evaluate per beat, no walk. */
  override async waitForLoad(capMs = 16_000): Promise<ActResult> {
    await this.ensure();
    return waitForLoadImpl(
      async () => String(await this.page().mainFrame().evaluate("document.readyState")),
      capMs,
    );
  }

  override async waitSettled(capMs = 16_000): Promise<ActResult> {
    await this.ensure();
    this.hookDiagnostics();
    const page = this.page();
    // TWO facts per sample: quiet text alone cannot tell a page that is DONE from a shell that
    // never mounted (one x.com shell sat at `interactive` for twenty minutes). Only a
    // `complete` document settles.
    const sample = () => page.evaluate(
      "(() => { const t = document.body ? document.body.innerText : ''; return document.readyState + '|' + t.length + '|' + t.slice(-240); })()",
    ) as Promise<string>;
    const started = Date.now();
    let prev = await sample().catch(() => null);
    // Settled = a `complete` document whose text has held still for QUIET_MS while no rendering
    // request was out. The requests are what make a short window honest: a click's own
    // re-render has landed by the time the click returns, and what comes later comes through
    // the network (pendingRenders, page-base.ts). A text-only rule needed a 300 ms window to
    // cover a local round trip, and every wait({}) paid it: measured, 188 of them in one
    // front-end run cost 58 s at 303–307 ms each. The trade: text a TIMER changes every
    // 150–300 ms, with no request behind it, can now read as settled between two ticks.
    let stillSince = Date.now();
    let firstChange: number | null = null;
    let gap = SAMPLE_MS;
    while (Date.now() - started < capMs) {
      await sleep((prev ?? "").startsWith("complete|") ? gap : QUIET_MAX_MS);
      const cur = await sample().catch(() => null);
      if (cur === null || cur !== prev) {
        stillSince = Date.now();
        firstChange ??= stillSince;
        // A page that keeps changing is sampled less often, as before: each sample reads its text.
        if (Date.now() - started > QUIET_MAX_MS) gap = Math.min(QUIET_MAX_MS, Math.round(gap * 1.7));
      } else if (cur.startsWith("complete|") && Date.now() - stillSince >= quietNeeded(firstChange === null ? 0 : stillSince - firstChange)
          && this.pendingRenders() === 0) {
        const ms = Date.now() - started;
        return { ok: true, note: `content settled after ${ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`}` };
      }
      prev = cur ?? prev;
    }
    // The timeout says WHICH wall was hit: a document that never finished is one to reload, a
    // moving one a list to read as it is.
    const state = (prev ?? "").split("|")[0];
    return {
      ok: true,
      note: state && state !== "complete"
        ? `the document never finished loading (readyState ${state}) after ${Math.round(capMs / 1000)}s`
          + " — what you read now may be a shell the site never filled in; reload or try again later"
        : `content still changing after ${Math.round(capMs / 1000)}s`,
    };
  }

}
