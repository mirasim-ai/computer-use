# Driving computer-use from another program

Two doors, and a host picks one by whether it wants a process boundary.

| Entry | Shape | Use it for |
|---|---|---|
| `mirasim-cu mcp` | MCP stdio server exposing `computer_repl` / `computer_repl_reset` | any MCP-capable agent host (Claude Code, Codex, the Mirasim desktop app) — one child per surface |
| the library (`resolveProfile`) | in-process: the host holds the drivers and calls the tools itself | a Node host that wants several sessions in ONE process, each with its own surface |

The library door is the only one that is not a process boundary, and that is its whole
reason: it takes every knob the env carries as an explicit option (`ProfileOptions`), which
is what lets one process drive several sessions at once — a spawned entry gets one surface
per process and reads the same knobs from the environment.

computer-use runs no model of its own, so there is no agent transcript to stream: an embedding
host needs nothing beyond what these two doors give it.

An MCP host drives the tools with its own loop and never sees a system prompt — there is none
to see — so the grounding teaching (act by ref or by x/y, why an element list is
viewport-clipped, how long a ref lives) rides the protocol's own `instructions` field in the
initialize result. It is driver-specific; hosts that ignore the field still get
everything else from the tool descriptions.

## Choosing the platform and device: env at spawn

For a SPAWNED entry the session profile (its drivers) is frozen at bootstrap from the
environment — which is what makes one child per surface the unit a host keys on. An in-process
host passes the same values as `ProfileOptions` instead; the table is the mapping:

| Variable | Meaning |
|---|---|
| `COMPUTER_USE_PLATFORMS` | `browser` (default), `electron`, `macos` or `windows`; a comma-separated list mounts several in one session |
| `COMPUTER_USE_MACOS_FALLBACK_APPS` | macOS bundle ids a host that CANNOT ask (no MCP elicitation) may drive; unset = no limit. A host that declares elicitation is asked per app instead |
| `COMPUTER_USE_MACOS_APPROVALS` | where computer-use keeps macOS "always allow" answers (`persist: "always"`) for a host that keeps none; default `<home>/macos-approvals.json`, `""` turns it off for a host that keeps its own |
| `COMPUTER_USE_WINDOWS_APPROVALS` | the same for Windows apps (by executable stem); default `<home>/windows-approvals.json`, `""` turns it off |
| `COMPUTER_USE_HOST_APPS` | apps this agent runs inside (macOS bundle ids, Windows program names; comma-separated): never listed, never driven — an observation of them would contain the session's own UI. Unset = none |
| `COMPUTER_USE_ELECTRON_CDP_URL` | the Electron app's renderer debugging endpoint (port or full URL) |
| `COMPUTER_USE_BROWSER` | `extension`: the user's own browser through the Mirasim extension; with no `COMPUTER_USE_CDP_URL` the session finds or starts the bridge itself (`<home>/bridge.json`). A host that supervises its own bridge passes its endpoint in `COMPUTER_USE_CDP_URL` instead |
| `COMPUTER_USE_CDP_URL` / `COMPUTER_USE_CHROME` / `COMPUTER_USE_PROFILE_DIR` / `COMPUTER_USE_WINDOW` | browser settings (Managed-browser settings below) |
| `COMPUTER_USE_TAB` | one durable tab in a SHARED browser instead of a browser of its own, so several sessions are several tabs of one Chrome: `name:<key>` (shares cookies with the other named tabs), `ctx:<key>` (its own isolated context: cookies and storage), or `reuse` (an exclusive browser continues its most recent tab). The tab is stamped by `window.name`, so a respawned child re-adopts it |
| `COMPUTER_USE_RUN_SLUG` | the run-directory name under `<home>/run/` (endpoint, journal, shots); default the profile dir's basename. Set it when several sessions share one profile dir, so each keeps its own |
| `COMPUTER_USE_REPL_DOCS_DELIVERED=1` | the caller already has `computer_repl`'s API reference (it came with the first result of an earlier child of the same session), so the first result carries a one-line pointer instead. For a host that respawns children |
| `COMPUTER_USE_MACOS_CAPTURE_SOCKET` / `_TOKEN` / `_LEASE` | a host-owned native capture service shared by its runtimes; see [Shared native capture](#shared-native-capture-macos) |
| `COMPUTER_USE_SHOTS_KEEP` | per-action evidence screenshots kept in the run dir's `shots/` (rolling; default 500, `0` disables) |
| `COMPUTER_USE_ATTACHED=1` | the profile dir is the USER'S own Chrome: agent takes its own window, never kills by profile (Managed-browser settings below) |

Switching a host from one platform to another is therefore a spawn-env
change, not a new interface.

## Host protocol

Everything a host can do beyond calling the two tools, in the order a session meets it. A plain
MCP client needs none of it; each part is opt-in, and a part a host does not take is a capability
that host does not get, never an error.

**Handshake.** The client's `initialize` capabilities decide what is on:

- `elicitation.form` — computer-use may ask the user before driving a native app (below). Without
  it, macOS drives the apps in `COMPUTER_USE_MACOS_FALLBACK_APPS` (unset: every app) and Windows
  drives every app: whoever started the server is then the operator.
- `experimental["mirasim-computer-use/preview"]` — live preview (next section).

The server advertises `experimental["mirasim-computer-use/preview"] = { version: 1 }`, and its
`instructions` carry the grounding teaching (see the top of this document).

**Asking before an app.** The first read of or action in a native app this session has not been
cleared for sends `elicitation/create`, a form with an empty schema (accepting IS the yes), whose
`_meta` names the app:

| `_meta` key | Platform | Value |
|---|---|---|
| `mirasim-computer-use/macosApp` | macOS | `{ bundle, name, purpose? }`: bundle id, display name |
| `mirasim-computer-use/windowsApp` | Windows | `{ app, title, purpose? }`: executable stem (`WINWORD`), window title |
| `persist` | both | `["session", "always"]`: the durations the host may grant |

`purpose` is the agent's own description of its task (`computer_repl`'s `purpose` argument, ≤ 500
characters): show it as the agent's claim; it does not narrow the permission. A host may answer
from its own allow-list without asking anyone.

