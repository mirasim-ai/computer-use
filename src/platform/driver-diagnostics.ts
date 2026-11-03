/**
 * The diagnostics channel — `diagnostics()`: console messages, page errors and failed network
 * requests in a ring buffer, rendered as counts + the most recent entries, one full entry
 * fetchable by id.
 *
 * Platform-neutral: platforms FEED it (chromium page listeners, the macos helper's log); shape
 * and wording live here so every platform renders it identically. A page erroring in a loop
 * emits thousands of lines in seconds, so the buffer drops oldest and COUNTS the drops, and the
 * render announces what it left out.
 */

import { text, type ToolResult } from "./types.ts";

export type DiagType =
  | "console.error" | "console.warn" | "console.log" | "console.info" | "console.debug"
  | "pageerror" | "network"
  /** A native platform's own log lines, e.g. macOS's AX helper stderr (`ax-client.ts` `onLog`). */
  | "helper";

interface DiagEntry {
  id: string; // "dN" — session-monotonic, so a dropped entry's id is never reused
  ts: number; // ms since collection started
  type: DiagType;
  text: string;
  /** Stack / long form — shown only by the id fetch, never in the list. */
  detail?: string;
  /** Page URL at event time — entries outlive navigations, so each carries its origin. */
  url: string;
}

/** Ring capacity: bounds memory and how far back an id fetch reaches; the list shows only the
 * newest {@link RECENT_N}. */
const RING_CAP = 300;
/** Per-entry ceiling — one console.log of a serialized store must not own the buffer. */
const ENTRY_CHARS = 2000;
/** What one listed line shows of an entry's text; the id fetch shows all of ENTRY_CHARS. */
const LINE_CHARS = 160;
const RECENT_N = 20;

const ERROR_TYPES: readonly DiagType[] = ["pageerror", "console.error"];

/** What a platform says this channel carries (the chromium sentence would be false on macOS).
 *  `empty` completes "No diagnostics — no …"; `header` is the list's first line. */
export interface DiagnosticsAbout { empty: string; header: string }

