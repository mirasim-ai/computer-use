/**
 * What a page holds that a READ does not reach — counted once, worded once, for both text
 * channels.
 *
 * Its own module so the two channels cannot disagree about one page. Both declare an embedded
 * page, a canvas, a folded section and a document the browser renders in its own viewer;
 * without this a page of folded sections reads as complete, and an iframe-only page as nothing.
 */

/** Sizeable, both sides. Keeps tracking pixels, icon frames and sparkline canvases out. */
const FLOOR_PX = 100;

/** What the counters answer with. Mirrors the fields the tree read already returned. */
export interface Unreached {
  canvases: number;
  frames: number;
  folded: number;
  viewerType: string;
}

/** JS source for an expression counting the unreachable content inside `rootExpr`. Inlined into
 *  the page-side reads rather than run as a separate evaluate (a round trip per read). */
export function unreachedJs(rootExpr: string): string {
  return String.raw`(() => {
  const __root = ${rootExpr};
  const __floor = ${FLOOR_PX};
  const __big = (el) => { const r = el.getBoundingClientRect(); return r.width >= __floor && r.height >= __floor; };
  const __all = (tag) => __root.tagName === tag.toUpperCase() ? [__root] : Array.from(__root.querySelectorAll(tag));
  let canvases = 0, frames = 0, folded = 0;
  for (const c of __all('canvas')) if (__big(c)) canvases++;
  for (const f of __all('iframe')) if (__big(f)) frames++;
  for (const d of __all('details')) {
    if (d.open) continue;
    const r = d.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) folded++;
  }
  return { canvases, frames, folded, viewerType: String(document.contentType || '') };
})()`;
}

/** Document types whose content, when present, a read gets as markup or text. */
const HTMLISH = /^(text\/|application\/(xhtml\+xml|xml|json)$)/;

/**
 * The facts, in the order they read best. `rendered` says whether the channel came back with
 * anything at all — a non-HTML document whose content the channel DID reach (json, plain text)
 * must not be declared unreachable.
 */
export function unreachedFacts(u: Unreached, rendered: boolean): string[] {
  const facts: string[] = [];
  if (u.canvases) {
    facts.push(`${u.canvases} canvas${u.canvases === 1 ? "" : "es"} draw${u.canvases === 1 ? "s" : ""} content no text read can reach`
      + " — screenshot() is the only way to see it");
  }
  // The page's own fold, kept distinct from the reader's: that one names a depth or a node
  // handle, this one is opened with a click, and the observation already lists the button.
  if (u.folded) {
    const one = u.folded === 1;
    facts.push(`${u.folded} collapsed section${one ? "" : "s"} hold${one ? "s" : ""} text this read does not reach`
      + ` — ${one ? "its summary is" : "their summaries are"} in the element observation marked [collapsed]; click to open`);
  }
  // An embedded page's controls ARE in the observation (the walk crosses frames); only its
  // text is out of reach. Say which, or the model pays a screenshot find() would have saved.
  if (u.frames) {
    const one = u.frames === 1;
    facts.push(`${u.frames} embedded page${one ? "" : "s"} (iframe) hold${one ? "s" : ""} content no page or text read reaches`
      + ` — ${one ? "its" : "their"} controls ARE in the element observation (find/observe); for ${one ? "its" : "their"} text, screenshot()`);
  }
  if (u.viewerType && !HTMLISH.test(u.viewerType) && !rendered) {
    facts.push(`this document is ${u.viewerType}, which the browser renders in a viewer of its own`
      + " — NONE of its content is in this read (any controls listed are the viewer's); screenshot() is the only way to see it");
  }
  return facts;
}
