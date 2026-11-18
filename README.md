# Mirasim Computer Use

[![npm](https://img.shields.io/npm/v/@mirasim/computer-use)](https://www.npmjs.com/package/@mirasim/computer-use)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Benchmark: DevBrowse Bench on Hugging Face](https://img.shields.io/badge/benchmark-DevBrowse%20Bench-ffd21e?logo=huggingface)](https://huggingface.co/datasets/mirasim-ai/devbrowse-bench)

Open-source computer use for any agent, faster and more efficient than ChatGPT Computer Use on
[DevBrowse Bench v1](#benchmark): 26% less time, 45% fewer model requests and half the input
tokens (2026-11-06 and 2026-11-07).

An MCP server that lets the agent you already use (Claude Code, Codex, or any MCP host) operate
browsers, macOS apps and Electron apps. It runs no model of its own and needs no
API key. The [Mirasim](https://mirasim.ai) desktop app ships the same tools built in
(Settings → Computer Use).

Capable models plan several GUI steps at once, the way a person goes through a website they use
every day. So the agent writes a short script, one call runs the whole chain of steps, and every
step reports back exactly what happened: the model does not check the screen after each click.
The screen reads back as text, a numbered list of elements from the accessibility tree, and
pixels are used only when text is not enough.

## Benchmark

![DevBrowse Bench v1 core results: time −26%, model requests −45%, input tokens −50%, failed runs 4 : 8](docs/benchmark/devbrowse-v1.png)

[DevBrowse Bench](https://huggingface.co/datasets/mirasim-ai/devbrowse-bench) measures browser use in
development work: a coding agent changes a web app, then checks its own work in a browser. v1 has
60 tasks in three parts, the three panels of the figure. 51 are on Team Tasks, a simulated React +
Vite task manager written for the benchmark: 44 classic and extended tasks (features, bug fixes,
QA passes) and 7 interaction tasks ★, bugs where a control the user can see cannot be clicked. 9
are on real projects: merged bug fixes from the open-source repositories of Excalidraw, Lexical,
tldraw and react-admin.

Each task runs as a pair, both sides at the same time in Codex in the ChatGPT desktop app, with
the same model (`gpt-6.1-sol` at medium reasoning effort), the same prompt and the same starting
code. The only difference is the browser tool the agent is told to use: ChatGPT Computer Use (the
in-app browser of Codex), or Mirasim Computer Use 0.1.0-rc.5 as an MCP server. 200 runs per side,
on 2026-11-06 and 2026-11-07; time, model requests and tokens come from Codex's own session
record, and every run was graded by rule-based judges.

| | ChatGPT Computer Use | Mirasim Computer Use |
|---|---|---|
| Runs passed | 192 / 200 | 196 / 200 |

Over the 192 pairs where both sides passed (change = Mirasim total / ChatGPT total − 1, 95%
interval from resampling tasks):

| Metric | Change | 95% interval |
|---|---|---|
| Time | −26% | −32% to −20% |
| Model requests | −45% | −48% to −42% |
| Input tokens | −50% | −54% to −46% |
| Output tokens | −8% | −13% to −3% |
| Browser calls | −37% | −41% to −32% |

Most of the time was saved in round trips: the agent made 45% fewer model requests, while the
output tokens it wrote fell by only 8%. `observe()` returns elements as data, so the agent puts
its checks in the script and gets back a verdict instead of reading the page after every click.
And a click lands where a user's mouse would: a click on a covered control fails and names the
layer that took it. The four extra failures on the other side are all one interaction task ★, a
QA pass where a transparent layer under a sticky header covers a toolbar for mouse clicks: the
report written with ChatGPT Computer Use missed it in 4 of 5 runs, the one written with Mirasim
Computer Use in none.

These numbers describe the two tools as they were on those two days. Around the end of the runs,
ChatGPT Computer Use changed how it uses the browser and began to need fewer model requests per
run. When 39 of the 60 tasks were run again the same way on 2026-11-10 and 2026-11-11, with a
later release of Mirasim Computer Use, the time saving on them was about −16%, against −25% for
the same tasks here. That rerun is not part of v1.

Tasks, judges, every run and the full report are on Hugging Face, in the
[devbrowse-bench dataset](https://huggingface.co/datasets/mirasim-ai/devbrowse-bench)
([v1 report](https://huggingface.co/datasets/mirasim-ai/devbrowse-bench/blob/main/results/v1/REPORT.md)).

## Install

Needs Node.js 22.19 or later.

```sh
claude mcp add mirasim-cu -- npx -y @mirasim/computer-use mcp   # Claude Code
codex mcp add mirasim-cu -- npx -y @mirasim/computer-use mcp    # Codex
```

Then ask your agent to check something in the mirasim-cu browser. Codex asks before every MCP
call until you approve the two tools in `~/.codex/config.toml`; that, your signed-in Chrome,
macOS and Electron apps, the agent skill and the command line are in
[docs/setup.md](docs/setup.md).

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
