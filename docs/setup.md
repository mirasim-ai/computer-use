# Setup

Everything the README's two install lines leave out: permissions in Claude Code and Codex, which
browser the agent drives, the agent skill, native apps, the command line and the call log. How a
host program drives computer-use, every `COMPUTER_USE_*` variable and the state directory are in
[embedding.md](embedding.md).

Needs Node.js 22.19 or later. The commands below run the server through `npx`; to have the
`mirasim-cu` command instead, install it once with `npm install -g @mirasim/computer-use`.

## Claude Code

```sh
claude mcp add mirasim-cu -- npx -y @mirasim/computer-use mcp
```

`claude mcp add` registers the server for the current project only; add `-s user` to have it in
every project. In an interactive session Claude Code's permission mode decides whether it asks
before a call, and when it asks you can allow the tool for that project from then on. A
non-interactive run (`claude -p`) cannot ask and refuses the call unless the server is allowed
ahead of time: `claude -p "…" --allowedTools mcp__mirasim-cu`, with the option after the prompt,
or `mcp__mirasim-cu` in `permissions.allow` of your settings.

## Codex

```sh
codex mcp add mirasim-cu -- npx -y @mirasim/computer-use mcp
```

That writes a `[mcp_servers.mirasim-cu]` table into `~/.codex/config.toml`. The command has no
option for tool approvals, so approve both tools in that file as a second step: Codex asks
before every MCP call by default, and when it is set never to ask (`approval_policy = "never"`)
a tool without `approval_mode = "approve"` is refused outright — `computer_repl_reset`
included, which is the call a stuck session reaches for. Append:

```toml
[mcp_servers.mirasim-cu.tools.computer_repl]
approval_mode = "approve"

[mcp_servers.mirasim-cu.tools.computer_repl_reset]
approval_mode = "approve"
```

`codex mcp add` under a name that is already registered rewrites the entry, and
`codex mcp remove` deletes it; both drop these two tables, so append them again afterwards.

## Browser

The browser works out of the box on macOS, Windows and Linux: computer-use drives a Chrome of
its own (installed Google Chrome is required), keeping its profile under
`~/.mirasim-computer-use` so logins carry over between sessions.

### Your own browser

