---
name: mirasim-computer-use
description: Read before operating a browser tab, macOS app or Electron app with Mirasim Computer Use (the `computer_repl` / `computer_repl_reset` tools). Covers the mistakes agents make most with it — picking the user's browser (extension) or the managed one, a tab the agent cannot see, a macOS permission that is missing, asking before an app is brought to the front, an Electron app with no debugging port, a new tab that never appeared or that a link opened, asserting in code what should be returned, pre-accepting a confirm, signing in from code, what to do with tabs afterwards, and recovering a stuck runtime with computer_repl_reset.
---

# Mirasim Computer Use

`computer_repl` runs your JavaScript against the GUI; its first result carries the full API
reference, and that reference is the authority on every verb. This skill covers only what agents
get wrong in practice.

## Which browser

There are up to three browser connections. A host that offers a choice (Mirasim's
`computer_repl` takes a `browser` argument) lets you pick per call. Standalone only (the
open-source MCP server, not Mirasim): the connection is fixed when the server is configured
(`COMPUTER_USE_BROWSER=extension`, else the managed browser), and you cannot switch from inside
a session.

| Connection | What it is | Use it when |
|---|---|---|
| `extension` | the user's own Chrome, through the Mirasim extension | the task needs the user's logins, a page they already have open, or they want to watch in their browser |
| `managed` | a separate Chrome with its own profile ("independent browser" in Mirasim); its logins persist between sessions | the task needs no account of the user's, or should stay out of their tabs (testing a page you built, scraping public pages); parallel work (`profile` slots in Mirasim) |
| `embedded` | browser pages inside the Mirasim workbench (Mirasim desktop only) | the user wants to see the page next to the conversation |

- An explicit choice never falls back. If `extension` says the extension is not connected, tell the
  user (install or enable it, or turn browser control on in Mirasim) instead of silently
  redoing the task in the managed browser — that one has none of their logins.
- In Mirasim, a call that names no `browser` takes the extension when it is on and connected, then
  the managed browser, then the embedded one (a browser the user lent from a Mirasim window on
  another computer comes before the managed one). When the result notes that the extension is on
  but not connected, the call ran elsewhere: if the task needed the user's logins, say so.
- Do not ask the user to sign in to a site in the managed browser when they are already signed in
  to it in their own Chrome and the extension is connected; use the extension.
- The extension serves one bridge at a time and the Mirasim desktop app's comes first: while
  browser control is on in Mirasim, the open-source server's extension mode refuses at once.

## A tab you cannot see

