/**
 * Page reading — the `page()` channel.
 *
 * What it answers that `elements`/`text` cannot: the page's CONTENT STRUCTURE — which
 * text belongs to which card, what is folded away, and whether the read was complete.
 * Every read opens with a completeness receipt; "prove something is absent" workflows
 * anchor on that line, so its wording is contract, not decoration.
 *
 * Ground rules:
 *  - Prune, never re-order: a card's sender/time/preview stay separate nodes; prose is
 *    concatenated ONLY when the element mixes text with inline markup and contains no
 *    interactive descendants (`<p>foo <b>bar</b> baz</p>` reads "foo bar baz", never
 *    "foo baz bar"). Mixed text+interactive children become ordered runs instead.
 *  - Never return half a tree: over budget → an honest error naming the depth that fits.
 *  - Our cuts vs the page's cuts are different facts: a block we truncated says the page
 *    has the full text; a snippet the page itself elided (leading ellipsis) says the
 *    full text only exists behind the item.
 */

import type { ToolResult } from "../types.ts";
import { text } from "../types.ts";
import { pageFn } from "./collect.ts";
import { unreachedFacts, type Unreached } from "./unreached.ts";
import { TREE_JS } from "./read-page-script.ts";
import type { Page } from "playwright-core";


/** Rendered-tree budget (chars). Past this the read refuses and names a depth that fits. */
const TREE_BUDGET = 8000;
/** Per-text-run cap: one prose block may not eat the whole budget. */
const TEXT_RUN_CAP = 3000;
/** Depth ladder tried when an unlimited read overflows the budget. */
const FIT_LADDER = [6, 4, 3, 2, 1];

/** Sticky drill-handle + subtree state, held by the driver per surface. */
export interface PageReadState {
  /** Canonical JSON of the last WHOLE-page read, for the duplicate-read short-circuit. */
  lastFullUrl?: string;
  lastFullCanon?: string;
}

interface TreeNode {
  text?: string;        // own prose (concatenated inline runs) or one ordered text run
  name?: string;        // container aria-label, or media placeholder name
  role?: string;        // interactive role
  ref?: string;         // sticky page-local ref, when interactive
  state?: string;       // filled:… / checked / selected:…
  tag?: string;         // media/iframe marker: img|svg|video|audio|canvas|iframe
  vp?: "in" | "out" | "part"; // only when it differs from the parent
  covered?: boolean;
  clipped?: boolean;    // the PAGE shows an elided snippet (leading ellipsis)
  cut?: boolean;        // WE truncated this run at TEXT_RUN_CAP
  fold?: { items: number; chars: number; id: string };
  kids?: TreeNode[];
}

interface TreeResult {
  error?: string;
  tree?: TreeNode;
  /** Estimated screens of content below what is currently rendered/scrolled in. */
  moreScreens?: number;
  /** Everything in scope that this read does not carry — see unreached.ts. */
  un?: Unreached;
  /** Verbatim value when the subtree root itself is a text field — see EXACT_CAP. */
  exact?: string;
}

/** Verbatim-value cap for a subtree read of a text field (chars). */
const EXACT_CAP = 2000;

/** Strip presentation-only fields so the duplicate-read comparison ignores viewport
 * position and overlay churn — "identical" means identical CONTENT. */
function canonicalize(n: TreeNode): unknown {
  const { vp: _vp, covered: _c, ...rest } = n;
  return { ...rest, kids: n.kids?.map(canonicalize) };
}

interface Rendered { lines: string[]; folds: number; cuts: number; clips: number; chars: number }

function render(n: TreeNode, indent: number, out: Rendered): void {
  const pad = "  ".repeat(indent);
  if (n.fold) {
    out.folds++;
    out.lines.push(`${pad}⋯ folded ~${n.fold.items} items (~${n.fold.chars} chars) (node ${n.fold.id})`);
  }
  const flags: string[] = [];
  if (n.covered) flags.push("(covered)");
  if (n.vp === "out") flags.push("(off-screen)");
  if (n.vp === "part") flags.push("(spans viewport edge)");
  if (n.clipped) { out.clips++; flags.push("(clipped by the page — starts mid-sentence)"); }
  if (n.cut) { out.cuts++; flags.push(`(cut at ${TEXT_RUN_CAP} chars — the page has the full text)`); }
  const parts: string[] = [];
  if (n.ref) parts.push(["button", "link", "menuitem", "tab"].includes(n.role ?? "") ? `[${n.ref}]` : `[${n.ref} ${n.role}]`);
  else if (n.tag) parts.push(n.tag);
  if (n.name) parts.push(n.ref || n.tag ? `"${n.name}"` : `「${n.name}」`);
  if (n.text) parts.push(n.text);
  if (n.state) parts.push(`(${n.state})`);
  parts.push(...flags);
  if (parts.length && !n.fold) {
    const line = pad + parts.join(" ");
    out.lines.push(line);
  }
  out.chars = out.lines.reduce((a, l) => a + l.length + 1, 0);
  for (const k of n.kids ?? []) render(k, indent + (parts.length && !n.fold ? 1 : 0), out);
}

function renderTree(tree: TreeNode): Rendered {
  const out: Rendered = { lines: [], folds: 0, cuts: 0, clips: 0, chars: 0 };
  render(tree, 0, out);
  out.chars = out.lines.reduce((a, l) => a + l.length + 1, 0);
  return out;
}

/** The completeness receipt — first line of every read; negative-proof workflows anchor on it,
 * so "complete" may only appear when NOTHING is folded — by this reader OR by the page itself —
 * cut, unscrolled, drawn into a canvas, or held inside an embedded page. */