The answer is a normal elicitation result; its `_meta` says how long a yes holds and why a no:

| Answer | Meaning |
|---|---|
| `action: "accept"` | allowed for this call only |
| … with `_meta.persist: "session"` | allowed until this server process ends |
| … with `_meta.persist: "always"` | allowed in later sessions too: kept in the approvals file, unless the host turned that off (`COMPUTER_USE_*_APPROVALS=""`) |
| `action: "decline"` or `"cancel"` | refused; the agent is told not to ask again in this task. `_meta["mirasim-computer-use/reason"]` (a sentence) travels with it, which matters when nobody saw a prompt (timed out, no one at the computer): "declined" would misreport that |

A question waits up to 15 minutes; the host is expected to give up first and say so.

**Taking a clearance back.** `notifications/mirasim-computer-use/revoke` with `{ ids: string[] }`
(macOS bundle ids, Windows executable stems) drops every clearance of those apps at once (this
call's, this session's and the stored "always") and removes them from the live preview. The next
read or action in one of them asks again. A host that keeps its own allow-list sends it when an
app leaves that list.

**Ending a turn.** A host with turns can call the tool `turn_ended`, which `tools/list` does not
show (the same shape as Codex's hook): arguments `{ session_id, turn_id, hook_event_name?,
keep_browser_tabs? }`. It resets the REPL (waiting for input in flight to drain), lets each
platform close what this session opened (the browser closes its own tabs unless
`keep_browser_tabs`; nothing the user owns is closed), disconnects the drivers and releases this
session's ownership claims. It is idempotent per `session_id` + `turn_id`, and a call that
arrives while it runs is refused rather than started. A client that never sends it keeps
`computer_repl`'s persistent behavior.

**Supervising the browser bridge.** A host that runs the extension bridge itself
(`mirasim-cu bridge --json`, then hands its endpoint to children in `COMPUTER_USE_CDP_URL`)
sets `COMPUTER_USE_BRIDGE_PARENT_STDIN=1` on it and keeps its stdin open: the bridge exits when that
pipe closes, so a host that crashes or is killed leaves no orphan holding the port. A bridge
started by hand ignores its stdin.

**Tagging calls.** `tools/call` may carry `_meta["mirasim-computer-use/previewTask"]` (a string):
the host's own task id, echoed on the preview targets that call touched.

**Respawning.** A host that reaps idle children and starts new ones for the same session can set
`COMPUTER_USE_REPL_DOCS_DELIVERED=1` on the new one (see the table above), and `COMPUTER_USE_TAB`
makes the new child re-adopt the same browser tab.

## Live preview: the `mirasim-computer-use/preview` extension

An MCP host can show its user what the agent is working in, as live video, without capturing
anything itself. It is an opt-in MCP extension: the server advertises
`capabilities.experimental["mirasim-computer-use/preview"] = { version: 1 }`, and a client turns
it on by declaring the same key in its own `initialize` capabilities. A client that does not
declare it gets no preview work at all: nothing is tracked, nothing is captured.

Once on, three messages carry it:

| Message | Direction | Params |
|---|---|---|
| `notifications/mirasim-computer-use/preview/targets` | server → client | `{ targets: Target[] }`, the whole current list (≤ 16, most recent last), sent after the agent acts somewhere |
| `mirasim-computer-use/preview/watch` (request) | client → server | `{ targets: [{ kind, targetId }], maxSize? }`: video for exactly these from now on; `[]` stops it all. Answers `{}` |
| `notifications/mirasim-computer-use/preview/frame` | server → client | `{ kind, targetId, mimeType, data, width, height, capturedAt }` |
| `notifications/mirasim-computer-use/preview/status` | server → client | `{ kind, targetId, unavailable: string \| null, icon? }` |

A `Target` is `{ kind, targetId, title, url, appName, updatedAt, taskId, pointer?, capture }`:

- `kind` is `browser`, `electron` or `macos`; `kind` + `targetId` is its identity.
- `pointer` (`{ x, y, kind, ts }`) is the last action point and the verb that landed there, in
  the same coordinates as a frame's `width`/`height` (CSS pixels for a page, points for a window).
- `taskId` echoes the `_meta["mirasim-computer-use/previewTask"]` of the tool call that last
  touched it, so a host can tie a target to its own task.
- `capture` says what is being captured: `{ type: "cdp", endpoint, targetId }` or
  `{ type: "macos", app, pid, windowId }`.

A target leaves the list when its page is closed or its macOS app's approval is revoked.

Frames:

- `data` is base64. Pages come as `image/png`, which keeps text sharp and transparent canvases
  intact. macOS windows come as `image/jpeg`.
- Each frame fits within `maxSize` (default 2560) on its long side.
- A page sends a frame when its picture changes, at most 10 per second. macOS sends up to 10 per
  second.
- While earlier output is still unread, a new frame is dropped rather than queued, so tool
  results never wait behind video.
- A first frame arrives right after `watch` even for an idle page.

`status` reports a capture that stopped (`unavailable` says why; the next frame clears it) and,
for a macOS window, its app icon as a data URL. Watching needs nothing beyond the grants the agent
already has: a macOS window needs Screen Recording, like its screenshots.

## Watching a browser session

The managed browser's CDP endpoint is knowledge only computer-use has, so the driver
publishes it for observers at `<home>/run/<profile>/endpoint.json`
(`{cdpUrl, port, pid, profileDir, updatedAt}`) — a host that wants a live read-only
view (screencast, debugging) attaches there without asking computer-use. Next to it the
driver keeps an **action journal**: `actions.jsonl`, one JSON line per performed
action, and `shots/`, one JPEG of the page taken right after each action. Attached
browsers (`COMPUTER_USE_ATTACHED=1`) publish nothing — the browser is the user's own and
there is no run dir.

Journal line fields:

| Field | Present | Meaning |
|---|---|---|
| `ts` | always | epoch ms when the action was journaled |
| `kind` | always | the dispatched verb: `click`, `hover`, `set_text`, `keys`, `scroll`, `drag`, `focus`, `open_url`, `back`, `reload`, `select_option`, …; `verdict` for a frozen-verdict line |
| `url` | always | the active page's URL after the action (`""` if unreadable) |
| `ok` | action lines | whether the dispatch succeeded (a missing target or a thrown dispatch ⇒ `false`) |
| `x`, `y` | point known | page-CSS-pixel action point: the given coordinates, or the located element's center measured before the action ran |
| `name` | name-grounded actions | the element name the action targeted |
| `text` | `set_text` | the exact text written — verbatim, it is behavioral evidence, deliberately unredacted |
| `chord` | `keys` | the chord as requested (e.g. `Ctrl+A`) |
| `direction`, `to` | `scroll` | paging direction (`up`/`down`) / jump target (`top`/`bottom`) |
| `moved`, `container` | `scroll`, when measured | the measured displacement in px / the container that was scrolled (its name, or `window`) |
| `target` | `focus` | the tab id switched to (matches `computer.surfaces()` ids) |
| `auto` | `focus` the model did not ask for | `true` when the driver moved the active tab itself (a tab it opened, or the one it was on closed) |
| `verdict` | `kind: "verdict"` | `frozen`: an observation found nothing changed on screen; such a line has no `ok` and no `shot` |
| `note` | failures | the failure reason (first line), only when `ok` is `false` |
| `shot` | screenshot taken | run-dir-relative path (`shots/<seq>.jpg`) to the post-action screenshot |

Reader contract:

- **Absent means unknown, never null** — consumers that only read `kind`/`x`/`y` (a
  pointer-compositing preview) keep working unchanged; `wait` never reaches the driver
  and is not journaled. Other driver-measured fields can appear (`fromX`/`fromY` on a
  `drag`, for example); ignore what you do not read.
- **`shot` is trustworthy when present**: the line is appended only after the JPEG is
  on disk. A line without `shot` means the screenshot could not be taken or shots are
  disabled — the action itself still happened.
- **Shot numbers grow monotonically** within a run dir, resuming after the highest
  number on disk when a new session starts; gaps are normal (failed captures, pruning).
- **Rolling cleanup**: only the newest `COMPUTER_USE_SHOTS_KEEP` shots are kept (default
  500; `0` disables screenshots — no `shots/` dir, no `shot` fields). `actions.jsonl`
  itself is truncated as a whole once it exceeds 256 KB, so tail it — do not assume
  the file holds the full history.
- **Best-effort by contract**: journal writes are fire-and-forget and serialized in
  action order; they never fail or slow a turn.

## Seeding login state across profiles

A host that gives each session an isolated browser profile can still let them start
logged in: have the user log in ONCE in a seed profile, export that profile's state,
and import it into each session profile before the session starts. All three steps are
CLI + env — no library import, no profile-directory copying:

```sh
COMPUTER_USE_PROFILE_DIR=<seed>    mirasim-cu browser open                       # user logs in by hand
COMPUTER_USE_PROFILE_DIR=<seed>    mirasim-cu browser state export --out s.json  # capture (or read stdout)
COMPUTER_USE_PROFILE_DIR=<session> mirasim-cu browser state import --in s.json   # before the session starts
```

Contract: export prints pure Playwright-`storage_state` JSON on stdout when `--out` is
absent (summaries go to stderr); import is idempotent; both exit 0 on success and
non-zero with the reason on stderr. Boundary: cookies are complete, localStorage covers
the origins of tabs open at export time — so export right after the login, while the
site's tab is still open.

## Shared native capture (macOS)

Multiple ScreenCaptureKit helpers can interfere on macOS 27.0.1: helper A captures, B's capture
times out, A exits, then B's next request returns the localized TCC refusal. TCC allows B's own
preflight, but `replayd` submits the exited A's audit token and fails with `No such process`.
The same sequence was traced from a preview helper's exit to a screenshot failure.

A host that runs several native runtimes (the Mirasim desktop app does) therefore owns one
`mirasim-cu capture-server`. That service owns the only ScreenCaptureKit helper used by
the host's computer-use runtimes and native previews. Input and Accessibility element keys
remain in per-runtime helpers.

### Boundary and lifecycle

The host creates a private directory and Unix socket, with a random authentication token. The
directory/socket modes are 0700/0600. `COMPUTER_USE_MACOS_CAPTURE_SOCKET` and `COMPUTER_USE_MACOS_CAPTURE_TOKEN`
are capability secrets passed to computer-use children; they must not be logged or returned to models.
`COMPUTER_USE_MACOS_CAPTURE_LEASE` is a file path the service writes its own PID and its helper's
PID to (`{ owner, worker }`, atomically, mode 0600) once the helper starts: the execution record
below, which the host reads to wait for both to exit before starting a replacement.
The service has only screenshot and preview operations, accepts exact PID/window identities,
rejects browser Origins and input/AX-key parameters, and bounds request size, queue and replies.

For a ref crop, the calling runtime's AX helper verifies the element's app and window, resolves
its region, and includes the current window geometry. The capture worker rechecks that geometry;
a moved, resized or missing window is refused. Pointer annotations are passed per request, so
one session's pointer state cannot become another session's screenshot mark.

Native video subscriptions have separate stream IDs. Closing a viewer stops its stream, not
other streams or screenshots. A reset/turn end closes the runtime's input helper and its own
requests, without stopping shared capture. Host shutdown drains/stops the capture helper. An
execution record prevents a replacement service from starting while a previous worker is still
exiting. A worker failure ends active previews explicitly; reopening reconnects them.

Standalone `mirasim-cu mcp` without this host endpoint retains its local-helper behavior. A host
running multiple native runtimes should provide one capture service to all of them, including
the preview video each runtime serves; it must not launch a capture server per runtime.

### Error evidence

`capture_service_error` covers capture-transport failures and OS capture failures despite an
allowed preflight. An OS failure carries `capture: {stage, domain, code, helperPid, screenRecording}`.
`not_granted_screen` continues to represent an absent permission. Permission rejection never
triggers another capture backend. Only `capture_timeout` uses the existing bounded window-only
fallback. A capture-service restart does not change any system permission.

## Configuration and state

What the README's Install section leaves out.

### Native helpers

The macOS and Windows drivers each run a small native helper. npm installs it prebuilt, as the
platform package `@mirasim/computer-use-<platform>-<arch>` (macOS arm64/x64, Windows x64/arm64).
The package itself carries no helper sources, so on any other target, or with
`--omit=optional`, the macOS and Windows surfaces are unavailable until the helper is supplied:
`COMPUTER_USE_MACOS_AX_BIN` / `COMPUTER_USE_WINDOWS_UIA_BIN` name a prebuilt one. A repository
checkout instead builds it from its sources on first use (`swiftc` from the Xcode command line
tools, or Rust's `cargo`) and caches it.

### Browser startup and state

Browser startup is automatic. In normal use computer-use tries, in order:

1. `COMPUTER_USE_CDP_URL` when set (treated as a recoverable hint),
2. an existing Chrome at `http://127.0.0.1:9222`,
3. the managed Chrome: adopt-or-launch on a persistent profile at `<home>/chrome`.

