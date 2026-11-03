/** Page-local identities without DOM attributes: observation must not change SSR markup. */
import { selectors, type Browser, type Page } from "playwright-core";

/** Shared by the observation, tree reader and selector engine, in each frame's main world.
 * Weak references do not keep removed subtrees alive. A new document gets a new registry. */
export const PAGE_REFS_JS = String.raw`() => {
  const key = Symbol.for('mirasim-computer-use.page-refs');
  if (!globalThis[key] || globalThis[key].document !== document) {
    globalThis[key] = { document, byElement: new WeakMap(), elements: new Map(), nodes: new Map() };
  }
  return globalThis[key];
}`;

const SELECTOR_JS = String.raw`(() => {
  const query = (root, ref) => {
    const state = (__PAGE_REFS__)();
    const el = state.elements.get(ref)?.deref();
    if (!el?.isConnected) return null;
    if (root.nodeType === 9) return el.ownerDocument === root ? el : null;
    for (let n = el; n; n = n.parentNode || n.host) if (n === root) return el;
    return null;
  };
  return { query, queryAll: (root, ref) => { const el = query(root, ref); return el ? [el] : []; } };
})()`.replace("__PAGE_REFS__", PAGE_REFS_JS);

const registered = new WeakMap<Browser, Promise<string>>();
let nextEngine = 0;

/** Locator auto-waiting and normal input delivery stay in Playwright. Only identity lookup
 * changes; the engine must share the main world where observation keeps the registry. */
export function ensureRefSelector(browser: Browser): Promise<string> {
  let pending = registered.get(browser);
  if (!pending) {
    // CDP attaches an existing default context: it does not inherit engines registered before
    // the connection. Register after attach, before any locator/frame inspection, once per browser.
    const name = `mirasim_ref_${++nextEngine}`;
    pending = selectors.register(name, { content: SELECTOR_JS }, { contentScript: false }).then(() => name);
    registered.set(browser, pending);
  }
  return pending;
}

export async function refSelector(page: Page, ref: string): Promise<string> {
  const browser = page.context().browser();
  if (!browser) throw new Error("The page has no connected browser for ref lookup");
  return `${await ensureRefSelector(browser)}=${ref.replace(/[^\w-]/g, "")}`;
}
