/**
 * Nesting suppression (`node scripts/test.mjs nesting`) — against a real throwaway Chrome.
 *
 * `cursor: pointer` is the fallback signal that rescues a `div+onclick` row with no role, but
 * `cursor` is INHERITED, so unsuppressed every named element in the chain comes back as its own
 * `button` ref (a TOC `<li><a>Career</a></li>` as button "Career" + link "Career").
 *
 * The shapes below are the whole rule. Cases 3 and 6 are why it is not "collapse a chain": the
 * plain clickable row is what the fallback exists for, and a clickable card wrapping a link has
 * TWO real targets. A regression shows here either way — too many refs, or a lost one.
 */

import { spawnChrome } from "./helpers.ts";
import { createHarness } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const CSS = `
  .toc li { cursor: pointer; list-style: none }
  .cite { cursor: pointer }
  .row { cursor: pointer }
`;
const fixture = (html: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>nest</title><style>${CSS}</style>${html}`)}`;

/** The `eN: role "name"` lines of an observation, as `role "name"` pairs in list order. */
const listed = (s: string): string[] =>
  s.split("\n").filter((l) => /^e\d+: /.test(l)).map((l) => l.replace(/^e\d+: /, "").replace(/ ⟨row:.*$/, ""));

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);
  const show = async (html: string): Promise<string[]> => {
    await h.act("open_url", { url: fixture(html) });
    const r = (await h.observe({ what: "elements" })) as { content: Array<{ type: string; text?: string }> };
    return listed(r.content.find((c) => c.type === "text")?.text ?? "");
  };
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  try {
    // 1. A pass-through wrapper: the <li> adds no text of its own, so only the link is a target.
    let got = await show(`<ul class=toc><li><a href="#c">Career</a></li><li><a href="#r">Refs</a></li></ul>`);
    check("wrapper li > a: only the links", same(got, ['link "Career"', 'link "Refs"']), got.join(" | "));

    // 2. Fragments of a real control: the <a> captures the click, the brackets are not targets.
    got = await show(`<p>t<a class=cite href="#n"><span>[</span><span>1</span><span>]</span></a></p>`);
    check("a > bracket spans: only the link", same(got, ['link "[1]"']), got.join(" | "));

    // 3. The row the fallback exists for — with and without an inner span. One ref each, never zero.
    got = await show(`<div class=row onclick="void 0">Invoice 4471</div>
                      <div class=row onclick="void 0"><span>Invoice 4472</span></div>`);
    check("div+onclick rows survive", same(got, ['button "Invoice 4471"', 'button "Invoice 4472"']), got.join(" | "));

    // 4. The wrapper's name differs, so whether it has a handler of its own is unknowable —
    //    kept. Its "(3)" span is not a second target: a click on it reaches the wrapper.
    got = await show(`<ul class=toc><li><a href="#t">Read</a> <span>(3)</span></li></ul>`);
    check("wrapper with extra text is kept, its span is not", same(got, ['button "Read (3)"', 'link "Read"']), got.join(" | "));

    // 5. A real control's own spans were never listed — the guard must not change that.
    got = await show(`<button><span>Save</span> <span>draft</span></button>`);
    check("button > spans: one ref", same(got, ['button "Save draft"']), got.join(" | "));

    // 6. TWO real targets: the card's handler and a link that goes elsewhere. The card's own
    //    <h3>/<span> are neither.
    got = await show(`<div class=row onclick="void 0"><a href="#b">Acme</a><h3>Wireless Mouse</h3><span>$19.00</span></div>`);
    check("clickable card keeps its ref, and the link keeps its own",
      same(got, ['button "Acme Wireless Mouse $19.00"', 'link "Acme"']), got.join(" | "));

    // 7. Same name as the real control it wraps: a pass-through, whatever tag it is.
    got = await show(`<div class=row onclick="void 0"><button>Dismiss</button></div>`);
    check("same-named wrapper of a real button collapses", same(got, ['button "Dismiss"']), got.join(" | "));

    // 8. An icon-only close control (an ad strip's: a div holding one svg) is named from its own
    //    close class, so the pointer fallback lists it. A WHOLE class word only: a state class or
    //    a word that merely contains "close" names nothing, and neither does a close control still
    //    counting down (cursor none: not clickable yet).
    const svg = `<svg width=12 height=12><circle cx=6 cy=6 r=5 /></svg>`;
    got = await show(`<div class="close close--rounded" style="cursor:pointer">${svg}</div>`
      + `<div class="panel is-closed" style="cursor:pointer">${svg}</div>`
      + `<div class="disclosure" style="cursor:pointer">${svg}</div>`
      + `<div class="close close--delay" style="cursor:none">${svg}</div>`);
    check("an icon-only close control is listed as close; look-alike classes are not",
      same(got, ['button "close"']), got.join(" | "));
  } finally {
    chrome.cleanup();
  }
  console.log(failures ? `\n${failures} nesting check(s) failed` : "\nall nesting checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
