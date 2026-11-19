# Releasing

A release is a tag. Bump `version` in `package.json`, merge, then push `v<version>`:
`.github/workflows/publish.yml` runs the browser suites (`browser.yml`: the `browser` group and,
through the real extension, the `extension` group; it also runs by hand from the Actions tab, and
nothing is published unless both pass), builds the four native helpers (Swift on macOS, Rust on
Windows), publishes each as `@mirasim/computer-use-<platform>-<arch>`, then lists them as
exact-version optional dependencies of `@mirasim/computer-use` and publishes that last, so no
published version ever names a helper the registry lacks. The tag must match `package.json`,
or the workflow stops before publishing anything. A version with a prerelease part (`0.1.0-rc.1`) is
published to the `next` dist-tag, all five packages alike; a plain version goes to `latest`.

After bumping `version`, run `node scripts/sync-plugin.mjs`: it writes the version into the
Claude Code / Codex plugin in `plugins/mirasim-computer-use` (both manifests, and the exact npm
version its MCP server runs) and copies the agent skill there; the `plugin-manifests` unit test
fails until it has run.

Before bumping the version, read what the release changes against the three texts that describe
it to people and agents, and update the ones it makes wrong: the README with its translations
(README.zh-CN.md, README.ja.md, README.ko.md), docs/setup.md and docs/embedding.md, the agent
skill (`skills/mirasim-computer-use/SKILL.md`), and the Chinese user guide for Mirasim users
(chapter 19, "Computer Use", of the guide at mirasim.ai/guide, kept in the website's
repository). A change to the extension's panel, its toolbar icon or the tab verbs reaches all
three.

After npm has the release, the `mcp-registry` job lists it in the official MCP Registry
(registry.modelcontextprotocol.io) as `io.github.mirasim-ai/computer-use`: it copies the
version from `package.json` into `server.json` and publishes that with `mcp-publisher`, signed in
through GitHub OIDC. The registry accepts it only because the npm package names the server in
`mcpName`; keep `mcpName` and `server.json`'s `name` the same. The version written in
`server.json` itself does not matter, the job overwrites it. A manual run skips this job.

Running the workflow by hand is a dry run unless `dry_run` is unticked. npm versions are
immutable, so a re-run skips whatever the registry already has.

## Authentication and provenance

Every package publishes through npm trusted publishing (OIDC): each of the five names this
repository and `publish.yml` as its trusted publisher on npmjs.com, so the workflow holds no npm
token. This works while the repository is private. A trusted publisher added on npm starts out
pending and is validated by the next publish through it.

Provenance is attached only once the repository is public (`--provenance`): npm accepts it from
public repositories only. The workflow decides this per run from the repository's visibility;
nothing needs to change in it when the repository goes public.

## Checking a release locally

```sh
npm pack                                                # builds dist/ first (prepack)
node scripts/platform-packages.mjs build darwin-arm64   # → dist-platform/darwin-arm64/
```

Then `npm install` the tarball and that directory into an empty project and run
`npx @mirasim/computer-use mcp` there. A plain `npm pack` carries no helper, prebuilt or as
source: those are the platform packages, built by the release workflow, so without one the macOS
surface is unavailable.

The package ships `dist/` minified and no `src/` (`scripts/build.mjs`).

The two Windows packages are built and published although native Windows apps are not part of
the release: the Mirasim desktop app takes its helper from them
(`src/platform/windows/README.md`).