function receipt(scope: string, depth: number, r: Rendered, res: TreeResult): string {
  const facts: string[] = [];
  if (r.folds) facts.push(`${r.folds} folded branch${r.folds === 1 ? "" : "es"} — pass node:'nK' or a larger depth to go deeper`);
  if (r.cuts) facts.push(`${r.cuts} text block${r.cuts === 1 ? "" : "s"} cut by the reader (the page has the full text)`);
  if (r.clips) facts.push(`${r.clips} snippet${r.clips === 1 ? "" : "s"} clipped by the page itself — the full text only exists behind the item`);
  facts.push(...missedFacts(res, r.lines.length > 0));
  const completeness = facts.length ? facts.join("; ") : "complete: nothing folded, nothing cut, nothing left below";
  return `page read: ${scope} · depth ${depth > 0 ? depth : "full"} — ${completeness}`;
}

/** Below-the-fold plus the shared unreachable list — the half that stays true when a refusal
 * returns no tree at all. */
function missedFacts(res: TreeResult, rendered: boolean): string[] {
  const facts: string[] = [];
  const screens = res.moreScreens ?? 0;
  // "Not scrolled to", not "not rendered": a static page's text below the fold IS in this read.
  // What holds either way: a lazy page loads on scroll, so absence down there is not proven.
  if (screens > 0.5) {
    facts.push(`~${screens} more screens below have not been scrolled into view`
      + " — content there may not have loaded yet, so do not conclude something is absent");
  }
  return facts.concat(unreachedFacts(res.un ?? { canvases: 0, frames: 0, folded: 0, viewerType: "" }, rendered));
}

/**
 * The `what:'page'` implementation. `markRefs` runs the driver's normal sticky-ref
 * labeling pass first, so the tree can carry act-able refs without minting its own.
 */
export async function readPage(
  page: Page,
  opts: { ref?: string; depth?: number; node?: string },
  state: PageReadState,
  markRefs: () => Promise<void>,
): Promise<ToolResult> {
  await markRefs();
  const scope = opts.node ? `drill ${opts.node}` : opts.ref ? `subtree ${opts.ref}` : "whole page";

  const evalTree = async (depth: number): Promise<TreeResult> =>
    (await page.evaluate(pageFn(TREE_JS) as any, { ref: opts.ref, node: opts.node, depth, cap: TEXT_RUN_CAP })) as TreeResult;

  const explicit = typeof opts.depth === "number" && opts.depth > 0;
  let depth = explicit ? opts.depth! : 0;
  let res = await evalTree(depth);
  if (res.error || !res.tree) return text(`page read failed: ${res.error ?? "empty tree"}${opts.node ? " — drill handles die on re-render; re-read with ref or the whole page" : ""}`);
  let r = renderTree(res.tree);

  if (r.chars > TREE_BUDGET) {
    // Never return half a tree: find a depth that fits and use it (implicit) or name it (explicit).
    let fit = 0;
    let fitRender: Rendered | null = null;
    let fitRes: TreeResult | null = null;
    for (const d of FIT_LADDER.filter((d) => !explicit || d < depth)) {
      const probe = await evalTree(d);
      if (probe.error || !probe.tree) continue;
      const pr = renderTree(probe.tree);
      if (pr.chars <= TREE_BUDGET) { fit = d; fitRender = pr; fitRes = probe; break; }
    }
    // A refusal still carries the unreached facts (a pdf, a canvas, a frame), which do not
    // depend on a tree coming back.
    const missed = missedFacts(res, r.lines.length > 0);
    const tail = missed.length ? `\nand either way: ${missed.join("; ")}` : "";
    if (explicit) {
      return text(`the tree is ~${r.chars} chars at depth ${depth} (limit ${TREE_BUDGET}); `
        + (fit ? `depth ${fit} fits — or pass ref to read one block` : "no depth fits this scope — pass ref to read one section") + tail);
    }
    if (!fit || !fitRender || !fitRes) {
      return text(`the page is too wide to read whole (~${r.chars} chars even shallow) — pass ref to read one section` + tail);
    }
    depth = fit; r = fitRender; res = fitRes;
  }

  // Duplicate whole-page read: answering with the identical tree (by canon) teaches nothing.
  //
  // An EXPLICIT depth is exempt: the caller named a rendering and may no longer hold the last
  // one, and suppressing it can leave a page with NO readable depth (the next one over budget,
  // no ref to drill). The state means "the last whole-page tree you were SHOWN", so an
  // explicit read updates it too.
  if (!opts.ref && !opts.node) {
    const canon = JSON.stringify(canonicalize(res.tree!));
    const same = state.lastFullUrl === page.url() && state.lastFullCanon === canon;
    state.lastFullUrl = page.url();
    state.lastFullCanon = canon;
    // The receipt rides along: a caller that kept only the last value has lost the body.
    if (same && !explicit) {
      return text(`${receipt(scope, depth, r, res)}\nidentical to your previous `
        + "page read — operate the page, read a subtree (ref:), or name a depth to have it rendered again");
    }
  }

  const head = receipt(scope, depth, r, res);
  let body = r.lines.join("\n");
  if (typeof res.exact === "string") {
    const cut = res.exact.length > EXACT_CAP;
    const shown = cut ? res.exact.slice(0, EXACT_CAP) : res.exact;
    const suffix = cut ? ` (first ${EXACT_CAP} of ${res.exact.length} chars)` : "";
    const ws = res.exact !== res.exact.trim() ? " — note the leading/trailing whitespace inside the quotes; it is part of the value" : "";
    body += `\nexact value${suffix} (JSON string — copy the contents verbatim): ${JSON.stringify(shown)}${ws}`;
  }
  return text(`${head}\n${body}`, {
    scope, depth, chars: r.chars, folds: r.folds, moreScreens: res.moreScreens ?? 0,
  });
}
