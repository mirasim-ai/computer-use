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

Before anything is published, the `store-minimum` job checks that the Chrome Web Store already
serves the oldest extension this release accepts (`MINIMUM_EXTENSION_VERSION`); see "Chrome Web
Store" below. After npm has the release, the `web-store` job (`.github/workflows/web-store.yml`) packs
`extension/` with `scripts/extension.mjs` and, when `extension/manifest.json` carries a version
newer than the one the Chrome Web Store serves and the one in review, uploads it to the store item
and submits it for review (`scripts/web-store.mjs`); an approved version goes live at once. A
release whose manifest version the store already has uploads nothing. See "Chrome Web Store" below.

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

## Chrome Web Store

The extension reaches users only from the store (item `khflooofmndpmafhofjdcpjfgnlpikhg`): Chrome
updates them from there, never from the copy in this package. Two versions are in play:

- `extension/manifest.json`'s version is what this package bundles and what a release submits to
  the store. Raise it to ship extension changes: the `web-store` job submits it, and users get it
  once the store approves it, hours to days later.
- `MINIMUM_EXTENSION_VERSION` (`src/platform/browser/bridge/extension-updates.ts`) is the oldest
  extension the bridge accepts; older ones read `update-required` and their browser tasks are held
  back. Raise it only when the bridge needs something older extensions lack, and only once the
  store serves that version: the `store-minimum` job refuses to publish a release whose minimum the
  store does not serve yet. It asks the store's public update check, the one Chrome polls, so it
  needs no credentials; `skip_store_check` on a manual run publishes anyway.

Until 0.1.1-rc.15 the bridge took the manifest's version as the minimum, so rc.14 and rc.15 asked
every user for a 0.1.5 the store did not serve yet. To give the store a version without raising the
manifest, run `chrome web store` from the Actions tab with `version` set and `dry_run` unticked: it
packs the current `extension/` under that number.

What the job does, in order: pack (the receipt names version, build fingerprint and ZIP SHA-256,
and the ZIP is kept as the run's `web-store-package` artifact); read the item's status; skip when
the store already serves or has submitted this version or a newer one; stop with an error when
another version is in review or approved and waiting to be published, which a person settles in the
Developer Dashboard (wait, publish, or cancel the review); otherwise upload, then publish, which
submits it for review. `staged` asks the store to hold an approved version until someone publishes
it from the Developer Dashboard. Review takes from hours to days; the dashboard shows where it is.
The API cannot create an item or change its listing, visibility or permissions justifications:
those stay in the dashboard.

Locally: `node scripts/web-store.mjs --dry-run` packs and, with the variables below set, reads the
store.

### Credentials

The job reads them from the `chrome-web-store` environment (Settings → Environments), so no other
job sees them:

| Name | Kind | What |
|---|---|---|
| `CWS_CLIENT_ID` | secret | OAuth client ID |
| `CWS_CLIENT_SECRET` | secret | OAuth client secret |
| `CWS_REFRESH_TOKEN` | secret | refresh token issued to the Google account that owns the item |
| `CWS_PUBLISHER_ID` | variable | Developer Dashboard → Publisher → Settings |

The item ID is in the workflow (`CWS_ITEM_ID`); the script refuses to upload when the manifest's
`key` names another extension. Until all four are set a release skips the job with a warning; with
only some set it fails and names what is missing.

Getting them takes the Google account that owns the item, once (it needs 2-Step Verification on):

1. In Google Cloud console, create a project (or pick one) and enable the **Chrome Web Store API**.
2. OAuth consent screen: user type **Internal** if the account and the project belong to the same
   Google Workspace organization; otherwise **External**, with the account added as a test user and the app then
   moved to **In production**. An app left in "Testing" has its refresh tokens expire after 7 days,
   and the job then fails with `invalid_grant`. Google may leave the app unverified for this
   scope; that does not stop the API.
3. Credentials → Create credentials → OAuth client ID, type **Web application**, authorized
   redirect URI `https://developers.google.com/oauthplayground`. Keep the client ID and secret.
4. At https://developers.google.com/oauthplayground: the gear → "Use your own OAuth credentials"
   with that client; authorize the scope `https://www.googleapis.com/auth/chromewebstore` signed in
   as the item's owner; "Exchange authorization code for tokens". Keep the refresh token.
5. Developer Dashboard (https://chrome.google.com/webstore/devconsole/) → Publisher → Settings:
   copy the publisher ID.
6. Put the four values in the `chrome-web-store` environment, then run `chrome web store` by hand
   with `dry_run` ticked: it should report the version the store serves.

A refresh token stops working when its access is removed at myaccount.google.com/permissions or
after six months unused; repeat step 4 then.

The API also takes a service account added in the Developer Dashboard (one per publisher), which
spares the personal refresh token; this job does not use one yet.

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
