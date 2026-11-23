/**
 * A click's receipt: what the page itself saw of the press, asked only when nothing else says.
 *
 * A click the driver sent and never heard back about used to be settled by asking the page one
 * trivial question: a page that answers has finished handling the click (actions.ts
 * `afterDispatch`). That holds while the browser delivers what it is sent. Where something in
 * front of the page takes the input (a host that holds a webview's events while its user types),
 * the page answers just the same, and a click that never arrived was reported as "clicked — the
 * page was busy handling it": measured, 16 of 63 clicks in one run, none of them retried.
 *
 * So a listener is put on the target's window before the click, and it records the first TRUSTED
 * press and where it fell. Trusted is what the browser dispatches for real input, and for input
 * sent over the protocol; a page script's own `dispatchEvent` is not. It hears in the capture
 * phase, ahead of every handler of the page's, so a handler that then works for seconds does not
 * delay it.
 *
 * Nothing is left on the page: the record lives in an object only the handle reaches, never on a
 * global, and the listeners take themselves off when the press arrives, when the receipt is
 * dropped, or after {@link HEAR_FOR_MS} if the driver is gone by then.
 */

import type { JSHandle } from "playwright-core";
import { pageFn } from "./collect.ts";

/** Where the press fell: on the target (or inside it), on another element, or nowhere on this page. */
export type Landing = { on: "target" } | { on: "elsewhere"; who: string } | { on: "nothing"; downloadUrl?: string };

export interface ClickReceipt {
  /** What the page has seen so far, or null when it cannot be asked (the frame is gone, the page is busy). */
  read(): Promise<Landing | null>;
  /** Take the listeners off and let go of the handle. Never awaited: it must not hold the click. */
  drop(): void;
}

/** How long arming the receipt may take. A page too busy to answer is clicked without one, as before. */
const ARM_MS = 500;
/** How long reading it may take. */
const READ_MS = 1_000;
/** After this the listeners remove themselves: longer than any click waits (actions.ts `CLICK_BUDGET_MS`). */
const HEAR_FOR_MS = 20_000;

const HEAR_PRESS_JS = String.raw`(el) => {
  const win = el.ownerDocument.defaultView, types = ['pointerdown', 'mousedown'];
  const seen = { on: 'nothing', who: '', downloadUrl: '' };
  const link = el.closest('a[download][href]');
  // A closed shadow root retargets the press to its host and hides the path: the hosts above the
  // target stand in for it.
  const hosts = [];
  for (let r = el.getRootNode(); r && r.host; r = r.host.getRootNode()) hosts.push(r.host);
  const label = (n) => {
    if (!n || n.nodeType !== 1) return 'the page';
    const said = (n.getAttribute('aria-label') || n.innerText || n.value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const tag = n.tagName.toLowerCase() + (n.id ? '#' + n.id : '');
    return said ? tag + ' "' + said + '"' : tag;
  };
  let timer = 0;
  const off = () => { for (const t of types) win.removeEventListener(t, hear, true);
    if (link) win.removeEventListener('click', activation, true);
    win.clearTimeout(timer); };
  // A background webview can activate a download link without a trusted press. Its click
  // alone proves nothing: the driver checks the browser's download on this page as well.
  const activation = (e) => {
    if (e.button === 0 && e.composedPath().includes(el)) seen.downloadUrl = link.href;
  };
  if (link) win.addEventListener('click', activation, true);
  const hear = (e) => {
    if (!e.isTrusted) return;
    const path = e.composedPath ? e.composedPath() : [];
    const at = path[0] || e.target;
    if (at === el || path.includes(el) || (at && at.nodeType === 1 && el.contains(at)) || hosts.includes(e.target)) {
      seen.on = 'target'; seen.who = '';
      off();
    } else if (seen.on === 'nothing') {
      seen.on = 'elsewhere'; seen.who = label(at);
    }
  };
  for (const t of types) win.addEventListener(t, hear, true);
  timer = win.setTimeout(off, ${HEAR_FOR_MS});
  return { seen, off };
}`;

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then((v) => v, () => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Start hearing presses on `target`'s page. Null when the target cannot be asked: a stand-in with
 * no page behind it, or a page that did not answer in {@link ARM_MS}. A click without a receipt is
 * judged as it was before there were any.
 */
export async function hearPress(target: unknown): Promise<ClickReceipt | null> {
  const el = target as { evaluateHandle?: (fn: unknown) => Promise<JSHandle> };
  if (typeof el.evaluateHandle !== "function") return null;
  const release = (h: JSHandle) => { void h.evaluate(pageFn("(r) => r.off()")).catch(() => {}).finally(() => h.dispose().catch(() => {})); };
  let late = false;
  const arming = el.evaluateHandle(pageFn(HEAR_PRESS_JS)).then((h) => { if (late) release(h); return h; });
  const handle = await within(arming, ARM_MS);
  if (!handle) { late = true; return null; }
  return {
    read: async () => {
      const seen = await within(handle.evaluate(pageFn("(r) => ({ ...r.seen })")) as Promise<{ on: string; who: string; downloadUrl: string }>, READ_MS);
      if (!seen) return null;
      return seen.on === "target" ? { on: "target" } : seen.on === "elsewhere" ? { on: "elsewhere", who: seen.who } : { on: "nothing", downloadUrl: seen.downloadUrl };
    },
    drop: () => release(handle),
  };
}
