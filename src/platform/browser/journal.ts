/**
 * Action journal — the managed browser's observer side-channel. One line per performed action
 * lands in the run dir's actions.jsonl, plus a screenshot of the page after it
 * (`shots/<seq>.jpg`, named by the line's `shot` field). A host's live preview animates a pointer
 * from `x`/`y`; an auditor replays the run from the semantic fields and the shots.
 *
 * Fire-and-forget by contract: callers never await and every error is swallowed — publication
 * must not fail or slow a turn.
 */

import { appendFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ActResult } from "../types.ts";
import { actionsFileFor, shotsDirFor } from "./acquire.ts";
import { browserConfigFromEnv, type BrowserConfig } from "./config.ts";

/** actions.jsonl cap: past this the file is truncated before the next append. Observers want
 * recent lines, and an unbounded ledger grows for the browser's whole multi-session life. */
const ACTIONS_FILE_MAX_BYTES = 256 * 1024;
/** Evidence shots kept in shots/ (rolling); COMPUTER_USE_SHOTS_KEEP overrides. The JPEGs are
 * the weight, so they get their own cap. */
const DEFAULT_SHOTS_KEEP = 500;

/** How many evidence shots to keep (rolling); 0 disables per-action screenshots entirely.
 * Read per action, not cached, so hosts and tests can adjust it live. */
function shotsKeep(): number {
  const raw = process.env.COMPUTER_USE_SHOTS_KEEP?.trim();
  if (!raw) return DEFAULT_SHOTS_KEEP;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_SHOTS_KEEP;
}

export class ActionJournal {
  /** Serializes writes: lines land in action order, and a line is only readable once its
   * shot file is on disk. Never awaited by the action path. */
  private chain: Promise<void> = Promise.resolve();
  /** Last allocated shot number; null until the first shot scans the dir and resumes after
   * the highest sequence already on disk (numbering continues across sessions). */
  private shotSeq: number | null = null;

  constructor(
    private readonly profileDir: string,
    /** The page AFTER the action, through the driver's own handle; null when it cannot
     * be taken — the line then simply carries no `shot` field. */
    private readonly takeShot: () => Promise<Buffer | null>,
    /** Current page URL, or "" when the page is gone (still an action to record). */
    private readonly currentUrl: () => string,
    /** The session's resolved config, which carries the run slug the journal files under. Pass
     *  it: with the env default, a driver built from explicit options journals under the profile
     *  dir's basename, a slot nobody watches. */
    private readonly cfg: BrowserConfig = browserConfigFromEnv(),
  ) {}

  /**
   * Publish one action line. `ts`/`kind`/`url`/`ok` are always present; every other
   * field is written only when the driver actually knows it — absent, never null:
   *
   *   x/y        page-CSS-pixel action point (given coordinates, or the located element's center)
   *   name       the element name the action targeted
   *   text       what set_text wrote — verbatim, it is behavioral evidence, never redacted
   *   chord      the keys chord as requested
   *   direction  scroll paging direction; `to` a scroll jump (top/bottom)
   *   moved      scroll only: MEASURED displacement in px (via ActResult.journal) — the
   *              field that keeps "reported" and "happened" from drifting apart
   *   container  scroll only: the container that was scrolled (name, or "window")
   *   target     the tab id a focus switched to
   *   auto       true on a focus the MODEL never asked for — the driver moved the active
   *              surface itself (a tab it opened became real, or the one it was on closed).
   *              Without it a replay cannot tell an intended tab switch from a drift.
   *   note       the failure reason (first line) when ok is false
   *   shot       relative path to the post-action screenshot, when one could be taken
   */
  publishAction(kind: string, a: Record<string, any>, point: { x: number; y: number } | null, res: ActResult): void {
    const line: Record<string, unknown> = { ts: Date.now(), kind, url: this.currentUrl() };
    if (typeof a.x === "number" && typeof a.y === "number") {
      line.x = a.x; line.y = a.y;
    } else if (point) {
      // Ref-grounded action: the element's center, captured by locate() BEFORE the action
      // ran (a navigating click destroys the element, so there is no "after" to measure).
      line.x = point.x; line.y = point.y;
    }
    if (typeof a.name === "string" && a.name) line.name = a.name;
    if (kind === "set_text" && typeof a.text === "string") line.text = a.text;
    if (kind === "keys" && typeof a.chord === "string") line.chord = a.chord;
    if (kind === "scroll") {
      if (typeof a.direction === "string") line.direction = a.direction;
      if (typeof a.to === "string") line.to = a.to;
      if (typeof a.into === "string") line.into = a.into;
    }
    if (kind === "focus" && typeof a.target === "string") line.target = a.target;
    if (kind === "focus" && a.auto === true) line.auto = true;
    // Driver-measured facts (scroll: moved px, container name). Merged BEFORE ok/note so
    // the dispatch verdict always wins on a key collision.
    if (res.journal) Object.assign(line, res.journal);
    line.ok = res.ok;
    if (!res.ok && res.note) line.note = res.note;
    this.chain = this.chain
      .then(() => this.writeJournalLine(line))
      .catch(() => { /* observer channel only — never load-bearing */ });
  }

