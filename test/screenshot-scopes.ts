/**
 * Scoped screenshots, end to end against a real Chrome: element (ref) shots crop to the
 * element's bounds, region shots to the requested rect IN VIEWPORT COORDINATES (asserted
 * by content: the same rect before and after a scroll must capture different pixels),
 * fullPage shots cover the whole document, and the error paths answer with the standard
 * wording.
 */

import { spawnChrome } from "./helpers.ts";
import { createHarness } from "./harness.ts";

const FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><title>shot scopes</title>
<body style="margin:0">
  <div style="width:400px;height:120px;background:#0a5;color:#fff;font:20px sans-serif">HERO BLOCK</div>
  <button style="position:absolute;left:40px;top:200px;width:220px;height:64px;box-sizing:border-box">Target button</button>
  <div style="height:2600px;background:linear-gradient(#fff,#333)"></div>
  <div style="height:120px;background:#c33;color:#fff;font:20px sans-serif">DEEP CONTENT</div>
</body>`)}`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";
const image = (r: { content: Array<{ type: string; data?: string }> }) =>
  r.content.find((c) => c.type === "image")?.data ?? "";

/** Width/height from JPEG SOF markers — enough to assert crop dimensions. */
function jpegDims(b64: string): { width: number; height: number } {
  const buf = Buffer.from(b64, "base64");
  for (let i = 2; i + 9 < buf.length; ) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("no SOF marker");
}

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);

  try {
    const nav = await h.act("open_url", { url: FIXTURE });
    const ref = firstText(nav).match(/(e\d+): button "Target button"/)?.[1];
    check("button ref found", !!ref);

    // Element shot: cropped to the button's 220×64 box (±2 for rounding).
    const el = await h.observe({ what: "screenshot", ref });
    const elDims = jpegDims(image(el));
    check("element shot crops to the element", Math.abs(elDims.width - 220) <= 2 && Math.abs(elDims.height - 64) <= 2, `${elDims.width}×${elDims.height}`);
    check("element shot names what it captured", firstText(el).includes(`element ${ref}`), firstText(el));
    check("element shot carries the grounding caveat", firstText(el).includes("FULL screenshots"));
    check("element shot is marked scoped", el.details?.scoped === true);

    // Padded element shot: the same box grown by 30px on every side, so its surroundings show.
    const padded = await h.observe({ what: "screenshot", ref, padding: 30 });
    const padDims = jpegDims(image(padded));
    check("padding widens the element shot on every side", Math.abs(padDims.width - 280) <= 2 && Math.abs(padDims.height - 124) <= 2, `${padDims.width}×${padDims.height}`);
    check("padded shot says how much it added", firstText(padded).includes(`element ${ref} with 30px around it`), firstText(padded));
    const loose = await h.observe({ what: "screenshot", padding: 30 });
    check("padding without ref is refused by name", firstText(loose).includes("pass it with ref"), firstText(loose));

    // Region shot: exactly the requested rect.
    const rg = await h.observe({ what: "screenshot", region: { x: 0, y: 0, width: 320, height: 140 } });
    const rgDims = jpegDims(image(rg));
    check("region shot matches the requested rect", rgDims.width === 320 && rgDims.height === 140, `${rgDims.width}×${rgDims.height}`);
    check("region shot names rect and viewport", /region 320×140 at \(0,0\) of the \d+×\d+ viewport/.test(firstText(rg)), firstText(rg));

    // Region coordinates are VIEWPORT space: the same rect after a scroll must show
    // different content. (Identical pixels would re-encode to identical JPEG bytes.)
    await h.act("scroll", { to: "bottom" });
    const rg2 = await h.observe({ what: "screenshot", region: { x: 0, y: 0, width: 320, height: 140 } });
    check("region is viewport-relative (content changes after scroll)", image(rg) !== image(rg2));

    // Full page: covers the whole ~2840px document, and the note warns it is tall.
    const fp = await h.observe({ what: "screenshot", fullPage: true });
    const fpDims = jpegDims(image(fp));
    check("fullPage covers the document", fpDims.height >= 2600, `${fpDims.width}×${fpDims.height}`);
    check("fullPage note reports page and viewport size", /full page \d+×\d+, viewport \d+×\d+/.test(firstText(fp)), firstText(fp));
    check("fullPage warns when very tall", firstText(fp).includes("very tall"));

    // Error paths: stale ref, more than one scope, bad region. A LOOK never claims an action
    // failed — this channel dispatches nothing, and saying otherwise sent models hunting for a
    // side effect that never happened.
    const stale = await h.observe({ what: "screenshot", ref: "e9999" });
    check("stale ref rejected in the platform's own terms, with no action claimed",
      firstText(stale).includes("not among the refs currently in play")
      && firstText(stale).includes("a navigation, a reload or a tab switch")
      && !firstText(stale).includes("Action failed"), firstText(stale).split("\n")[0]);
    const both = await h.observe({ what: "screenshot", ref, fullPage: true });
    check("two scopes rejected", firstText(both).includes("exactly one"), firstText(both));
    const bad = await h.observe({ what: "screenshot", region: { x: 0, y: 0, width: -5, height: 10 } });
    check("bad region rejected", firstText(bad).includes("positive width and height"));

    // Plain screenshot unchanged: exactly the viewport (as the region note reported it),
    // no scoped marker.
    const vp = firstText(rg).match(/of the (\d+)×(\d+) viewport/)!;
    const plain = await h.observe({ what: "screenshot" });
    const plainDims = jpegDims(image(plain));
    check(
      "unscoped screenshot stays whole-view",
      plainDims.width === Number(vp[1]) && plainDims.height === Number(vp[2]) && plain.details?.scoped === undefined,
      `${plainDims.width}×${plainDims.height} vs viewport ${vp[1]}×${vp[2]}`,
    );


    await profile.driver.close();
  } finally {
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nSCOPES OK" : `\nSCOPES FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
