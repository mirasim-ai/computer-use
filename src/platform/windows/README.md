# Native Windows apps

Not part of the release. The driver here and its helper (`uia/`, Rust) stay in the tree, and the
two `@mirasim/computer-use-win32-<arch>` packages are still built and published, but README,
docs/embedding.md, the agent skill, the command-line help and the tool descriptions say nothing
of Windows apps, and a session that names the platform is refused:

```
the "windows" platform (native Windows apps) is not part of this release
```

The browser and Electron platforms on Windows do not go through this driver or its helper.

## Opting in

A host that ships the driver at its own risk sets `COMPUTER_USE_UNSUPPORTED_WINDOWS=1` in the
server's environment (`registry.ts`, `windowsAppsOptedIn`). With it:

- `COMPUTER_USE_PLATFORMS` accepts `windows`, alone or in a comma-separated list;
- the tool description, the API reference and the `platform` / `interaction` parameters name
  Windows apps again, when the session mounts the platform;
- `mirasim-cu approvals` takes `--platform windows` and defaults to it on Windows.

Nothing else changes: this is the code as it was before the platform was withdrawn.

## What a host needs to know

This is what docs/embedding.md said of the platform; the rest of that document (the handshake,
the answers to a question, revoking) applies as it does to macOS.

| Variable | Meaning |
|---|---|
| `COMPUTER_USE_WINDOWS_APPROVALS` | where "always allow" answers are kept, by executable stem; default `<home>/windows-approvals.json`, `""` turns it off for a host that keeps its own list |
| `COMPUTER_USE_WINDOWS_UIA_BIN` | a prebuilt helper to run instead of the platform package's |
| `COMPUTER_USE_HOST_APPS` | also takes Windows program names: apps the agent runs inside, never listed, never driven |

- **Driving.** Apps are read and acted on through UI Automation. Starting an app that is not
  running needs `interaction: "desktop"` and is asked about before the app is started; one the
  user declines is not started.
- **Asking before an app.** `elicitation/create` carries
  `_meta["mirasim-computer-use/windowsApp"] = { app, title, launch?, purpose? }`: executable
  stem (`WINWORD`), window title. `launch: true` when the app is about to be started: `title`
  is then the name it is started by, and `app` its program when the Start menu says which one
  that is, else that name. Without `elicitation.form` every app is driven: whoever started the
  server is then the operator.
- **Store apps.** A Windows Store app is named by its own program (`CalculatorApp`,
  `SystemSettings`), never by `ApplicationFrameHost`, the process that frames all of their
  windows: nothing is asked about that name and no answer or stored approval of it clears
  anything. While a Store app's window does not say which app it is (for a moment as it starts,
  and while minimized) it cannot be bound.
- **Revoking.** `notifications/mirasim-computer-use/revoke` takes executable stems in `ids`.
- **The helper.** npm installs it prebuilt, as `@mirasim/computer-use-win32-<arch>` (x64,
  arm64). With `--omit=optional` the surface is unavailable until
  `COMPUTER_USE_WINDOWS_UIA_BIN` names one. A repository checkout builds it from `uia/` on
  first use (Rust's `cargo`) and caches it.

## Tests

`windows-approval` and `windows-opt-in` are in the `unit` group. `windows-live` drives real apps
on a Windows desktop and runs by hand only; it constructs the driver itself, so it needs no
switch.
