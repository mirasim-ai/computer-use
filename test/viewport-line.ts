/**
 * Viewport-position line test (`node scripts/test.mjs viewport-line`).
 *
 * `renderHeadLines` tells the model how much of the page its element list covers. The counter
 * must reach the last screen (no "scroll to see more" at the bottom), and a page between 1.0
 * and 1.5 viewports is still clipped and must say so — "no line" reads as "this is the whole page".
 *
 * Pure function of a Snapshot, so this is hermetic: a stub driver, no browser.
 */

import { ComputerUseDriver } from "../src/platform/driver.ts";
import { looksUnmarked } from "../src/platform/driver-lines.ts";
import type { Snapshot, TargetInfo } from "../src/platform/types.ts";

class StubDriver extends ComputerUseDriver {
  readonly platform = "stub";
  /** Fed by {@link positionLine}; no browser involved. */
  canned: Snapshot = { url: "u", title: "t", elements: [], text: "", meta: { scrollY: 0, viewportH: 800, docH: 800 } };
  protected snapshot(): Promise<Snapshot> { return Promise.resolve(this.canned); }
  screenshot(): Promise<Buffer> { throw new Error("unused"); }
  readText(): Promise<string> { throw new Error("unused"); }
  listTargets(): Promise<TargetInfo[]> { return Promise.resolve([]); }
  focusTarget(): never { throw new Error("unused"); }
  perform(): never { throw new Error("unused"); }
  close(): Promise<void> { return Promise.resolve(); }
  promptFragment(): string { return ""; }
  /** The line under test, isolated from the observation pipeline around it. */
  positionLine(meta: Snapshot["meta"]): string {
    const snap: Snapshot = { ...this.canned, meta };
    return this.renderHeadLines(snap, []).find((l) => /^Screen |^Partial view/.test(l)) ?? "";
  }
  /** The "not in the list below" line, from the same head render. */
  omissionLine(meta: Snapshot["meta"]): string {
    const snap: Snapshot = { ...this.canned, meta };
    return this.renderHeadLines(snap, []).find((l) => l.startsWith("NOTE: not in the list below")) ?? "";
  }
  /** One whole observation, for the details half of the contract. */
  observe(meta: Snapshot["meta"]): Promise<{ content: unknown[]; details?: Record<string, unknown> }> {
    this.canned = { ...this.canned, meta };
    return this.observeElements() as Promise<{ content: unknown[]; details?: Record<string, unknown> }>;
  }
}

const d = new StubDriver();
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// A page that fits: the list IS the whole page, and silence must mean exactly that.
check("page that does not scroll says nothing",
  d.positionLine({ scrollY: 0, viewportH: 800, docH: 800 }) === "");

// The silent band. 1.2 viewports withholds a fifth of its elements.
const band = d.positionLine({ scrollY: 0, viewportH: 800, docH: 960 });
check("1.2 viewports is no longer silent", band !== "", JSON.stringify(band));
check("band names the remainder in pixels", band.includes("160px below the fold"), band);
check("band offers the scroll", band.includes("scroll to see the rest"), band);

// The sliver a default 8px body margin produces: real scroll, nothing meaningful hidden.
// It must still be stated, and the pixel count is what keeps it from overselling.
const sliver = d.positionLine({ scrollY: 0, viewportH: 800, docH: 816 });
check("a 16px sliver is stated, not dramatized",
  sliver.startsWith("Partial view") && sliver.includes("16px below the fold"), sliver);

// Bottom of a short page: elements above the fold are missing from the list, so the clipping
// still has to be stated — but there is nothing below, so no scroll hint.
const bandBottom = d.positionLine({ scrollY: 160, viewportH: 800, docH: 960 });
check("band at the bottom still states the clipping", bandBottom.startsWith("Partial view"), bandBottom);
check("band at the bottom drops the scroll hint", !bandBottom.includes("scroll"), bandBottom);

// Above the threshold the screen counter takes over.
const tallTop = d.positionLine({ scrollY: 0, viewportH: 772, docH: 5023 });
check("tall page counts screens", tallTop.startsWith("Screen 1/7"), tallTop);
check("tall page at the top offers the scroll", tallTop.includes("scroll to see more"), tallTop);

const tallBottom = d.positionLine({ scrollY: 4251, viewportH: 772, docH: 5023 });
check("tall page reaches its last screen", tallBottom.startsWith("Screen 7/7"), tallBottom);
check("tall page at the bottom drops the scroll hint", !tallBottom.includes("scroll"), tallBottom);


// ── What the list does not show ─────────────────────────────────────────────────
// Silence has to keep meaning "the list is everything", so zeros print nothing.
check("nothing omitted prints no line", d.omissionLine({ scrollY: 0, viewportH: 800, docH: 800 }) === "");

// Offscreen elements on a page that SCROLLS: the position line above already said the list
// is viewport-clipped, so repeating it costs tokens on most observations and adds nothing.
const scrolls = d.omissionLine({ scrollY: 0, viewportH: 800, docH: 4000, offscreen: 34 });
check("offscreen is not restated when the position line already said it", scrolls === "", scrolls);

