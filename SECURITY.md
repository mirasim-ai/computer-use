# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through GitHub's private vulnerability reporting: on this
repository's **Security** tab choose **Report a vulnerability**, or open
<https://github.com/mirasim-ai/computer-use/security/advisories/new>. The report is visible only
to you and the maintainers.

Please do not open a public issue or pull request for it, and do not describe it in one: both
are readable by everyone before a fix exists.

A report is easiest to act on when it says:

- the version (`npx -y @mirasim/computer-use --version`) and how it runs: the MCP server on its
  own, or built into the Mirasim desktop app;
- the surface (the managed browser, your own browser through the extension, macOS apps or
  Electron) and the operating system;
- the steps that reproduce it, and what someone could do with it.

We answer in the advisory itself, work on the fix there with you, and credit you in the
published advisory unless you ask us not to.

## Supported versions

Fixes are released in a new version of `@mirasim/computer-use` on npm. Earlier versions are not
patched, so check a report against the newest release first.

## What to report

Computer-use lets an agent operate a browser and, when you opt in, native apps. Anything that
lets it do more than you allowed is a vulnerability. For example:

- a web page or an app's content making computer-use act without the agent asking for it;
- the agent reaching a native app nobody allowed, or, in extension mode, a tab outside the ones
  you let it reach;
- a web page or another browser extension talking to the Mirasim extension's bridge;
- a published package (`@mirasim/computer-use` or one of its `@mirasim/computer-use-<platform>`
  helpers) that does not match this repository.

What the README documents is not a vulnerability: the agent's code runs with the access you gave
it, and a client that cannot ask for approval drives every app the agent names. A bug with no
security consequence belongs in the
[issue tracker](https://github.com/mirasim-ai/computer-use/issues).
