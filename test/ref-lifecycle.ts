/**
 * Refs across an in-place document replacement, through the harness (the repl's API + the
 * driver's renderings), against a real throwaway Chrome.
 *
 * The page-side ref counter (`window.__mfNextK`) dies with the document; the driver's continuity
 * (known refs, change signatures, the delta base) does not, so a navigation or reload in the same
 * target could re-mint from e0 under a "refs remain valid" diff — and a stale ref the model holds
 * would click whatever carries that number in the new document. Pinned here:
 *  - a replaced document renders FULL, never as a diff against the old one;
 *  - its refs are numbered above the previous document's high-water mark (no collisions);
 *  - a ref from the previous document is refused honestly, never re-targeted;
 *  - a ref minted in the new document works.
 *
 * `node scripts/test.mjs ref-lifecycle`.
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

const page = (title: string, body: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title>${body}`)}`;

// Same two names in the opposite order, so a collided ref would land on the WRONG control.
const PAGE_A = page("Alpha", `<button aria-label="Account">Account</button><button aria-label="Workspace">Workspace</button>`);
const PAGE_B = page("Beta", `<button aria-label="Workspace">Workspace</button><button aria-label="Account">Account</button><button aria-label="Extra">Extra</button>`);

const refOf = (obs: string, label: string) => obs.match(new RegExp(`(e\\d+): \\w+ "${label}"`))?.[1];
const refNumbers = (obs: string) => [...obs.matchAll(/^\+? ?(e(\d+)): /gm)].map((m) => Number(m[2]));

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  delete process.env.COMPUTER_USE_OBS_DELTA;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);

  try {
    const a = firstText(await h.act("open_url", { url: PAGE_A }));
    const accountA = refOf(a, "Account");
    const highA = Math.max(...refNumbers(a));
    check("page A lists its controls", !!accountA && Number.isFinite(highA), a.split("\n").slice(0, 3).join(" | "));

    // ── In-tab navigation: a new document in the same target ─────────────────
    const b = firstText(await h.act("open_url", { url: PAGE_B }));
    check("a replaced document renders full, not as a diff", !b.includes("Changes since last observation"), b.split("\n")[0]);
    const numsB = refNumbers(b);
    check("its refs are minted above the previous document's high-water mark", numsB.length > 0 && Math.min(...numsB) > highA,
      `A high ${highA}, B ${numsB.join(",")}`);

    const stale = await h.act("click", { ref: accountA });
    check("a ref from the previous document is refused, not re-targeted", !stale.ok && /not among the refs currently in play/.test(stale.note),
      stale.note);

    // ── Reload: same URL, new document ───────────────────────────────────────
    const highB = Math.max(...numsB);
    const r = firstText(await h.act("reload"));
    const numsR = refNumbers(r);
    check("a reload renders full", !r.includes("Changes since last observation"), r.split("\n")[0]);
    check("refs after a reload continue above the last high-water mark", numsR.length > 0 && Math.min(...numsR) > highB,
      `B high ${highB}, after reload ${numsR.join(",")}`);

    const fresh = await h.act("click", { ref: refOf(r, "Extra") });
    check("a ref minted in the new document works", fresh.ok && !/not among the refs currently in play|could not locate/.test(firstText(fresh)),
      fresh.note || firstText(fresh).split("\n")[0]);

    await profile.driver.close();
  } finally {
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nREFS OK" : `\nREFS FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
