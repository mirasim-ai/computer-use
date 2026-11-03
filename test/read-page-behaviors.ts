/**
 * Behavior tests for the page-read channel (`h.observe({ what: "page" })`, the repl's `page()`) and the hover
 * reveal flow — against a real throwaway Chrome. Runs in `npm test` as `test:read-page`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawnChrome } from "./helpers.ts";
import { createHarness } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";
const fixture = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>rp</title>${html}`)}`;

/** Smallest PDF Chrome will hand to its own viewer — enough for a catalog, one page, xref. */
const MINIMAL_PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
  "trailer<</Root 1 0 R/Size 4>>",
  "%%EOF",
].join("\n");

async function main() {
  const chrome = await spawnChrome({});
  // A local server, because the two documents below must arrive with a real content-type;
  // a data: URL cannot put Chrome into its PDF viewer.
  const server = http.createServer((req, res) => {
    if (req.url === "/doc.pdf") { res.setHeader("content-type", "application/pdf"); res.end(MINIMAL_PDF); }
    else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ readable: "this text is in the tree" })); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);
  const open = (html: string) => h.act("open_url", { url: fixture(html) });
  const page = (extra: { depth?: number; node?: string } = {}) => h.observe({ what: "page", ...extra }).then(firstText);

  try {
    // ── Reader cuts vs page clips are DIFFERENT facts in the receipt ─────────────
    await open(`<main><p>${"long ".repeat(700)}end</p><p>…continued snippet the page elided</p></main>`);
    const cutRead = await page();
    check("giant prose is cut with an inline marker", cutRead.includes(`cut at 3000 chars — the page has the full text`));
    check("receipt counts reader cuts", /\d+ text blocks? cut by the reader/.test(cutRead));
    check("page-side snippet is flagged separately", cutRead.includes("clipped by the page"));
    check("receipt names page clips as the page's own", /snippets? clipped by the page itself/.test(cutRead));

    // ── depth floor folds behind a drill handle; the handle reaches the content ──
    await open(`<div aria-label="Outer"><div aria-label="Inner"><p>deep treasure text</p></div></div>`);
    const shallow = await page({ depth: 1 });
    check("depth floor folds the branch", /⋯ folded ~\d+ items/.test(shallow), shallow.split("\n")[0]);
    const handle = shallow.match(/\(node (n\d+)\)/)?.[1];
    check("fold carries a drill handle", !!handle);
    const drilled = await page({ node: handle! });
    check("drilling the handle reads the deep content", drilled.includes("deep treasure text"));
    check("drill scope is named in the receipt", drilled.startsWith(`page read: drill ${handle}`));

    // ── duplicate whole-page read short-circuits ──────────────────────────────────
    await open(`<main><p>stable content</p></main>`);
    await page();
    const dup = await page();
    check("identical re-read is short-circuited", dup.includes("identical to your previous page read"));

    // ── over-budget: honest refusal, never half a tree ───────────────────────────
    await open(`<ul>${Array.from({ length: 600 }, (_, i) => `<li>row number ${i} with some padding text</li>`).join("")}</ul>`);
    const wide = await page({ depth: 3 });
    check("explicit depth over budget names the size and refuses", /the tree is ~\d+ chars at depth 3/.test(wide) || wide.includes("too wide"), wide.split("\n")[0]);
    check("refusal offers the ref escape hatch", wide.includes("ref"));

    // ── unscrolled content shows up in the receipt ───────────────────────────────
    await open(`<div style="height:6000px">tall spacer</div><p>bottom text</p>`);
    const tall = await page();
    check("unscrolled screens are declared", tall.includes("more screens below have not been scrolled into view"), tall.split("\n")[0]);

    // ── a canvas is content this reader cannot reach, and the receipt must say so ──
    // A canvas reaches the tree as a bare 'canvas' marker, which reads as an empty node.
    // Measured on excalidraw.com: the whole drawing surface rendered as two such
    // markers and the receipt still called itself "complete" — the one line negative-proof
    // workflows anchor on.
    await open(`<p>toolbar</p><canvas width="400" height="300"></canvas>`);
    const drawn = await page();
    check("a sizeable canvas is declared in the receipt", /1 canvas draws content no text read can reach/.test(drawn), drawn.split("\n")[0]);
    check("a page with a canvas never calls itself complete", !drawn.includes("complete: nothing folded"), drawn.split("\n")[0]);
    check("the receipt points at the one channel that can see it", drawn.split("\n")[0].includes("screenshot()"));
    await open(`<p>sparkline</p><canvas width="40" height="20"></canvas>`);
    const tiny = await page();
    check("an icon-sized canvas does not trip the receipt", tiny.includes("complete: nothing folded"), tiny.split("\n")[0]);

    // ── a document the browser renders ITSELF is declared, and only then ─────────
    // Measured on a live .pdf: document.body has zero children, zero text and zero
    // canvases while the observation still lists 30 controls (the viewer's own toolbar), and
    // the receipt called that "complete". The type alone would over-claim — Chrome renders
    // application/json as text the tree reads fine — so the claim needs an empty tree too.
    await h.act("open_url", { url: `${base}/doc.pdf` });
    await h.act("wait", {});
    const pdf = await page();
    check("a browser-rendered document is declared in the receipt",
      /this document is application\/pdf, which the browser renders in a viewer of its own/.test(pdf), pdf.split("\n")[0].slice(0, 150));
    check("and it never calls itself complete", !pdf.includes("complete: nothing folded"), pdf.split("\n")[0].slice(0, 80));
    await h.act("open_url", { url: `${base}/data.json` });
    await h.act("wait", {});
    const json = await page();
    check("a non-HTML document the tree DID read says nothing of the kind",
      !/renders in a viewer of its own/.test(json) && json.includes("this text is in the tree"), json.split("\n")[0].slice(0, 110));

    // ── what:'text' reads the open dialog, not just the page under it ────────────
    // A portal dialog is a sibling of <main>; reading <main> alone returned the app's main view under
    // a settings dialog and none of the dialog (observed on electron). Hidden dialogs stay out.
    await open(`<main><p>text under the dialog</p></main>
      <div role="dialog"><p>dialog body text</p><button>OK</button></div>
      <div role="dialog" style="display:none"><p>closed dialog text</p></div>`);
    const withDialog = firstText(await h.observe({ what: "text" }));
    check("open dialog text is read", withDialog.includes("dialog body text"), withDialog.split("\n")[0]);
    check("the dialog comes before the page it covers",
      withDialog.indexOf("dialog body text") < withDialog.indexOf("text under the dialog"));
    check("the page under the dialog is still read", withDialog.includes("text under the dialog"));
    check("a hidden dialog is not read", !withDialog.includes("closed dialog text"));

    // ── hover reveal: the 400ms beat makes the menu visible to the NEXT frame ───
    const navText = firstText(await open(`<style>.menu{display:none}.wrap:hover .menu{display:block}</style>
      <div class="wrap"><button>Files</button><div class="menu"><a href="#r">Open recent</a></div></div>`));
    const btn = navText.match(/(e\d+): button "Files"/)?.[1];
    check("menu is hidden before hover", !!btn && !navText.includes("Open recent"));
    const hov = firstText(await h.act("hover", { ref: btn!, name: "Files" }));
    check("hover result carries the teaching note", hov.includes("hovering — anything revealed"));
    check("revealed menu item is in the hover result's observation", hov.includes("Open recent"));

    await profile.driver.close();
  } finally {
    chrome.cleanup();
    server.close();
  }

  console.log(failures === 0 ? "\nREAD-PAGE BEHAVIORS OK" : `\nREAD-PAGE BEHAVIORS FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