// The case the position line CANNOT cover: nothing to scroll to, yet the walk saw elements the
// list does not carry (horizontally out of view, or in an offscreen frame).
const noScroll = d.omissionLine({ scrollY: 0, viewportH: 800, docH: 800, offscreen: 34 });
check("offscreen IS stated when nothing else says the list is partial",
  noScroll.includes("offscreen controls"), noScroll);
// The way out cannot be the window scroll: maxScrollY is 0 here, so scrolling moves nothing
// and the next observation comes back `frozen` — a wasted step plus two lines that contradict
// each other. Whatever it names has to be something this page can actually do.
check("offscreen does not promise a scroll the document cannot do",
  !noScroll.includes("scroll to reach them") && !noScroll.includes("scroll direction:"), noScroll);
check("offscreen names a way out that exists here",
  noScroll.includes("find() searches them"), noScroll);

const cap = d.omissionLine({ scrollY: 0, viewportH: 800, docH: 800, capped: 12 });
check("capped elements are reported", cap.includes("exceed this observation's element cap"), cap);
// The cap is per-platform, so the base class must not quote a number it does not own.
check("the cap line quotes no cap value", !/\d+-element/.test(cap), cap);

const both = d.omissionLine({ scrollY: 0, viewportH: 800, docH: 800, offscreen: 5, capped: 7 });
check("both facts land in one line, separated", both.includes("offscreen controls") && both.includes("element cap") && both.includes("; "), both);
// The cap is never suppressed: scrolling is not the way out of it, so no other line covers it.
const cappedWhileScrolling = d.omissionLine({ scrollY: 0, viewportH: 800, docH: 4000, offscreen: 9, capped: 3 });
check("the cap is stated even on a scrolling page",
  cappedWhileScrolling.includes("element cap") && !cappedWhileScrolling.includes("offscreen controls"), cappedWhileScrolling);

// ── The unmarked-controls note: text-run shape, never a count ─────────────────────
// A page of two buttons over a paragraph must not trip "act by x/y" — wrong when both controls
// carry refs. The note is for pages whose controls the walk could NOT find, and what gives
// them away is a list of short runs.
const prose = (n: number) => Array.from({ length: n }, () => "A".repeat(200)).join("\n");
const rows = (n: number) => Array.from({ length: n }, (_, i) => `Row ${i} — a short item`).join("\n");
check("two buttons over a paragraph are a complete page", !looksUnmarked(2, `Heading\n${prose(1)}\nAccept\nDecline`));
check("one button under a long terms text is a marked page", !looksUnmarked(1, `Terms\n${prose(1)}`));
check("a ten-paragraph article with one button is prose, not rows", !looksUnmarked(1, prose(10)));
check("a list of rows with no controls looks unmarked", looksUnmarked(0, rows(4)));
check("a paragraph plus a couple of bare-span controls, no refs at all, looks unmarked (the smoke shape)", looksUnmarked(0, `${prose(1)}\ncount:0\n6`));
check("a paragraph and its heading, no controls, is just text", !looksUnmarked(0, `Terms\n${prose(1)}`));
check("a list of rows beside two real buttons looks unmarked", looksUnmarked(2, `Menu\nSearch\n${rows(8)}`));
check("a five-item toolbar over a canvas needs no text floor", looksUnmarked(0, "File\nEdit\nView\nLayer\nHelp"));
check("three controls never trip it, however the text is shaped", !looksUnmarked(3, rows(40)));
check("the cut receipt is not a run", !looksUnmarked(0, `${prose(2)}\n(cut at 4000 chars)`));

// ── details states the same facts as the prose ──────────────────────────────────
const obs = await d.observe({ scrollY: 4251, viewportH: 772, docH: 5023, offscreen: 9 });
const det = obs.details ?? {};
const vp = det.viewport as { screen: number; total: number; belowFold: number; atBottom: boolean } | undefined;
check("details carries the viewport it was read at", !!vp, JSON.stringify(det.viewport));
check("details agrees with the Screen line", vp?.screen === 7 && vp?.total === 7, JSON.stringify(vp));
check("details agrees about being at the bottom", vp?.atBottom === true && vp?.belowFold === 0, JSON.stringify(vp));
check("details carries the omission counts", JSON.stringify(det.notListed) === JSON.stringify({ offscreen: 9, capped: 0 }), JSON.stringify(det.notListed));
// obsKind is what tells a reader whether the body was a full list or a diff — the
// details enrichment must not have displaced it.
check("details still carries obsKind", det.obsKind === "full" || det.obsKind === "delta", String(det.obsKind));

const clean = await d.observe({ scrollY: 0, viewportH: 800, docH: 800 });
check("details omits notListed when nothing was omitted", !("notListed" in (clean.details ?? {})), JSON.stringify(clean.details));

console.log(failures === 0 ? "\nviewport-line: OK" : `\nviewport-line: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