In extension mode the user decides what you may reach (the extension's panel). The default is
"only the Mirasim group": you see the tabs you opened and the tabs they handed over, nothing else.

- When the page the user means is not in `computer.surfaces()`, do not hunt for it, guess an id,
  or reopen its URL in a new tab (that loses its state and its place). Ask the user to click the
  Mirasim toolbar icon on that tab — it joins the `mirasim` tab group — then list surfaces again.
  The icon is in colour on tabs you may use and grey on the rest, which helps them check.
- A refusal that says the user **paused** the agent: stop, tell them, and wait for them to resume.
  Do not retry in a loop.
- A site the user **blocked** is not listed, opened or navigated to. Say so; do not route around
  it (another URL of the same site, a search result link, the managed browser).
- With "Ask me" the user gets a small prompt before you use a tab outside the group. "Waiting for
  the user to allow tab …" means they have not answered yet: say which tab you need and why, and
  try again once they have. "The user declined" is an answer — do not ask the browser again.

## macOS apps

Reads and most actions run in the background: the app stays where it is, and the user keeps
their pointer, keyboard and clipboard.

- **A missing permission is not an empty app.** When a result says Accessibility is not granted,
  no app will read or act until the user grants it. Stop and tell them which permission is
  missing and where to grant it: in Mirasim, Settings › Plugins › Computer Use › macOS apps ›
  Manage; standalone, System Settings › Privacy & Security, for the app that launched the server.
  Do not try another app or retry in a loop. Screen Recording missing stops only screenshots;
  reading and acting still work.
- **Ask before anything comes to the front.** "requires desktop interaction" means the step
  needs the real pointer, the app in front or the clipboard, and it was not done. Tell the user
  which app will come forward and what of theirs it uses, wait for a yes, then repeat that step
  with `interaction: "desktop"`. Never start in desktop mode or call `activate()` just to make a
  step go through: whatever the user types next lands in that app.
- **Menu commands (⌘-chords) go to the app's key window**, which need not be the window you
  bound, and so do plain keys while the app is in front (in the background they go to the bound
  window). With several documents open in one app, a Paste or Save can land in the user's other
  document: act through refs (`click`, `setText`), or work in a document you opened yourself.
- **Every window unreadable at once** (no window listed, none on screen) usually means the
  screen is locked, or the window is minimised or on another Space. Say what the note says and
  ask the user; launching the app again or observing in a loop changes nothing.

## Electron apps

- The driver attaches to an app that is **already running** with its renderer debugging port
  open, and never starts one. "no Electron app is listening on …" means that port is not there:
  ask the user to start their dev build with `--remote-debugging-port=<port>` and to tell you the
  port (Mirasim: pass it per call as `cdp`; standalone: `COMPUTER_USE_ELECTRON_CDP_URL`). Do not
  relaunch their app yourself or probe for ports.
- **An installed app opens no such port**, the installed Mirasim desktop app included, and no
  retry changes that. Use the route the app ships (Mirasim's is `mirasim ui-cli`); on macOS an
  installed app other than Mirasim can be operated as a macOS app instead.

## New tabs

The reference's first lines show the calls agents most often get wrong (an object for
`openUrl`, no URL in `computer.surface()`, binding the id `newTab` names). Two cases it does
not cover:

- If `newTab` fails saying the tab never appeared, nothing else was taken in its place: try once
  more, then list surfaces. Do not act on whichever tab happens to be active instead.
- A link or `window.open` that asks for a new tab gets a real one (`target="_blank"`, also
  inside an iframe). The click's own line names the new tab's id and where it landed, and `w`
  stays on the tab it clicked: bind the new one with `computer.surface("<id from the line>")`.
  To check "does this open in a new tab?", read that line or `computer.surfaces()` in the same
  call — no second tab and the page (or frame) itself navigated means it did not.

## Writing the code

The reference's "Writing the code" part is the authority on going on in one call, verifying by
returning, branching only for known detours, and what code must never decide. The three that
cost the most in practice:

- Asserting in code (`if (total !== "$30.00") throw …`) what you should `return` and judge:
  the failed check ends the call before `return`, and the values are lost.
- Arming `dialog({answer: "accept"})` before the click: it accepts a confirm you never read.
- Signing in from code when a sign-in page appears unexpectedly: the lost session may be the
  bug you are looking for. Stop and look.

## Tabs afterwards

- Leave the tabs you opened **open** unless the host states a tab policy that asks you to close
  them (Mirasim says so in call results) or the user asks. A later turn of the same task often
  needs the page again, and the user may want to see it.
- Never close a page that is waiting for the person: a sign-in, a security-key or 2FA prompt, a
  form for them to confirm. Open such a page once and leave it be.
- A tab marked `(user's)` is theirs. Reading and acting in it needs no permission; closing it
  does — ask in the conversation, then `closeTab({id, confirmed: true})`. `closeTab({all: true})`
  never closes theirs.
- `await w.release()` when you are done with a target, so another session can take it.
  "In use by another runtime" means another session holds it: use another target or wait (an
  idle owner lets go within two minutes). Never reset to get around it.

## When it is stuck

`computer_repl_reset` discards this runtime's JavaScript bindings and releases its claims. It
changes nothing on screen: no tab, window or app is closed.

Reset when the **runtime** is wrong, then rebind (`computer.surfaces()`) and re-observe:

- calls keep failing the same way before any verb runs (the journal shows nothing dispatched);
- you overwrote something the runtime needs (assigned to `computer`, redefined a helper badly)
  and can no longer trust its top-level state;
- the browser or the extension reconnected and rebinding alone did not bring the handles back.

Do not reset to "start over" on the page (navigate or reload instead), to retry a failed click,
or to take a target another session holds. After closing the session's last tab no reset is
needed either: `openUrl({url})` or `newTab({url})` on the old handle opens a fresh one.

Standalone only (the open-source MCP server registered in Codex, not Mirasim):
`computer_repl_reset` must be approved like `computer_repl` (`approval_mode = "approve"`), or
the call is refused exactly when you need it.
