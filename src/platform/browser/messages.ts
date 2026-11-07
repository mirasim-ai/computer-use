/**
 * User-facing browser dead-end messages.
 *
 * The few computer-use-AUTHORED strings that reach a caller VERBATIM, as the tool result / run
 * failure when the browser cannot be acquired or driven.
 *
 * Model-facing observation wording (FROZEN_NOTE, navigation verdicts, element listings) is model
 * CONTEXT tuned in English, not output, and stays out of this table; so do stderr diagnostics and
 * machine tokens.
 */

export function msgChromeMissing(installHint: string): string {
  return (
    "mirasim-cu: Google Chrome was not found, so no browser could be started.\n"
    + "Fix one of:\n"
    + `  - install Google Chrome (${installHint})\n`
    + "  - point COMPUTER_USE_CHROME at a Chrome/Chromium binary\n"
    + "  - point COMPUTER_USE_CDP_URL at an already-running browser's CDP endpoint"
  );
}

export function msgAttachedDeadEnd(profileDir: string, why: string): string {
  return (
    `mirasim-cu: cannot take over this Chrome — ${why}.\n`
    + `This profile belongs to the user (${profileDir}), so it will not be force-closed.\n`
    + `Quit Chrome (⌘Q) and retry.`
  );
}

export const msgAttachedWhyNoPage = (): string => "its debugging port answers, but no usable page can be opened";

export const msgAttachedWhyHandshake = (): string => "its debugging port answers, but the handshake timed out (the browser may be frozen)";

export const msgAttachedWhyNoPort = (): string => "it is already running, but without a debugging port";

export const msgOwnWindowFailed = (): string => "mirasim-cu: could not open the agent's own window in the user's Chrome.";

export function msgChromeBinaryUnrunnable(exe: string, code: string): string {
  return `mirasim-cu: cannot run the Chrome binary at ${exe} (${code}). Point COMPUTER_USE_CHROME at a working Chrome/Chromium.`;
}

export function msgChromeStartFailed(detail: string): string {
  return `mirasim-cu: Chrome could not be started (${detail}).`;
}

export const msgChromeExitedImmediately = (): string => "mirasim-cu: Chrome exited immediately instead of publishing a debugging port — another browser may already own this profile directory.";

export const msgChromeNoPort = (): string => "mirasim-cu: Chrome never published a debugging port within 15s.";

export const msgChromeRefusedAttach = (): string => "mirasim-cu: Chrome started but its debugger refused to attach.";

/** The only install the bridge admits (bridge/extension-id.ts). A literal, not imported: that
 *  module reads the extension's manifest from disk at load, and this one is loaded by every task. */
const EXTENSION_STORE_URL = "https://chromewebstore.google.com/detail/mirasim/khflooofmndpmafhofjdcpjfgnlpikhg";

/**
 * The bridge is up but the EXTENSION is not attached to it, so the browser is out of reach until
 * a person reconnects it.
 *
 * Its own message and error CLASS because retrying cannot help: the extension's service worker
 * owns the relay WebSocket (`extension/background.js`), MV3 evicts an idle worker, and only the
 * connect page, which the HOST opens, rebuilds the connection. The raw CDP protocol error reads
 * as "try again" and the model loops.
 */
export function msgBridgeExtensionGone(): string {
  return (
    "The mirasim bridge extension is not connected, so this browser cannot be reached. Nothing you can do from here"
    + ` fixes it and retrying will not help: ask the user to install or enable the Mirasim extension from the Chrome Web Store (${EXTENSION_STORE_URL})`
    + " and remove any older copy loaded unpacked at chrome://extensions, which no longer connects; then continue."
  );
}

/**
 * The same failure for a session that found or started the bridge itself
 * (`COMPUTER_USE_BROWSER=extension`), where two causes are common and neither is "not installed":
 * another program's bridge holds the extension (it serves one bridge at a time), or this bridge
 * started moments ago and the extension has not dialled in yet.
 */
export function msgBridgeExtensionElsewhere(owner: string): string {
  return (
    `The Mirasim extension is connected to another program's browser bridge (${owner}), not to this one — it serves one`
    + " bridge at a time and that one comes first. Retrying will not help: ask the user to turn browser control off"
    + ` in that program (${owner}), then continue.`
  );
}

export function msgBridgeJustStarted(): string {
  return (
    "The browser bridge started moments ago and the Mirasim extension has not connected yet. An installed extension"
    + " checks again within a minute; wait about a minute and retry once. If it still does not connect, ask the user"
    + ` to install or enable the Mirasim extension from the Chrome Web Store (${EXTENSION_STORE_URL}).`
  );
}

/** Whether a failure is that one — matched on the bridge's own refusal text, which reaches us
 *  wrapped in whatever CDP client raised it (`bridge/server.ts`). */
export function isBridgeExtensionGone(e: unknown): boolean {
  // Two wordings, one state: a command sent while the extension is away, and a handshake that
  // waited for it in vain (`bridge/server-core.ts` `ensureExtension`).
  return /Bridge extension not connected|bridge extension did not connect/i.test(e instanceof Error ? e.message : String(e));
}

export function msgEndpointUnavailable(cdpUrl: string, detail: string): string {
  return `mirasim-cu: explicit CDP endpoint ${cdpUrl} is unavailable.\n(${detail})`;
}

/**
 * What the model is told after we reopened a browser the user had closed.
 *
 * Not a hard stop: the browser lives off-screen and never takes focus, so reopening disturbs
 * nobody — the task continues and the model is simply told, which is strictly more useful than
 * making the user ask again.
 */
export const REOPENED_NOTE =
  "the browser had been closed (most likely by the user), so a fresh one was opened in the "
  + "background and the page is blank — re-observe, and navigate again before acting on refs";