`<home>` is where computer-use keeps its own state: `COMPUTER_USE_HOME` when set, else
`~/.mirasim-computer-use`. That covers the managed profile, the `run/` directories, the
"always allow" lists, the bridge's socket and logs, downloads and the compiled helpers.
State that every runtime on the machine must agree on stays under `~/.mirasim-computer-use`
whatever `COMPUTER_USE_HOME` says:

- the ownership database (`ownership/claims.sqlite`): runtimes that can reach the same screen
  and browsers arbitrate in one place;
- the native-messaging host for the browser extension (`native-host/`): Chrome starts one
  wrapper per host name, so every installer keeps its record there;
- the browser's download staging (`downloads/.staging`), which Chrome keeps per browser process.

`setup extension` and `bridge --native-host` also write the native-messaging manifest into each
Chromium-family browser's own configuration folder, where the browser looks for it.

The managed browser is a device, not a subprocess. It is launched detached with
`--remote-debugging-port=0` and found again through the `DevToolsActivePort` file Chrome
publishes into the profile, so a follow-up session **adopts** the running browser
(milliseconds) instead of paying a launch (~0.7–1.5s) — logins, cookies and tabs carry
over. Closing computer-use disconnects; it never closes the browser. A leftover browser whose
renderer froze is detected by a short attach deadline, killed **by identity** (only pids
whose command line names our profile directory — the user's own Chrome is unreachable by
construction) and replaced in about a second.

