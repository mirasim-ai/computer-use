/**
 * Page-side JS the BROWSER driver injects so that a tab the PAGE asks for is opened by the
 * driver, in the background. Browser-only: an Electron app shell has no tabs.
 *
 * A tab Chrome opens for a page makes Chrome the frontmost app even with its window off-screen,
 * stealing the user's keyboard at that instant, and nothing after the fact can undo it. So the
 * page's request is caught here and handed to the driver ({@link PAGE_TABS_BINDING}), which
 * opens the tab with `Target.createTarget{background}` (tabs.ts) — the one way that does not
 * raise the browser — and makes it the session's active tab.
 *
 * The page keeps what it asked for: a second tab at the destination, and the clicking document
 * left as it was. (Until 0.1.0-rc.11 the request was rewritten into a navigation of the
 * clicking frame. That hid whether a link opens a new tab at all, and inside an iframe it
 * loaded the destination in the frame — exactly what a missing `target=_blank` does.)
 *
 * WHAT IS CAUGHT, each a route to a new tab of its own: an anchor's or area's target, a
 * `<base target>`, a GET form's target (or its submitter's `formtarget`), an anchor inside a
 * shadow root (`composedPath`, because the event target is retargeted to the host), and
 * `window.open(url)`.
 *
 * HOW A LINK IS CAUGHT: its target is lifted (set to `_self`) for the length of the click, so
 * the navigation starts in this frame, where the Navigation API's `navigate` event can cancel
 * it and report its destination. The target is put back as soon as that event has fired, or
 * after the click when the page cancelled it — a click the page prevents opens nothing, as in
 * any browser, and the DOM a later read sees is the page's own. A document with no navigate
 * event (an opaque origin, a frame on its initial about:blank) has its click cancelled instead,
 * after the page's own handlers have run and left it alone.
 *
 * HOW A FORM IS CAUGHT: after the page's own submit handlers have run and left it alone, a GET
 * form's submit is cancelled and its destination (action plus the form data) handed over.
 *
 * WHAT IS LEFT TO CHROME:
 *
 * - No user activation behind it (a timer, a script at load): Chrome's popup blocker decides,
 *   as it would without us.
 * - `_self` / `_parent` / `_top`, and a target naming a frame of this page: no new tab.
 * - No DESTINATION (`''`, `'about:blank'`, `'#'`): a blank window the page writes into.
 * - A POPUP WINDOW (`popup` or geometry in the features): the OAuth / captcha handshake, which
 *   needs a live opener, `window.opener.postMessage` and a self-closing popup. The focus net
 *   (focus-guard.ts) hands the keyboard back for these.
 * - A POST form: its body cannot be carried into a tab opened from outside the page, so it is
 *   submitted in its own frame and the driver is told (`kept`), so the run says so. The same
 *   for a link whose navigation the page is not allowed to cancel.
 * - `form.submit()` called by a script: it fires no submit event, so Chrome opens that tab.
 * - A frame sandboxed without `allow-popups`: the driver hands the request back and Chrome
 *   blocks it, as it would have (the driver reads the iframe's attribute; a page cannot).
 * - No driver answering (it exited, or the page is not one of its own): after
 *   {@link PAGE_TAB_ANSWER_MS} the page opens the tab itself.
 *
 * WHAT DIFFERS from a tab Chrome opened: no `window.opener` and no copied `sessionStorage` in
 * the new tab, no Referer on its first request, a NAMED target gets a new tab every time
 * instead of reusing the one of that name, and `window.open` returns a stand-in that answers
 * `closed`, `close()`, `focus()` and a settable `location`, not a real `WindowProxy` — also
 * where Chrome would have answered null (a sandboxed frame), since the answer comes later.
 *
 * Not installed in attached mode, where the session's boundary is a window of the user's own
 * Chrome (driver-connect.ts `installPageTabs`).
 */

/** The binding a page calls with one JSON message: `{op: "open"|"go"|"close"|"kept", id, url}`
 *  (`kept` carries `what: "link"|"form"` in place of an id). */
export const PAGE_TABS_BINDING = "__computerUseTab";
/** The page function the driver answers an `open` through: `(id, taken) => stillWaiting`. */
export const PAGE_TAB_ANSWER = "__computerUseTabAnswer";
/** How long a page waits for the driver's answer before it opens the tab itself. An owner
 *  answers in milliseconds; a late one is told the page stopped waiting and opens nothing. Well
 *  inside Chrome's 5s of transient activation, so the page's own open is still allowed. */
export const PAGE_TAB_ANSWER_MS = 1000;