/** The named-tab twin of {@link REOPENED_NOTE}: on a shared browser only THIS surface's tab
 * died, and saying "the browser was closed" would be false and alarming. */
export const TAB_REOPENED_NOTE =
  "this surface's tab had been closed (most likely by the user), so a fresh blank tab was "
  + "claimed — re-observe, and navigate again before acting on refs";

/** The explicit-endpoint twin of {@link TAB_REOPENED_NOTE} — the extension bridge above all.
 *
 * There the driver reaches a tab only while the browser keeps a debugger attached, and the browser
 * can take that away from a tab that stays open: the iCloud Passwords extension puts a
 * `chrome-extension://…/completion_list.html` autofill frame into every page with a password field,
 * and Chrome keeps every OTHER extension's debugger out of such a page — it detaches
 * (`target_closed`) within ~1 s and each re-attach is refused ("Cannot access a chrome-extension://
 * URL of different extension"). The managed browser (own profile, no extensions) drives the same
 * pages. Reopening detaches again and leaves one more orphan tab each time, so the note names the
 * cause class and the route that works, not which extension it was (nothing here can see that). */
export const TAB_DETACHED_NOTE =
  "this surface's tab stopped answering — it was closed, or the browser took its debugger away, in "
  + "which case it is still open in the user's window but out of reach from here. A fresh blank tab "
  + "was claimed — re-observe, and navigate again before acting on refs. If the same page drops again "
  + "right after it loads, it cannot be driven through this browser: a password manager's autofill "
  + "(measured: iCloud Passwords, on any page with a password field) puts its own extension frame into "
  + "the page, and Chrome then refuses this extension's debugger there. Do not reopen it; tell the user "
  + "— turning that extension off for the site, or the managed browser (its own profile), drives it";

/** The CONFIRMED twin of {@link TAB_DETACHED_NOTE}: the bridge recorded why its debugger could not
 * get back into the tab, so the cause is Chrome's own word rather than an inference. The one refusal
 * with a known meaning is another extension's frame in the page (see TAB_DETACHED_NOTE for the
 * measurement); any other is quoted as it came. */
export function tabRefusedNote(reason: string): string {
  const head = "this surface's tab is out of reach: it is still open in the user's window, but Chrome refused "
    + `this extension's debugger on it ("${reason}"). A fresh blank tab was claimed. `;
  return /chrome-extension:\/\/ URL of different extension/.test(reason)
    ? head + "Another extension has put its own frame into that page — a password manager's autofill does this "
      + "on any page with a password field (measured: iCloud Passwords) — and while it is there no retry from here "
      + "gets in. Do not reopen the page; tell the user that turning that extension off for this site, or the "
      + "managed browser (its own profile), lets it be driven"
    : head + "Reopening it will most likely be refused the same way — tell the user rather than retrying";
}

/** The session closed its own last tab and is left with none, ON PURPOSE: `close_tab({all})`
 * leaves a borrowed browser as it was found, and reclaiming a blank tab would leave an
 * `about:blank` in the user's window. The driver goes DORMANT until `open_url` / `new_tab`. */
export const TAB_REOPENED_AFTER_SELF_CLOSE_NOTE =
  "this session had closed its last tab, so opening one started a fresh blank tab — nothing went "
  + "wrong and nobody took the browser back; navigate before acting on refs";

export const NO_TAB_OPEN_NOTE =
  "this session has no tab open — it closed its last one and nothing was reopened, so the browser is "
  + "left as the user had it. open_url or new_tab starts a fresh tab when you need one";

/** The session has not opened or bound a tab yet: on the extension bridge it opens none up front
 *  (tabs.ts `claimSessionTab`), and a host's embedded browser is the same before its first tab —
 *  so the wording names neither browser. */
export const NO_TAB_YET_NOTE =
  "this session holds no tab yet — none is opened until asked. Bind one of the listed tabs to act "
  + "in it, or new_tab opens one of the session's own";

/**
 * The extension bridge serves one extension at a time: when the active browser goes, another
 * browser's waiting extension takes over, and a restarted browser comes back as a new session —
 * either can happen under a live session. Nothing was opened there:
 * the task may not be about that browser at all, and only the model can tell.
 */
export const BROWSER_SWITCHED_NOTE =
  "the browser behind the extension changed — a different browser, or this one after a restart, is "
  + "connected now, and the tabs listed are ITS tabs. Nothing was done in it and this session holds no "
  + "tab there; handles and refs from before belonged to the previous browser and are gone. If this is "
  + "not the browser the task is about, stop and tell the user; otherwise bind one of the listed tabs, "
  + "or new_tab opens one of the session's own";

/**
 * The third case — NOT {@link TAB_REOPENED_NOTE}, which would lie twice here.
 *
 * On a bridged browser every CDP target id is re-minted when the extension reconnects (worker
 * eviction, the Connect button, a Chrome restart), so the driver's target vanishes while the TAB
 * (same chrome tab id) is untouched: nothing was closed or claimed, only refs are dead.
 */
export const SURFACE_REIDENTIFIED_NOTE =
  "the connection to this browser dropped and came back, so this surface was re-identified — the "
  + "page below is the one it is on now, and refs from before are dead; re-observe before acting";

/** close_tab on the user's own tab without their say: the refusal names the ONE way through, asking
 *  them. Nothing enforces `confirmed`; it makes the honest path obvious at the moment it is needed. */
export function userTabCloseRefusal(id: string): string {
  return `${id} is the user's own tab, not this session's. Ask them in the conversation `
    + "whether to close it — say which page — and call close_tab again with confirmed: true if they agree. "
    + "Reading it and acting in it needs no permission; only closing does";
}