### Managed-browser settings


- `COMPUTER_USE_PROFILE_DIR` — profile directory (default `<home>/chrome`).
- `COMPUTER_USE_CHROME` — Chrome/Chromium binary, when discovery misses.
- `COMPUTER_USE_WINDOW=offscreen` — park the window off-screen (for hosts that render their own
  preview). Off-screen, never minimised: a minimised window stops compositing, which kills
  screencast frames and hangs wheel input. Default is a visible window.
- `COMPUTER_USE_SHOTS_KEEP` — how many per-action evidence screenshots the run dir's `shots/`
  keeps (rolling; default 500). `0` disables per-action screenshots entirely.
- `COMPUTER_USE_ATTACHED=1` — **the profile is the USER'S own browser**, not a disposable device.
  Set it whenever `COMPUTER_USE_PROFILE_DIR` points at someone's real Chrome data.
  It changes three things, each of which is damage otherwise:
  the agent opens **its own window** instead of taking a tab the user is looking at and
  only lists targets from that window; a browser that cannot be driven becomes an **error
  with advice** instead of a SIGTERM to the process they are working in; and the
  keep-clicks-in-one-tab script is injected per page rather than context-wide, so their
  other tabs keep behaving normally. Never infer it — guessing wrong destroys a window
  someone was working in.