// As quoted property names: the build minifies this script on its own and takes a hole only
// where a value goes (scripts/build.mjs).
const BINDING = JSON.stringify(PAGE_TABS_BINDING);
const ANSWER = JSON.stringify(PAGE_TAB_ANSWER);

export const PAGE_TABS_JS = `(() => {
  if (window.__computerUsePageTabs) return;
  window.__computerUsePageTabs = true;
  const nativeOpen = window.open.bind(window);
  const nav = window.navigation;
  const activated = () => !navigator.userActivation || navigator.userActivation.isActive;
  const absolute = (u) => { try { return new URL(String(u), document.baseURI).href; } catch { return null; } };

  // ── Asking the driver ────────────────────────────────────────────────────────────────────
  const tell = (msg) => {
    try { Promise.resolve(window[${BINDING}](JSON.stringify(msg))).catch(() => {}); return true; }
    catch { return false; }
  };
  const waiting = new Map();
  let seq = 0;
  const settle = (id, taken) => {
    const w = waiting.get(id);
    if (!w) return false;
    waiting.delete(id);
    clearTimeout(w.timer);
    if (!taken) w.natively();
    return true;
  };
  // true: the driver opens it. false: it will not (hand it back at once). Unanswered: nobody
  // is driving this page, so it opens the tab itself. The return value tells the driver
  // whether the page was still waiting, so one request never becomes two tabs.
  window[${ANSWER}] = (id, taken) => settle(id, taken);
  const ask = (url, natively) => {
    const id = Math.random().toString(36).slice(2) + '.' + (++seq);
    waiting.set(id, { natively, timer: setTimeout(() => settle(id, false), ${PAGE_TAB_ANSWER_MS}) });
    if (!tell({ op: 'open', id, url })) settle(id, false);
    return id;
  };

  // ── Which targets mean "another tab" ─────────────────────────────────────────────────────
  // A name can be a frame of this page, where the navigation belongs: this window's own
  // frames, its siblings, the top document's.
  const frameNamed = (name) => [window, window.parent, window.top].some((w) => {
    try { const f = w[name]; return !!f && f !== w && f.window === f && f.parent === w; } catch { return false; }
  });
  const opensTab = (t) => !!t && !/^_(self|parent|top)$/i.test(t) && !frameNamed(t);
  const baseTarget = () => { const b = document.querySelector('base[target]'); return b ? b.getAttribute('target') : null; };

  // ── Links ────────────────────────────────────────────────────────────────────────────────
  let held = null;
  const release = () => {
    if (!held) return;
    clearTimeout(held.timer);
    for (const [el, attr, was] of held.lifted) was === null ? el.removeAttribute(attr) : el.setAttribute(attr, was);
    held = null;
  };
  const hold = (el, attrs, ms, link) => {
    const lifted = attrs.map(([n, attr]) => [n, attr, n.getAttribute(attr)]);
    for (const [n, attr] of lifted) n.setAttribute(attr, '_self');
    held = { el, lifted, link, timer: setTimeout(release, ms) };
  };
  // After every handler the page has for this event, if none of them cancelled it. Registered
  // while the event is on its way down, so it is the last listener it meets.
  const afterPage = (type, e, fn) => window.addEventListener(type, (late) => {
    if (late === e && !late.defaultPrevented) fn(late);
  }, { once: true });
  window.addEventListener('click', (e) => {
    release();
    if (!activated()) return;
    // composedPath() pierces shadow roots, where e.target is the host and closest() is blind.
    const path = e.composedPath ? e.composedPath() : [e.target];
    const a = path.find((n) => n && n.nodeType === 1 && /^(a|area)$/i.test(n.localName));
    if (!a || !a.hasAttribute('href') || a.hasAttribute('download')) return;
    if (!opensTab(a.hasAttribute('target') ? a.getAttribute('target') : baseTarget())) return;
    const opener = /(^|\\s)opener(\\s|$)/i.test(a.getAttribute('rel') || '');
    if (nav && nav.currentEntry) {
      // The navigation starts inside this click's own default action, so the target is back
      // before any other task runs.
      hold(a, [[a, 'target']], 0, { opener });
      return;
    }
    // No navigate event in this document (an opaque origin: a data: URL, a sandboxed frame; or
    // a frame still on its initial about:blank). Cancel the click itself instead, once the
    // page's handlers have let it through. A modified click is Chrome's own to place.
    if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    afterPage('click', e, (late) => {
      const url = absolute(a.getAttribute('href'));
      if (!url || !/^(https?|file):/i.test(url)) return;
      late.preventDefault();
      ask(url, () => nativeOpen(url, '_blank', opener ? undefined : 'noopener'));
    });
  }, true);
  if (nav) {
    nav.addEventListener('navigate', (e) => {
      // A held POST form (below) is not a link: its navigation goes ahead in this frame.
      if (!held || !held.link) return;
      // Only the navigation the held link started: a handler's own location.assign() during
      // the same click has no source element.
      const src = 'sourceElement' in e ? e.sourceElement : held.el;
      if (!src || !(src === held.el || held.el.contains(src))) return;
      const opener = held.link.opener;
      release();
      if (e.downloadRequest != null) return;
      const url = e.destination.url;
      if (!e.cancelable) { tell({ op: 'kept', what: 'link', url }); return; }
      e.preventDefault();
      ask(url, () => nativeOpen(url, '_blank', opener ? undefined : 'noopener'));
    });
  }

  // ── Forms ────────────────────────────────────────────────────────────────────────────────
  // Not through the navigate event: a form's navigation is SCHEDULED, CDP announces it when it
  // is scheduled (Page.frameRequestedNavigation), and nothing takes that back when the
  // navigate event cancels it — the driver's own client would wait on a navigation that never
  // comes. So a GET form's destination is worked out here and its submit is cancelled instead.
  const attrOf = (form, by, formAttr, attr) => by && by.hasAttribute(formAttr) ? by.getAttribute(formAttr) : form.getAttribute(attr);
  window.addEventListener('submit', (e) => {
    const form = e.target;
    if (!activated() || !form || form.localName !== 'form') return;
    const by = e.submitter || null;
    const target = attrOf(form, by, 'formtarget', 'target');
    if (!opensTab(target === null ? baseTarget() : target)) return;
    // A submit the page cancels (validation, a fetch in its place) opens nothing.
    afterPage('submit', e, (late) => {
      const method = (attrOf(form, by, 'formmethod', 'method') || 'get').toLowerCase();
      if (method === 'dialog') return;
      const action = attrOf(form, by, 'formaction', 'action');
      let to;
      try { to = action ? new URL(action, document.baseURI) : new URL(document.URL); } catch { return; }
      if (!/^(https?|file):$/.test(to.protocol)) return;
      if (method === 'post') {
        hold(form, by && by.hasAttribute('formtarget') ? [[by, 'formtarget'], [form, 'target']] : [[form, 'target']], 1000, null);
        tell({ op: 'kept', what: 'form', url: to.href });
        return;
      }
      const query = new URLSearchParams();
      try {
        for (const [k, v] of new FormData(form, by || undefined)) query.append(k, typeof v === 'string' ? v : v.name);
      } catch { return; }
      const hash = to.hash;
      to.hash = '';
      to.search = '';
      const url = to.href + '?' + query.toString() + hash;
      late.preventDefault();
      ask(url, () => nativeOpen(url, '_blank'));
    });
  }, true);

  // ── window.open ──────────────────────────────────────────────────────────────────────────
  const blank = (u) => !u || /^(about:blank|#)$/i.test(String(u).trim());
  // A features string asking for a separate WINDOW (the popup token or any geometry) — the
  // OAuth/captcha handshake idiom. A tab-shaped open has no such features.
  const popup = (f) => !!f && /(^|[\\s,])(popup|width|height|left|top|innerWidth|innerHeight|outerWidth|outerHeight|screenX|screenY)(\\s*=|$|[\\s,])/i.test(String(f));
  window.open = function (url, name, features) {
    const href = blank(url) ? null : absolute(url);
    const target = name === undefined || name === null || name === '' ? '_blank' : String(name);
    if (!href || /^javascript:/i.test(href) || popup(features) || !opensTab(target) || !activated()) {
      return nativeOpen.apply(null, arguments);
    }
    const id = ask(href, () => { nativeOpen(url, name, features); });
    // noopener / noreferrer: the caller gets no window, as from Chrome.
    if (features && /(^|[\\s,])(noopener|noreferrer)(\\s*=|$|[\\s,])/i.test(String(features))) return null;
    let at = href;
    const go = (v) => { const to = absolute(v); if (to) { at = to; tell({ op: 'go', id, url: to }); } };
    const location = { get href() { return at; }, set href(v) { go(v); }, assign: go, replace: go, toString: () => at };
    const win = {
      closed: false, focus() {}, blur() {}, postMessage() {},
      close() { if (!win.closed) { win.closed = true; tell({ op: 'close', id }); } },
      get location() { return location; },
      set location(v) { go(v); },
    };
    return win;
  };
})()`;
