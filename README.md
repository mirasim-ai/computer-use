# Mirasim Computer Use

Computer use for any agent: an MCP server that lets the agent you already use (Claude Code,
Codex, or any MCP host) operate browsers, macOS apps, Windows apps and Electron apps.

Think of how a person checks an account balance on a website they use every day. They know the
steps before the page opens, so they just go through them quickly. Someone new to the site has
to take one step, look, and only then work out the next one. Capable models now work like the
experienced person: they plan several GUI steps at once. Mirasim Computer Use is tuned for
exactly that. It runs a multi-step plan reliably and gives the model accurate feedback on every
step, so the model can trust the result instead of checking the screen after each click. With a
strong model, the same task takes fewer model calls and finishes sooner.

The screen reads back as text, a numbered list of elements from the accessibility tree, and
pixels are used only when text is not enough. It runs no model of its own and needs no API key:
the host's agent calls the tools with its own model. The [Mirasim](https://mirasim.ai) desktop
app ships the same tools built in (Settings → Computer Use).

## Benchmark

![Same model, same tasks, 39% less time](docs/benchmark/codex-frontend.png)

Six small frontend tasks on a React + Vite app (two features, three bug fixes, one QA pass), run
in Codex in the ChatGPT desktop app with the same model and the same prompt. The only difference
is the tool the agent checks its work with: Codex Computer Use in Codex's in-app browser, or
Mirasim Computer Use as an MCP server. Each tool ran every task 5 times, the two interleaved in
one session; timing comes from Codex's own session record, and the final code was graded by
hidden behaviour checks.

With Mirasim Computer Use the agent finished in 39% less time and passed 30/30 tasks (vs 26/30).
The time was saved in round trips, not in the browser: the agent made 37% fewer model requests
while writing almost the same number of output tokens. `observe()` returns elements as data, so
the agent puts its checks in the script and gets back a verdict instead of reading the page after
every click. And a click lands where a user's mouse would: on the QA task an invisible layer
covers a button, Mirasim Computer Use fails the click and names the layer, while Codex Computer
Use reports the click as done, and its report caught the bug in 1 of 5 runs.


## Install

Needs Node.js 22.19 or later. Register the MCP server with your agent:

```sh
claude mcp add mirasim-cu -- npx -y @mirasim/computer-use mcp
```

or install the `mirasim-cu` command once with `npm install -g @mirasim/computer-use`.

In Codex, add it to `~/.codex/config.toml`, and approve both tools: Codex asks before every
MCP call by default, and when it is set never to ask (`approval_policy = "never"`) a tool
without `approval_mode = "approve"` is refused outright — `computer_repl_reset` included,
which is the call a stuck session reaches for:

```toml
[mcp_servers.mirasim-cu]
command = "npx"
args = ["-y", "@mirasim/computer-use", "mcp"]

[mcp_servers.mirasim-cu.tools.computer_repl]
approval_mode = "approve"

[mcp_servers.mirasim-cu.tools.computer_repl_reset]
approval_mode = "approve"
```

