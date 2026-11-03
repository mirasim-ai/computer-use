/**
 * Page-side JS the BROWSER driver injects in background mode to keep a link click in the SAME
 * tab. Browser-only: an Electron app shell has no tabs and no reason to rewrite `window.open`.
 *
 * Creating a tab makes Chrome the frontmost app even with its window off-screen, stealing the
 * user's keyboard at that instant, so nothing after the fact can undo it: the only fix is not to
 * open one. For an agent a second tab buys nothing anyway.
 *
 * EVERY route is covered, as each steals the keyboard on its own: a named target (`target=_new`),
 * a form's target, an anchor inside a shadow root (`closest` never sees it — the event target is
 * retargeted to the host), a `<base target>`, and `window.open()`. A tab-shaped `window.open()`
 * navigates this tab instead; the stub keeps callers that read `w.location` or close it from
 * throwing. Two opens are NOT redirected:
 *
 * - No DESTINATION (`''`, `'about:blank'`, `'#'`): a blank window the page writes into;
 *   navigating would throw away the page the agent is on.
 * - A POPUP WINDOW (`popup` or geometry in the features): the OAuth / captcha handshake, which
 *   needs a live opener, `window.opener.postMessage` and a self-closing popup — all of which a
 *   redirect breaks, stranding the user on "redirecting…". The focus net (focus-guard.ts, "a
 *   popup with window features that survives") hands the keyboard back for it.
 */
export const KEEP_IN_TAB_JS = `(() => {
  if (window.__computerUseKeepInTab) return;
  window.__computerUseKeepInTab = true;
  // _self/_parent/_top all stay in this window; _blank and any NAME open another one.
  const opensTab = (t) => !!t && !/^_(self|parent|top)$/i.test(t);
  const keep = (e) => {
    // composedPath() pierces shadow roots, where e.target is the host and closest() is blind.
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const n of path) {
      if (!n || (n.tagName !== 'A' && n.tagName !== 'FORM')) continue;
      if (opensTab(n.getAttribute('target'))) n.removeAttribute('target');
      break;
    }
    const base = document.querySelector('base[target]');
    if (base && opensTab(base.getAttribute('target'))) base.removeAttribute('target');
  };
  document.addEventListener('click', keep, true);
  document.addEventListener('submit', keep, true);
  const nativeOpen = window.open.bind(window);
  const blank = (u) => !u || /^(about:blank|#)$/i.test(String(u).trim());
  // A features string asking for a separate WINDOW (the popup token or any geometry) — the
  // OAuth/captcha handshake idiom. A tab-shaped open has no features at all.
  const popup = (f) => !!f && /(^|[\\s,])(popup|width|height|left|top|innerWidth|innerHeight|outerWidth|outerHeight|screenX|screenY)(\\s*=|$|[\\s,])/i.test(String(f));
  window.open = function (url, name, features) {
    if (blank(url)) return nativeOpen(url, name, features); // no destination: a window to write into
    if (popup(features)) return nativeOpen(url, name, features); // a handshake popup needs a real opener

    window.location.href = String(url);
    return {
      closed: false, focus() {}, blur() {}, close() {}, postMessage() {},
      get location() { return window.location; },
      set location(v) { window.location.href = String(v); },
    };
  };
})()`;