If no Chrome exists and none of the knobs point at one, the first browser action fails
with the fix in hand (install Chrome / set `COMPUTER_USE_CHROME` / set `COMPUTER_USE_CDP_URL`) — never
a silent degrade.

To drive an existing Chrome, start it with CDP enabled:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
```

A stale `COMPUTER_USE_CDP_URL` no longer blocks startup. For a strict endpoint that must not
fall back to another browser, set `COMPUTER_USE_CDP_STRICT=1` beside `COMPUTER_USE_CDP_URL`.

### Downloads

Arm `await w.download()` before the download action, then query its returned ID with
`await w.download({id: watch.id})`. The structured result carries completion or failure,
the actual file path and host, and ambiguity when several files match. Independent-browser
downloads are persisted outside Playwright's temporary artifacts; extension downloads retain
Chrome's own location and require the extension's `downloads` permission.

### Your own browser (extension)

The [Mirasim extension](https://chromewebstore.google.com/detail/mirasim/khflooofmndpmafhofjdcpjfgnlpikhg)
from the Chrome Web Store lets an agent drive the browser you are signed into, in a tab group of
its own. Install the extension, then ask for it in the MCP server's environment — nothing else
to set up:

    claude mcp add my-browser -e COMPUTER_USE_BROWSER=extension -- mirasim-cu mcp

With `COMPUTER_USE_BROWSER=extension` (and no `COMPUTER_USE_CDP_URL`) the first browser call
finds this home's bridge through `<home>/bridge.json`, or starts one in the background
(`mirasim-cu bridge --native-host`, logging to `<home>/bridge.log`). The bridge outlives the
session, so later sessions adopt it; kill the pid in `bridge.json` to stop it. A session never
falls back to a managed browser: when the extension is not connected, the error says why —
including when the Mirasim desktop app's bridge holds it (the extension serves one bridge at
a time, and the desktop app's comes first).

Chrome reaches the bridge through native messaging. `bridge --native-host` writes a manifest
into every Chromium-family browser it finds (Chrome, Edge, Brave, Arc, Vivaldi, Opera, …) and
repeats that while no extension is connected, so a browser installed later is covered;
`mirasim-cu setup extension` does the same by hand. The host name is shared with the Mirasim
desktop app: each installer keeps its own record under `~/.mirasim-computer-use/native-host/`,
the wrapper Chrome runs tries them in priority order (the desktop app first) and connects to
whichever bridge is running. `mirasim-cu setup extension --remove` takes this computer-use's
record back.

A record names the node and script that wrote it, plus that process's PATH without the
`node_modules/.bin` folders npm and npx put in front. Run through `npx`, the script lives in
npx's cache (`~/.npm/_npx/<hash>/…`): when the cache is cleared the wrapper skips the record,
and the next session's bridge writes it again with the new path.

### Native apps

`COMPUTER_USE_PLATFORMS` picks what a session may reach, comma-separated (default `browser`):

    claude mcp add mirasim-cu -e COMPUTER_USE_PLATFORMS=browser,macos -- npx -y @mirasim/computer-use mcp

Every driver connects lazily, so mounting one the run never touches costs nothing.

- **macOS** reads and acts through the accessibility tree, in the background by default: the
  target app is not brought to the front and the user keeps keyboard and pointer. macOS grants
  Accessibility (and Screen Recording, for screenshots) to the app that launched the agent —
  your terminal or agent app — so grant them there; `mirasim-cu setup macos` checks
  both for the app it is run from and opens the pane of a missing one. Before driving an app,
  the server asks the user through MCP elicitation; an answer of "always" is kept in
  `<home>/macos-approvals.json`, which `mirasim-cu approvals` lists and edits.
  A host that declares elicitation but answers no question (a non-interactive run such as
  `claude -p`) refuses every app nobody allowed ahead of time with
  `mirasim-cu approvals add <bundle id>`; the refusal names that command.
  Under a host without elicitation, the apps listed in `COMPUTER_USE_MACOS_FALLBACK_APPS`
  (comma-separated bundle ids) may be driven — or any app when it is unset, since whoever
  started the server is then the operator.
- **Windows** works the same way through UI Automation, with approvals in
  `<home>/windows-approvals.json`.
- **Electron** drives any app started with `--remote-debugging-port=<port>`;
  `COMPUTER_USE_ELECTRON_CDP_URL` points at it (default `http://127.0.0.1:9333`).

A host that keeps its own approval list turns the stored one off with
`COMPUTER_USE_MACOS_APPROVALS=""` / `COMPUTER_USE_WINDOWS_APPROVALS=""`.

## Device lifecycle

The driver installs nothing. The one thing it starts is the surface it drives: the managed
Chrome, adopted or launched on the first browser call (see Browser startup and state above). Hosts that want
dependency bootstrap shell out to the same verbs users type: `mirasim-cu setup browser`
(verify a driveable Chrome), `setup macos` (check the Accessibility and Screen Recording grants)
and `setup extension` (record the native-messaging host for the browser extension).