**Browser** works out of the box: computer-use drives a Chrome of its own (installed Google
Chrome is required), keeping its profile under `~/.mirasim-computer-use` so logins carry over
between sessions. To drive the browser you are signed into instead, install the
[Mirasim extension](https://chromewebstore.google.com/detail/mirasim/khflooofmndpmafhofjdcpjfgnlpikhg)
and add `-e COMPUTER_USE_BROWSER=extension`. By default the agent sees only the tabs it opens and
the ones you hand it: click the extension's toolbar icon on a tab to hand that tab over, and use
its panel to take tabs back, pause the agent, widen what it may reach or block sites. The icon is
in colour on tabs the agent may use and grey on the rest.

In extension mode the first browser call starts a bridge in the background and registers it as
the extension's native-messaging host: a record under `~/.mirasim-computer-use/native-host/`
and a manifest in each Chromium-family browser's configuration folder. The record names the
program that started it, which under `npx` is a path in npx's cache; a record whose program is
gone is skipped, and every bridge start writes it again.
`npx -y @mirasim/computer-use setup extension --remove` takes it back. The extension serves one
bridge at a time, and the Mirasim desktop app's comes first: while browser control is on there,
extension mode says so at once and does not connect.
Details in [docs/embedding.md](docs/embedding.md#your-own-browser-extension).

**Native apps** are opt-in with `COMPUTER_USE_PLATFORMS` (comma-separated, default `browser`):

```sh
claude mcp add mirasim-cu -e COMPUTER_USE_PLATFORMS=browser,macos -- npx -y @mirasim/computer-use mcp
```

- `macos` and `windows` drive native apps through their accessibility tree in the background.
  On macOS, grant Accessibility (and Screen Recording, for screenshots) to the app that runs
  your agent; `mirasim-cu setup macos` checks both.
- `electron` drives any app started with `--remote-debugging-port=<port>`
  (`COMPUTER_USE_ELECTRON_CDP_URL`, default `http://127.0.0.1:9333`).

**Which apps the agent may drive.** Before the agent first touches a native app, the server asks
you through your agent's MCP client (MCP elicitation): allow it once, for the session, or always.
What that looks like depends on the client:

- A client that shows the question (Claude Code in a terminal, for one): you answer it there.
- A non-interactive run (`claude -p`, CI) declines every question unseen, so an app nobody
  allowed is refused. Allow it ahead of time with
  `npx -y @mirasim/computer-use approvals add com.apple.TextEdit` (a macOS bundle id; on Windows
  the executable's name, e.g. `WINWORD`). `approvals` lists them; `approvals remove` revokes one.
- A client without elicitation support cannot ask, so the server drives **every** app the agent
  names. On macOS, `-e COMPUTER_USE_MACOS_FALLBACK_APPS=com.apple.TextEdit,…` narrows that to
  the listed apps.

The macOS and Windows drivers use a small native helper that npm installs prebuilt for macOS
arm64/x64 and Windows x64/arm64. Every setting, the state directory and the host protocol are
documented in [docs/embedding.md](docs/embedding.md).

## Use

```sh
mirasim-cu mcp                   # MCP stdio server — the runtime
mirasim-cu browser open          # summon the managed browser for the user
mirasim-cu setup browser         # dependency bootstrap: verify a driveable Chrome exists
mirasim-cu setup macos           # check Accessibility + Screen Recording; open a missing pane
mirasim-cu approvals             # apps answered "always allow"; add / remove <app>
```

To drive computer-use from another program — the spawn environment, the host protocol, the
opt-in live preview, the action journal, shared native capture — see
[docs/embedding.md](docs/embedding.md).

The host's agent calls `computer_repl` directly and reads the resulting observation in the current
session. The tool server runs no model of its own.

- **`mcp`** serves the tools to a host that brings its own agent loop:
  ```sh
  claude mcp add mirasim-cu -- mirasim-cu mcp
  ```
  stdout is protocol-only, so the server records nothing by default — and the structured
  `details` of each result (url / verdict / elementCount) never reaches the host at all.
  `COMPUTER_USE_MCP_LOG` is the way to see it: one JSON line per call, plus a `server_start` line
  naming the configuration.
  ```sh
  COMPUTER_USE_MCP_LOG=~/.mirasim-computer-use/mcp.jsonl mirasim-cu mcp
  # {"ts":"…","type":"server_start","version":"0.1.0-rc.1","platforms":"browser","tools":[…]}
  # {"ts":"…","type":"call","tool":"computer_repl","args":{"code":"await w.observe();"},"isError":false,"ms":412,
  #  "details":{"url":"https://example.com","verdict":"changed","elementCount":7,"ledgerLines":2,
  #   "timing":{"runMs":96,"observeMs":310,"steps":[{"kind":"observe","target":"","ok":true,"ms":96,"note":"7 elements"}]}}}
  ```
  `details.timing` says where a `computer_repl` call's time went: each step of the code (reads,
  waits and expects included) with its `ms`, the run in total (`runMs`), and the closing
  observation apart (`observeMs`, the settle re-check included). The model's own journal carries
  none of it. Failures are logged the same way (`isError: true`, with `details.error`), including a tool
  name the host got wrong. Missing parent directories are created; a log that cannot be
  written is dropped rather than failing the call.

## Tools

Two tools, assembled per driver at session start:

| tool | role |
|---|---|
| `computer_repl` | JavaScript over the GUI in a PERSISTENT session: reads (`observe()`, `find(name)`, `text()`, `page()`, `screenshot()`, `diagnostics()`), actions (`click`, `hover`, `setText`, `keys`, `scroll`, `wait`, `focus` + the driver's verbs — `openUrl`, `newTab`, `selectOption`, `paste`, `launchApp`, `menu`, …), and surface HANDLES (`computer.surfaces()` / `computer.surface(id)`) that bind verbs to one tab / window / app. Top-level declarations persist across calls; the first result carries the API reference; every run ends with one observation and a changed/frozen verdict |
| `computer_repl_reset` | discard the JavaScript bindings — surfaces untouched |

Element observations are incremental by default: when little changed since the previous
one, only the diff is sent (refs are sticky, so unchanged lines drop out), with a full
list re-sent periodically.

## License

[Apache License 2.0](LICENSE) © MIRASIM, INC. Parts of the browser extension bridge are adapted
from [Playwright](https://github.com/microsoft/playwright) (Apache-2.0, © Microsoft Corporation);
see [NOTICE](NOTICE). The Windows helper's statically linked Rust crates and their licenses are
listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

"Mirasim" and the Mirasim logo are trademarks of MIRASIM, INC. and are not licensed under the
Apache License. Chrome, Claude, Codex, ChatGPT, macOS and Windows are trademarks of their
respective owners; this project is not affiliated with or endorsed by them.
