---
name: mirasim-computer-use
description: Read before operating a browser tab, macOS app or Electron app with Mirasim Computer Use (the `computer_repl` / `computer_repl_reset` tools). Covers the mistakes agents make most with it — picking the user's browser (extension) or the managed one, a tab the agent cannot see, the object arguments of openUrl / newTab / closeTab, going on in one call instead of stopping to look, never pre-accepting a confirm, what to do with tabs afterwards, and recovering a stuck runtime with computer_repl_reset.
---

# Mirasim Computer Use

`computer_repl` runs your JavaScript against the GUI; its first result carries the full API
reference, and that reference is the authority on every verb. This skill covers only what agents
get wrong in practice.

## Which browser

There are up to three browser connections. A host that offers a choice (Mirasim's
`computer_repl` takes a `browser` argument) lets you pick per call; with the open-source MCP
server it is fixed when the server is configured (`COMPUTER_USE_BROWSER=extension`, else the
managed browser), and you cannot switch from inside a session.

| Connection | What it is | Use it when |
|---|---|---|
| `extension` | the user's own Chrome, through the Mirasim extension | the task needs the user's logins, a page they already have open, or they want to watch in their browser |
| `managed` | a separate Chrome with its own profile ("independent browser" in Mirasim); its logins persist between sessions | the task needs no account of the user's, or should stay out of their tabs (testing a page you built, scraping public pages); parallel work (`profile` slots in Mirasim) |
| `embedded` | browser pages inside the Mirasim workbench (Mirasim desktop only) | the user wants to see the page next to the conversation |

- An explicit choice never falls back. If `extension` says the extension is not connected, tell the
  user (install or enable it, or turn browser control on in Mirasim) instead of silently
  redoing the task in the managed browser — that one has none of their logins.
- In Mirasim, a call that names no `browser` takes the extension when it is on and connected, then
  the embedded browser, then the managed one. When the result notes that the extension is on but
  not connected, the call ran elsewhere: if the task needed the user's logins, say so.
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

## Arguments

- Platform verbs take **one object**: `w.openUrl({url})`, `w.newTab({url})`,
  `w.closeTab({id})`, `w.selectOption({ref, option})`. `w.openUrl("https://…")` is refused.
- The universal verbs are positional: `w.click(t)`, `w.setText(t, text)`, `w.keys("Enter")`,
  `w.find("Save", {role: "button"})`.
- `computer.surface(x)` binds a tab that is **already open**, by id or title. It never takes a
  URL and never opens anything: bind a tab, then `await w.openUrl({url})`.
- `w.newTab({url})` returns a **note** naming the new tab's id, not a handle; `w` stays on its
  own tab. Bind the new one: `const t2 = await computer.surface("<id from the note>")`.
- If `newTab` fails saying the tab never appeared, nothing else was taken in its place: try once
  more, then list surfaces. Do not act on whichever tab happens to be active instead.
- A link or `window.open` that asks for a new tab gets a real one (`target="_blank"`, also
  inside an iframe). The click's own line names the new tab's id and where it landed, and `w`
  stays on the tab it clicked: bind the new one with `computer.surface("<id from the line>")`.
  To check "does this open in a new tab?", read that line or `computer.surfaces()` in the same
  call — no second tab and the page (or frame) itself navigated means it did not.

## Going on in one call

Most extra round trips are a call that only returns a check, followed by a call that does the
next stage. When the check only decides whether the plan continues, assert it and keep going
in the same code — a failed check stops the run with its reason, which is what you would have
read:

```js
await w.click(await w.find("Save", {role: "button"}));
await w.expect({text: "Saved"});                     // throws, with the reason, if not
if (!await w.wait({url: "/tasks"})) throw new Error("did not return to the list");
await w.click(await w.find("New task", {role: "button"}));   // next stage, same call
```

Branch on what the page shows only for a **known detour with no side effect**. `find(name,
{why: true})` answers a miss with its `reason` instead of `null`, so the code can tell an
overlay (`covered`) from a control that is not there yet (`absent`) and take the right way out:

```js
let m = await w.find("Menu", {role: "button", why: true});
if (m.reason === "covered") { await w.keys("Escape"); await w.wait({}); }   // m.by names the cover
else if (m.reason === "absent") await w.wait({control: "Menu"});
if (!m.ref) m = await w.find("Menu", {role: "button", why: true});
if (!m.ref) throw new Error(m.note);                 // the journal's own words
await w.click(m);
const toggle = await w.find("Light mode", {role: "button"}) ?? await w.find("Dark mode", {role: "button"});
await w.wait({control_gone: "Loading tasks"});       // a load needs no branch: returns at once when idle
```

Where code must not choose:

- **Confirms, deletes, submits, sends, payments.** No branch leads into one, and no `try/catch`
  steps past one that failed or came back `[uncertain]`: stop, read the result, then decide.
- **A confirm dialog.** `dialog({answer: "accept"})` armed before the click accepts text you
  never read. Click without arming — the confirm is dismissed and the journal quotes it — read
  it, and only if it says what you meant to do, arm accept and click again.
- **An unexpected sign-in page.** The session was lost: maybe the change you just made broke it,
  maybe that is the bug you are looking for. Stop and look; signing in from code hides it. The
  one exception: the task or the user gave the account and said a sign-in may come up again.
- **What `why` cannot settle.** `filtered` and `text` mean your query is wrong, not the page;
  on macOS a covered control reads as `absent`. Fix the query or look.
- **An option that is not there.** When a select lacks the option you expected, read the
  options and report it; do not quietly pick another — in a QA task that is the finding.

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

- calls keep failing the same way before any verb runs (the journal shows nothing dispatched),
  for instance a verb a previous call left un-awaited is still "in progress";
- you overwrote something the runtime needs (assigned to `computer`, redefined a helper badly)
  and can no longer trust its top-level state;
- the browser or the extension reconnected and rebinding alone did not bring the handles back.

Do not reset to "start over" on the page (navigate or reload instead), to retry a failed click,
or to take a target another session holds. After closing the session's last tab no reset is
needed either: `openUrl({url})` or `newTab({url})` on the old handle opens a fresh one.

In Codex, `computer_repl_reset` must be approved like `computer_repl`
(`approval_mode = "approve"`), or the call is refused exactly when you need it.