export const CHROMIUM_DIAGNOSTICS: DiagnosticsAbout = {
  empty: "console messages, page errors, or failed network requests",
  header: "console, page errors, failed network (request failures and HTTP \u2265 400; aborted requests excluded)",
};

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} chars)`;
}

/** A hash change is an in-page jump, not a load — compare everything else. */
function stripHash(u: string): string {
  const i = u.indexOf("#");
  return i < 0 ? u : u.slice(0, i);
}

export class DiagnosticsBuffer {
  constructor(private readonly about: DiagnosticsAbout = CHROMIUM_DIAGNOSTICS) {}

  private entries: DiagEntry[] = [];
  private seq = 0;
  private dropped = 0;
  private readonly started = Date.now();
  private counts = new Map<DiagType, number>();
  /** Error-class total already surfaced by {@link takeNote} — a counter, not a ring pointer, so
   * a burst that overflowed the cap is still counted. */
  private notedErrors = 0;
  /** Where the surface was at the last {@link takeNote}: a navigation in between tells LOAD-time
   * errors from ones an action caused. */
  private lastNoteUrl = "";
  /** Absolute ms of the last action that could be blamed for an error, 0 for none. A navigation
   * clears it (later errors belong to the LOAD). Known edge: a same-url reload reads as no
   * navigation, so its load errors are blamed on the reload. */
  private blamableActionAt = 0;
  /** Highest entry seq already surfaced — which entries are NEW, for the time comparison. The
   * COUNT comes from {@link notedErrors}. */
  private notedSeq = 0;
  /** Highest entry seq a {@link render} has shown — what "new since your last read" counts from.
   * The list is a window, not a cursor; without this a repeat read looks like a second round of
   * errors. */
  private readSeq = 0;

  push(type: DiagType, message: string, opts: { detail?: string; url?: string } = {}): void {
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
    this.entries.push({
      id: `d${++this.seq}`, ts: Date.now() - this.started, type,
      text: clip(message.replace(/\s*\n\s*/g, " ⏎ "), ENTRY_CHARS),
      ...(opts.detail ? { detail: clip(opts.detail, ENTRY_CHARS) } : {}),
      url: opts.url ?? "",
    });
    const over = this.entries.length - RING_CAP;
    if (over > 0) { this.entries.splice(0, over); this.dropped += over; }
  }

  /** Called once per dispatched action: an error arriving at or after this MAY be its doing. */
  markAction(): void {
    this.blamableActionAt = Date.now();
  }

  private errorTotal(): number {
    return ERROR_TYPES.reduce((n, t) => n + (this.counts.get(t) ?? 0), 0);
  }

  /**
   * One line for the next observation when NEW error-class entries arrived — so "try another
   * element" is not the whole story when the page's own code broke. Consuming: each error is
   * surfaced once.
   *
   * Blames the caller's action only if an action ran ({@link markAction}), no navigation
   * followed, and a NEW error arrived at or after it. Errors arrive on the page's clock, so
   * which observation carries them decides nothing, and filtering messages cannot tell a site's
   * own console.error from a provoked one; only timing against the action can.
   */
  takeNote(currentUrl = ""): string | null {
    const navigated = !!this.lastNoteUrl && !!currentUrl && stripHash(this.lastNoteUrl) !== stripHash(currentUrl);
    if (currentUrl) this.lastNoteUrl = currentUrl;
    if (navigated) this.blamableActionAt = 0;
    const blamesAction = this.blamableActionAt > 0 && this.entries.some((e) =>
      Number(e.id.slice(1)) > this.notedSeq && ERROR_TYPES.includes(e.type)
      && this.started + e.ts >= this.blamableActionAt);
    this.notedSeq = this.seq;
    const fresh = this.errorTotal() - this.notedErrors;
    this.notedErrors = this.errorTotal();
    if (fresh <= 0) return null;
    const latest = [...this.entries].reverse().find((e) => ERROR_TYPES.includes(e.type));
    const sample = latest ? ` (latest: ${latest.id} "${clip(latest.text, 120)}")` : "";
    const plural = fresh > 1 ? "s" : "";
    if (blamesAction) {
      return `NOTE: ${fresh} new page/console error${plural} since the last observation${sample} — `
        + "if your action seemed to have no effect, the page's own code may have failed; "
        + "read diagnostics() before concluding the element was wrong.";
    }
    const when = navigated ? "while this page loaded" : "since the last observation";
    return `NOTE: ${fresh} page/console error${plural} ${when}${sample} — the page's own; `
      + "read diagnostics() if something you do next has no effect.";
  }

  render(id?: string, currentUrl = ""): ToolResult {
    if (id !== undefined) return this.renderOne(id);
    if (this.seq === 0) {
      return text(
        `No diagnostics — no ${this.about.empty} since `
        + "collection started (at this session's first look at the surface).",
        { channel: "diagnostics", kept: 0, dropped: 0 },
      );
    }
    const order: DiagType[] = ["pageerror", "console.error", "console.warn", "console.log", "console.info", "console.debug", "network", "helper"];
    const countsLine = order.filter((t) => this.counts.get(t)).map((t) => `${t} ${this.counts.get(t)}`).join(", ");
    const recent = this.entries.slice(-RECENT_N);
    // Entries outlive navigations, so mark those from another host, else a fresh page's read
    // leads with the previous site's failures. Compare against where the surface IS (passed in),
    // never the newest entry: a quietly loading page adds none, so strays would match themselves.
    const host = (u: string) => { try { return new URL(u).host; } catch { return ""; } };
    const here = host(currentUrl);
    const from = (e: DiagEntry) => {
      const h = host(e.url);
      return h && here && h !== here ? ` ‹on ${h}›` : "";
    };
    const strays = recent.filter((e) => from(e)).length;
    const since = this.readSeq;
    this.readSeq = this.seq;
    const fresh = this.seq - since;
    const isNew = (e: DiagEntry) => since > 0 && Number(e.id.slice(1)) > since;
    const lines = [
      `Diagnostics — ${this.about.header}.`,
      `Counts since collection started: ${countsLine}.`
        + (this.dropped ? ` ${this.dropped} older entr${this.dropped > 1 ? "ies were" : "y was"} dropped at the ${RING_CAP}-entry cap.` : ""),
      `Most recent ${recent.length}${this.entries.length > recent.length ? ` of ${this.entries.length} kept` : ""} (oldest first; one full entry: diagnostics({id:'dN'}))`
        + (strays ? `; ${strays} of them happened on a page this surface has since left, marked ‹on host›` : "")
        + (since === 0 ? ":" : fresh === 0 ? " — NONE is new since your last read:" : `; ${fresh} new since your last read, marked new:`),
      ...recent.map((e) => `${e.id}${isNew(e) ? " new" : ""} [+${(e.ts / 1000).toFixed(1)}s]${from(e)} ${e.type}: ${clip(e.text, LINE_CHARS)}`),
    ];
    return text(lines.join("\n"), {
      channel: "diagnostics",
      kept: this.entries.length,
      dropped: this.dropped,
      counts: Object.fromEntries(this.counts),
    });
  }

  private renderOne(id: string): ToolResult {
    const e = this.entries.find((x) => x.id === id);
    if (!e) {
      const span = this.entries.length
        ? `kept entries currently span ${this.entries[0].id}–${this.entries[this.entries.length - 1].id}`
        : "the buffer is empty";
      return text(`no diagnostics entry '${id}' — it may have been dropped at the ring cap; ${span}.`, { error: "bad_id" });
    }
    return text(
      `${e.id} ${e.type} at +${(e.ts / 1000).toFixed(1)}s${e.url ? ` on ${e.url}` : ""}:\n${e.text}${e.detail ? `\n${e.detail}` : ""}`,
      { channel: "diagnostics", id: e.id, type: e.type },
    );
  }
}