  /** Frozen verdicts go to the journal too: a stream of only ok:true lines reads as progress
   * even when nothing on screen changed. No shot: it is not an action. */
  publishVerdict(verdict: string): void {
    const line: Record<string, unknown> = { ts: Date.now(), kind: "verdict", verdict, url: this.currentUrl() };
    this.chain = this.chain
      .then(() => this.appendActionLine(line))
      .catch(() => { /* observer channel only — never load-bearing */ });
  }

  /**
   * Wait for what is already queued to land, bounded. `close()` calls this before disconnecting:
   * the last link screenshots through the DRIVER's page handle, so disconnecting first leaves the
   * run's last action without a `shot`. Whatever has not landed by the bound is lost; callers
   * never see an error.
   */
  async drain(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.chain.catch(() => {}),
        // NOT unref'd: in a process whose only pending work is this drain (a CLI exiting), Node
        // would exit before the timer fires and everything after `await drain()` in close()
        // would silently not run.
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The chained half of {@link publishAction}: shot first — so the line can name it and
   * the file exists by the time the line is readable — then the line. */
  private async writeJournalLine(line: Record<string, unknown>): Promise<void> {
    const keep = shotsKeep();
    if (keep > 0) {
      const bytes = await this.takeShot();
      if (bytes) {
        const shotsDir = shotsDirFor(this.profileDir, this.cfg);
        await mkdir(shotsDir, { recursive: true });
        const seq = await this.nextShotSeq(shotsDir);
        // .jpg because screenshotMimeType declares image/jpeg — extension follows the bytes.
        if (await writeFile(join(shotsDir, `${seq}.jpg`), bytes).then(() => true, () => false)) {
          line.shot = `shots/${seq}.jpg`;
        }
        await this.pruneShots(shotsDir, keep);
      }
    }
    await this.appendActionLine(line);
  }

  /** Append one line to actions.jsonl (with the size cap) — shared by action lines
   * (which add a shot first) and shot-less lines (verdicts). */
  private async appendActionLine(line: Record<string, unknown>): Promise<void> {
    const file = actionsFileFor(this.profileDir, this.cfg);
    await mkdir(dirname(file), { recursive: true });
    const size = await stat(file).then((s) => s.size).catch(() => 0);
    if (size > ACTIONS_FILE_MAX_BYTES) await writeFile(file, "");
    await appendFile(file, `${JSON.stringify(line)}\n`);
  }

  /** Next shot number: monotonic within the run dir and across sessions — first use scans
   * the dir and resumes after the highest sequence already there. */
  private async nextShotSeq(shotsDir: string): Promise<number> {
    if (this.shotSeq === null) {
      let max = 0;
      for (const name of await readdir(shotsDir).catch(() => [] as string[])) {
        const m = /^(\d+)\.jpg$/.exec(name);
        if (m) max = Math.max(max, Number(m[1]));
      }
      this.shotSeq = max;
    }
    return ++this.shotSeq;
  }

  /** Rolling disk cap: delete all but the newest `keep` shots. */
  private async pruneShots(shotsDir: string, keep: number): Promise<void> {
    const seqs: number[] = [];
    for (const name of await readdir(shotsDir).catch(() => [] as string[])) {
      const m = /^(\d+)\.jpg$/.exec(name);
      if (m) seqs.push(Number(m[1]));
    }
    seqs.sort((x, y) => x - y);
    for (const s of seqs.slice(0, Math.max(0, seqs.length - keep))) {
      await rm(join(shotsDir, `${s}.jpg`), { force: true }).catch(() => {});
    }
  }
}
