# Releasing

A release is a tag. Bump `version` in `package.json`, merge, then push `v<version>`:
`.github/workflows/publish.yml` runs the browser suites (`browser.yml`, which also runs by hand from
the Actions tab; nothing is published unless they pass), builds the four native helpers (Swift on macOS, Rust on
Windows), publishes each as `@mirasim/computer-use-<platform>-<arch>`, then lists them as
exact-version optional dependencies of `@mirasim/computer-use` and publishes that last, so no
published version ever names a helper the registry lacks. The tag must match `package.json`,
or the workflow stops before publishing anything. A version with a prerelease part (`0.1.0-rc.1`) is
published to the `next` dist-tag, all five packages alike; a plain version goes to `latest`.

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
and Windows surfaces are unavailable.

The package ships `dist/` minified and no `src/` (`scripts/build.mjs`).
