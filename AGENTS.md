# AGENTS.md

`@mirasim/computer-use`: an MCP server (and Node library) that drives browsers, macOS apps,
Windows apps and Electron apps through their accessibility trees. README covers what it does;
[docs/embedding.md](docs/embedding.md) covers how a host drives it and every `COMPUTER_USE_*`
variable; [docs/releasing.md](docs/releasing.md) covers publishing.

## Setup

- Develop on the Node version in `.nvmrc` (24.19.0). `engines` only sets the floor users need
  (`>=22.19.0`); don't raise it without a reason.
- `npm ci`, then `npm run dev -- <args>` runs the CLI from source (`src/entries/cli.ts`).

## Tests

| Command | Runs | Where |
|---|---|---|
| `npm test` | typecheck + the `unit` group (no browser, no desktop) | CI on every push and PR |
| `npm run test:browser` | the `browser` group against a throwaway headless Chrome | before every publish |
| `npm run test:all` | unit + browser + managed-Chrome and extension suites | by hand |
| `node scripts/test.mjs macos-live` / `windows-live` / `electron-live` | real apps on this desktop | by hand only |

- A new suite `test/<name>.ts` runs nowhere until it is added to `GROUPS` in
  `scripts/test.mjs`. Put it in `unit` if it needs no browser, else `browser`.
- The live suites are in no group and not in CI. A change under `src/platform/macos`,
  `src/platform/windows` or `src/platform/electron` needs the matching live suite run on a
  real desktop; say so in the commit if you could not run it.
- `node scripts/test.mjs <name>...` runs single suites while iterating.

## Code

- No linter or formatter is configured; match the surrounding file. In `src/`: 2-space indent,
  double quotes, semicolons.
- Comments and docs are in English. Non-English text appears only as data or examples
  (localized app names such as `文本编辑`).
- A Rust crate linked into the Windows helper must be listed in `THIRD_PARTY_NOTICES`; the
  platform-package build fails otherwise.

## Commits

- Conventional Commits subject: `type(scope): description`, English, lowercase, no trailing
  period. Types in use: `fix`, `docs` (plus `feat`, `refactor`, `test`, `chore`, `ci` as
  needed). Scope is the platform or area when there is one: `macos`, `windows`, `browser`,
  `electron`.
- The description states the behaviour after the change, not the edit:
  `fix(macos): bind a quit app by its name, not only its bundle id`.
- Always write a body: what was wrong (or missing) before, then what happens now. Wrap at
  about 90 columns.
- One change per commit.

## Branches and releases

- `main` takes direct pushes; force-pushing and deleting it are blocked by a ruleset.
- A release is a pushed `v<version>` tag matching `package.json` (see docs/releasing.md).
  `v*` tags cannot be deleted or moved; a wrong tag means disabling the `protect-release-tags`
  ruleset (Settings → Rules) first, so check the version before pushing the tag.
