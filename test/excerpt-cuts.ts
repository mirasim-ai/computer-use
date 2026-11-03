/**
 * Truncation receipts (`node scripts/test.mjs excerpt-cuts`) — against a real throwaway Chrome.
 *
 * A silent cut reads as "this is all there is", so three reads end in a receipt
 * when they cut: the viewport excerpt at its line cap and at its char cap, and the
 * whole-page text read at its own char cap.
 *
 * The last check is the load-bearing one. The excerpt lands in `s.text`, which is
 * part of the change signature (`ComputerUseDriver.signature`), so a receipt that carried
 * the ACTUAL length would move with the content and make a frozen observation look
 * changed — the repeat-action escalation would stop firing. The receipt therefore
 * names the CAP, and two differently-oversized pages must produce byte-identical
 * receipt text.
 */

import { spawnChrome } from "./helpers.ts";
import { createHarness } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";
const fixture = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>cut</title>${html}`)}`;
/** Text plus `details` — the boundary checks need the verdict, not just the prose. */
type Observed = { text: string; details?: Record<string, unknown> };
async function observation(p: Promise<unknown>): Promise<Observed> {
  const r = (await p) as { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };
  return { text: r.content.find((c) => c.type === "text")?.text ?? "", ...(r.details ? { details: r.details } : {}) };
}

/** The receipt line, whichever cut produced it. */
const receipt = (s: string, what: "lines" | "chars") =>
  s.split("\n").find((l) => l.startsWith("(cut at") && l.includes(what)) ?? "";

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  // Every observation here must carry the excerpt: a delta round re-sends only the
  // diff, and the receipt lives in the body. The escape hatch is the supported way
  // to ask for full renders (see ComputerUseDriver.renderObservation).
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);
  const open = (html: string) => h.act("open_url", { url: fixture(html) });
  const elements = () => h.observe({ what: "elements" }).then(firstText);
  const fullText = () => h.observe({ what: "text" }).then(firstText);

  try {
    // ── excerpt: line cap ────────────────────────────────────────────────────
    // Many short paragraphs, all in view: the walk stops at the line cap long
    // before the char cap.
    // Inline, 2px: hundreds of separate text nodes fit INSIDE the viewport, which is
    // what the line cap counts — stacked paragraphs run out of viewport first.
    await open(`<main style="font-size:2px">${Array.from({ length: 400 }, (_, i) => `<span>row ${i} </span>`).join("")}</main>`);
    const lineCut = await elements();
    check("excerpt says it stopped at the line cap", receipt(lineCut, "lines").includes("cut at 120 lines"), receipt(lineCut, "lines"));
    // The receipt is a claim about how much was kept, so count it: a receipt that misreports its
    // own cut is worse than none.
    const excerptBody = lineCut.split("\n");
    const head = excerptBody.findIndex((l) => l.startsWith("Body excerpt"));
    const cutAt = excerptBody.findIndex((l) => l.startsWith("(cut at") && l.includes("lines"));
    check("the line receipt counts what was actually kept", head >= 0 && cutAt - head - 1 === 120,
      `${cutAt - head - 1} lines before the receipt`);

    // ── excerpt: char cap ────────────────────────────────────────────────────
    // Few nodes, each enormous: the char cap lands first, and the receipt has to
    // survive its own slice.
    await open(`<main style="font-size:2px"><p>${"alpha ".repeat(900)}</p><p>${"beta ".repeat(900)}</p></main>`);
    const charCut = await elements();
    check("excerpt says it stopped at the char cap", receipt(charCut, "chars").includes("cut at 4000 chars"), receipt(charCut, "chars"));
    // A receipt appended before the slice would come back clipped mid-sentence.
    check("the char receipt survives its own slice whole", receipt(charCut, "chars") === "(cut at 4000 chars — the page has the full text)");

    // ── whole-page read: its own cap, and its own wording ────────────────────
    await open(`<main><p>${"gamma ".repeat(9000)}</p></main>`);
    const read = await fullText();
    check("the text read says the page continues", read.includes("(cut at 40000 chars — the page continues past this)"));
    check("the text read does not borrow the excerpt's pointer", !read.includes("the page has the full text"));

    // ── the receipt is a constant, not a measurement ─────────────────────────
    await open(`<main style="font-size:2px"><p>${"delta ".repeat(1500)}</p></main>`);
    const other = await elements();
    check(
      "two differently-oversized pages give byte-identical receipts",
      receipt(other, "chars") === receipt(charCut, "chars") && receipt(charCut, "chars") !== "",
      `${JSON.stringify(receipt(charCut, "chars"))} vs ${JSON.stringify(receipt(other, "chars"))}`,
    );
    // ── The cap boundary: crossing it is a change, sitting past it is not ────
    // The receipt lands in `s.text`, part of the change signature: appearing is a real change
    // (the content grew), but once there it must not churn the signature, or the frozen verdict
    // (and the repeat-action escalation) would never fire on an oversized page.
    const filler = "lorem ipsum dolor sit amet consectetur ".repeat(95); // ~3.6k chars, under the cap
    await open(`<main style="font-size:2px"><p id="p">${filler}</p>`
      + `<button onclick="document.getElementById('p').textContent += ' ${"grown text ".repeat(60)}'">Grow</button></main>`);
    const under = await elements();
    check("under the cap there is no receipt", receipt(under, "chars") === "", receipt(under, "chars"));
    const growRef = under.match(/(e\d+): button "Grow"/)?.[1];
    check("the grow button has a ref", !!growRef, String(growRef));
    const afterGrow = await observation(h.act("click", { ref: growRef, name: "Grow" }));
    check("crossing the cap shows the receipt", receipt(afterGrow.text, "chars") !== "", receipt(afterGrow.text, "chars"));
    check("crossing the cap reads as a change", afterGrow.details?.verdict === "changed", String(afterGrow.details?.verdict));
    const stillOver = await observation(h.observe({ what: "elements" }));
    check("sitting past the cap reads as frozen, not perpetual change",
      stillOver.details?.verdict === "frozen", String(stillOver.details?.verdict));
    check("and the receipt is still there while frozen", receipt(stillOver.text, "chars") !== "", receipt(stillOver.text, "chars"));
  } finally {
    chrome.cleanup();
  }

  console.log(failures ? `\nexcerpt-cuts: ${failures} FAILED` : "\nexcerpt-cuts: OK");
  process.exit(failures ? 1 : 0);
}

void main();