To drive the browser you are signed into instead, install the
[Mirasim extension](https://chromewebstore.google.com/detail/mirasim/khflooofmndpmafhofjdcpjfgnlpikhg)
and add `-e COMPUTER_USE_BROWSER=extension` (`--env COMPUTER_USE_BROWSER=extension` with
`codex mcp add`, which has no `-e`):

```sh
claude mcp add mirasim-cu -e COMPUTER_USE_BROWSER=extension -- npx -y @mirasim/computer-use mcp
codex mcp add mirasim-cu --env COMPUTER_USE_BROWSER=extension -- npx -y @mirasim/computer-use mcp
```

By default the agent sees only the tabs it opens and the ones you hand it: click the
extension's toolbar icon on a tab to hand that tab over, and use its panel to take tabs back,
pause the agent, widen what it may reach or block sites. The icon is in colour on tabs the agent
may use and grey on the rest.

In extension mode the first browser call starts a bridge in the background and registers it as
the extension's native-messaging host: a record under `~/.mirasim-computer-use/native-host/`
and a manifest in each Chromium-family browser's configuration folder. The record names the
program that started it, which under `npx` is a path in npx's cache; a record whose program is
gone is skipped, and every bridge start writes it again.
`npx -y @mirasim/computer-use setup extension --remove` takes it back. The extension serves one
bridge at a time, and the Mirasim desktop app's comes first: while browser control is on there,
extension mode says so at once and does not connect.
Details in [embedding.md](embedding.md#your-own-browser-extension).

## Agent skill

The package ships a skill for the agent, `mirasim-computer-use`: the mistakes agents make most
with these tools (which browser, a tab it cannot see, the arguments of the tab verbs, what to do
with tabs afterwards, recovering a stuck session). Copy it into Claude Code's
(`~/.claude/skills`) and Codex's (`~/.agents/skills`) skill folders with

```sh
npx -y @mirasim/computer-use setup skill
```

and run it again after an upgrade; `--remove` takes it back. The Mirasim desktop app installs its
own copy.

## Native apps

Native apps are opt-in with `COMPUTER_USE_PLATFORMS` (comma-separated, default `browser`):

```sh
claude mcp add mirasim-cu -e COMPUTER_USE_PLATFORMS=browser,macos -- npx -y @mirasim/computer-use mcp
codex mcp add mirasim-cu --env COMPUTER_USE_PLATFORMS=browser,macos -- npx -y @mirasim/computer-use mcp
```

- `macos` drives native macOS apps through their accessibility tree in the background. Grant
  Accessibility (and Screen Recording, for screenshots) to the app that runs your agent;
  `npx -y @mirasim/computer-use setup macos` checks both.
- `electron` drives any app started with `--remote-debugging-port=<port>`
  (`COMPUTER_USE_ELECTRON_CDP_URL`, default `http://127.0.0.1:9333`).

The macOS driver uses a small native helper that npm installs prebuilt for arm64 and x64.

### Which apps the agent may drive

Before the agent first touches a native app — starting one that is not running included — the
server asks you through your agent's MCP client (MCP elicitation): allow it for this call, for
the session, or always. What that looks like depends on the client:

- A client that shows the question's form (Claude Code in a terminal, for one): you answer it
  there. The form has one field, "Allow for", set to "This session"; change it to "This call
  only" or "Always" before accepting.
- A client that shows the question as a bare accept / decline: a yes holds for that one call,
  and the next call asks again. Allow the app ahead of time (next item) to stop the questions.
- A non-interactive run (`claude -p`, CI) declines every question unseen, so an app nobody
  allowed is refused. Allow it ahead of time with
  `npx -y @mirasim/computer-use approvals add com.apple.TextEdit` (a macOS bundle id). The
  refusal names the exact command. `approvals` lists them; `approvals remove` revokes one.
- A client without elicitation support cannot ask, so the server drives **every** app the agent
  names. `-e COMPUTER_USE_MACOS_FALLBACK_APPS=com.apple.TextEdit,…` narrows that to the listed
  apps.

## Command line

The commands in this section are written as `mirasim-cu`, the command a global install
(`npm install -g @mirasim/computer-use`) puts on your PATH. Registering the server through `npx`
installs no such command: write `npx -y @mirasim/computer-use` in its place, as in
`npx -y @mirasim/computer-use setup macos`.

```sh
mirasim-cu mcp                   # MCP stdio server — the runtime
mirasim-cu browser open          # summon the managed browser for the user
mirasim-cu setup browser         # dependency bootstrap: verify a driveable Chrome exists
mirasim-cu setup macos           # check Accessibility + Screen Recording; open a missing pane
mirasim-cu approvals             # apps answered "always allow"; add / remove <app>
mirasim-cu setup skill           # copy the agent skill into Claude Code's and Codex's skill folders
```

To drive computer-use from another program — the spawn environment, the host protocol, the
opt-in live preview, the action journal, shared native capture — see
[embedding.md](embedding.md).

The host's agent calls `computer_repl` directly and reads the resulting observation in the current
session. The tool server runs no model of its own.

### The call log

`mirasim-cu mcp` serves the tools to a host that brings its own agent loop:

```sh
claude mcp add mirasim-cu -- mirasim-cu mcp
```

stdout is protocol-only, so the server records nothing by default — and the structured
`details` of each result (url / verdict / elementCount) never reaches the host at all.
`COMPUTER_USE_MCP_LOG` is the way to see it: one JSON line per call, plus a `server_start` line
naming the configuration.

```sh
COMPUTER_USE_MCP_LOG=~/.mirasim-computer-use/mcp.jsonl mirasim-cu mcp
# {"ts":"…","type":"server_start","version":"0.1.0","platforms":"browser","tools":[…]}
# {"ts":"…","type":"call","tool":"computer_repl","args":{"code":"await w.observe();"},"isError":false,"ms":412,
#  "details":{"url":"https://example.com","verdict":"changed","elementCount":7,"ledgerLines":2,
#   "timing":{"runMs":96,"observeMs":310,"steps":[{"kind":"observe","target":"","ok":true,"ms":96,"note":"7 elements"}]}}}
```

`details.timing` says where a `computer_repl` call's time went: each step of the code (reads,
waits and expects included) with its `ms`, the run in total (`runMs`), and the closing
observation apart (`observeMs`, the settle re-check included). The model's own journal carries
none of it. Failures are logged the same way (`isError: true`, with `details.error`), including a
tool name the host got wrong. Missing parent directories are created; a log that cannot be
written is dropped rather than failing the call.
