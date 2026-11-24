/**
 * Uploads the browser extension to its Chrome Web Store item and submits it for review, through the
 * Chrome Web Store API v2 (V1.1 stopped being supported on 2026-10-15):
 *
 *   node scripts/web-store.mjs [--version <v>] [--out <new dir>] [--staged] [--dry-run]
 *
 * The package is `scripts/extension.mjs`'s ZIP of `extension/`, under the version in
 * `extension/manifest.json` unless `--version` names another (the same files under that number).
 *
 * Only a version above both the one the store serves and the one in review is uploaded. The same
 * version again is nothing to do: every release tag runs this, and most carry no new extension.
 * A newer version while another is still in review is refused, as the store would refuse it; a
 * person decides in the Developer Dashboard whether to wait or cancel that review.
 *
 * Without `--staged` an approved version goes live at once; with it, the store holds it until
 * someone publishes it from the Developer Dashboard. `--dry-run` packs and reads the store (when
 * credentials are set) and changes nothing there.
 *
 * `--check-minimum` uploads nothing: it fails when MINIMUM_EXTENSION_VERSION
 * (src/platform/browser/bridge/extension-updates.ts), the oldest extension the bridge accepts, is
 * newer than the version the store serves today, read from the store's public update check (what
 * Chrome itself polls; no credentials). The release workflow runs it before publishing to npm.
 *
 * Credentials, all from the environment (docs/releasing.md, "Chrome Web Store"):
 *   CWS_CLIENT_ID, CWS_CLIENT_SECRET   the OAuth client
 *   CWS_REFRESH_TOKEN                  issued to the Google account that owns the item
 *   CWS_PUBLISHER_ID                   Developer Dashboard → Publisher → Settings
 *   CWS_ITEM_ID                        the item; must be the ID the manifest's `key` gives
 */
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { extensionId, extensionSource, packageForStore } from './extension.mjs';

const API = 'https://chromewebstore.googleapis.com';
const UPDATE_CHECK = 'https://clients2.google.com/service/update2/crx';
const MINIMUM_SOURCE = fileURLToPath(new URL('../src/platform/browser/bridge/extension-updates.ts', import.meta.url));
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CREDENTIALS = ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID'];

export function compareVersions(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

const highest = (versions) => versions.reduce((top, v) => (top === null || compareVersions(v, top) > 0 ? v : top), null);
const versionsOf = (revision) => (revision?.distributionChannels ?? []).map((c) => c.crxVersion).filter(Boolean);

/** What `fetchStatus` says the store holds: the version it serves and the submission in flight. */
export function storeState(status) {
  const submitted = status.submittedItemRevisionStatus;
  return {
    published: highest(versionsOf(status.publishedItemRevisionStatus)),
    submitted: submitted ? { state: submitted.state, version: highest(versionsOf(submitted)) } : null,
    takenDown: status.takenDown === true,
  };
}

/** Whether to upload `version`: `submit`, `skip` (nothing to do) or `refuse` (a person must act first). */
export function decide(version, store) {
  if (store.takenDown) return { action: 'refuse', reason: 'the item is taken down; see the Developer Dashboard' };
  const inFlight = store.submitted && ['PENDING_REVIEW', 'STAGED'].includes(store.submitted.state) ? store.submitted : null;
  if (inFlight?.version && compareVersions(inFlight.version, version) >= 0) {
    return { action: 'skip', reason: `the store already has ${inFlight.version} submitted (${inFlight.state})` };
  }
  if (store.published && compareVersions(store.published, version) >= 0) {
    return { action: 'skip', reason: `the store already serves ${store.published}` };
  }
  if (inFlight) {
    const what = inFlight.state === 'STAGED' ? 'approved and waiting to be published' : 'in review';
    return { action: 'refuse', reason: `${inFlight.version ?? 'an earlier submission'} is ${what}; publish it or cancel the review in the Developer Dashboard, then run this again` };
  }
  return { action: 'submit', reason: `${version} is newer than the ${store.published ?? 'unpublished item'} the store serves` };
}

async function call(fetchImpl, method, url, { token, body, contentType } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (contentType) headers['Content-Type'] = contentType;
  const res = await fetchImpl(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { /* reported below */ }
  if (!res.ok || !json) {
    const detail = json?.error?.message ?? text.slice(0, 500);
    throw new Error(`Chrome Web Store ${method} ${new URL(url).pathname}: HTTP ${res.status} ${detail}`);
  }
  return json;
}

/** An access token for the API, from the refresh token. The refresh token never leaves this call. */
export async function accessToken({ clientId, clientSecret, refreshToken }, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (res.ok && json.access_token) return json.access_token;
  // invalid_grant: revoked, or expired (an OAuth app left in "Testing" loses its tokens after 7 days).
  const hint = json.error === 'invalid_grant' ? ' The refresh token was revoked or expired: issue a new one (docs/releasing.md, "Chrome Web Store").' : '';
  throw new Error(`Google refused the refresh token: HTTP ${res.status} ${json.error ?? ''} ${json.error_description ?? ''}`.trim() + hint);
}

function storeClient({ publisherId, itemId, token, fetchImpl }) {
  const name = `publishers/${encodeURIComponent(publisherId)}/items/${itemId}`;
  return {
    status: () => call(fetchImpl, 'GET', `${API}/v2/${name}:fetchStatus`, { token }),
    upload: (zip) => call(fetchImpl, 'POST', `${API}/upload/v2/${name}:upload`, { token, body: zip, contentType: 'application/zip' }),
    publish: (publishType) => call(fetchImpl, 'POST', `${API}/v2/${name}:publish`,
      { token, body: JSON.stringify({ publishType }), contentType: 'application/json' }),
  };
}

/**
 * Pack `version` into `out` (a new directory), read the store and, unless it already has that
 * version or a person must act first, upload the package and submit it for review.
 */
export async function release({ version, out, staged = false, dryRun = false, env = process.env,
  fetch: fetchImpl = globalThis.fetch, log = console.log, pollInterval = 5_000, pollLimit = 60 }) {
  const receipt = packageForStore({ version, out });
  const itemId = env.CWS_ITEM_ID || receipt.extensionId;
  if (itemId !== receipt.extensionId) {
    throw new Error(`CWS_ITEM_ID is ${itemId}, but the manifest's key makes the extension ${receipt.extensionId}; refusing to upload it to another item`);
  }
  log(`packed ${receipt.file} (${receipt.build}, sha256 ${receipt.sha256}) for item ${itemId}`);
  const missing = CREDENTIALS.filter((k) => !env[k]);
  if (missing.length === CREDENTIALS.length && dryRun) return { action: 'packed', reason: 'no credentials: the store was not read', receipt, itemId };
  if (missing.length) throw new Error(`missing ${missing.join(', ')} (docs/releasing.md, "Chrome Web Store")`);

  const token = await accessToken({ clientId: env.CWS_CLIENT_ID, clientSecret: env.CWS_CLIENT_SECRET, refreshToken: env.CWS_REFRESH_TOKEN }, fetchImpl);
  const store = storeClient({ publisherId: env.CWS_PUBLISHER_ID, itemId, token, fetchImpl });
  const before = storeState(await store.status());
  const decision = decide(receipt.version, before);
  log(`store: serves ${before.published ?? 'nothing'}, submitted ${before.submitted ? `${before.submitted.version ?? '?'} (${before.submitted.state})` : 'nothing'}: ${decision.action}, ${decision.reason}`);
  if (decision.action === 'refuse') throw new Error(decision.reason);
  if (decision.action === 'skip' || dryRun) return { ...decision, dryRun, receipt, itemId, store: before };

  let upload = await store.upload(readFileSync(path.join(out, receipt.file)));
  for (let polls = 0; ['IN_PROGRESS', 'NOT_FOUND'].includes(upload.uploadState); polls++) {
    if (polls >= pollLimit) throw new Error(`the store is still processing the upload of ${receipt.version}; check the Developer Dashboard before running this again`);
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    upload = { ...upload, uploadState: (await store.status()).lastAsyncUploadState ?? 'IN_PROGRESS' };
  }
  if (upload.uploadState !== 'SUCCEEDED') throw new Error(`the store did not take the package: ${JSON.stringify(upload)}`);
  if (upload.crxVersion && upload.crxVersion !== receipt.version) {
    throw new Error(`the store read version ${upload.crxVersion} from a package of ${receipt.version}`);
  }
  log(`uploaded ${receipt.version}`);
  const submitted = await store.publish(staged ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH');
  const warnings = (submitted.warningInfo?.warnings ?? []).map((w) => `${w.reason ?? ''} ${w.description ?? ''}`.trim());
  log(`submitted ${receipt.version}: ${submitted.state ?? 'no state returned'}${staged ? ', held for a manual publish once approved' : ', live once approved'}`);
  return { action: 'submitted', reason: decision.reason, state: submitted.state ?? null, staged, warnings, receipt, itemId, store: before };
}

/** The version the store offers Chrome for the item today: its public update check, the one browsers poll. */
export async function servedVersion(itemId, fetchImpl = globalThis.fetch) {
  const url = `${UPDATE_CHECK}?response=updatecheck&acceptformat=crx2,crx3&prodversion=131.0&x=${encodeURIComponent(`id=${itemId}&uc`)}`;
  const res = await fetchImpl(url, { method: 'GET', headers: {} });
  const text = await res.text();
  const check = /<updatecheck\b[^>]*>/.exec(text)?.[0] ?? '';
  const status = /\sstatus="([^"]*)"/.exec(check)?.[1] ?? /<app\b[^>]*\sstatus="([^"]*)"/.exec(text)?.[1] ?? null;
  const version = /\sversion="(\d+(?:\.\d+){0,3})"/.exec(check)?.[1];
  if (res.ok && status === 'ok' && version) return version;
  throw new Error(`the Chrome Web Store's update check named no version for ${itemId} (HTTP ${res.status}${status ? `, ${status}` : ''})`);
}

/** MINIMUM_EXTENSION_VERSION, read from its source (this script runs with Node alone, before any build). */
export function minimumVersion(source = readFileSync(MINIMUM_SOURCE, 'utf8')) {
  const found = /^export const MINIMUM_EXTENSION_VERSION = "(\d+(?:\.\d+){0,3})";$/m.exec(source);
  if (!found) throw new Error('MINIMUM_EXTENSION_VERSION = "<version>" not found in src/platform/browser/bridge/extension-updates.ts');
  return found[1];
}

/** Refuse when the bridge would ask users for an extension the store does not serve yet. */
export async function checkMinimum({ itemId, minimum = minimumVersion(), fetch: fetchImpl = globalThis.fetch }) {
  const served = await servedVersion(itemId, fetchImpl);
  if (compareVersions(minimum, served) > 0) {
    throw new Error(`this release asks users for extension ${minimum} (MINIMUM_EXTENSION_VERSION), but the Chrome Web Store serves ${served}: `
      + `wait until the store serves ${minimum}, or keep the minimum at ${served}`);
  }
  return { minimum, served };
}

function annotate(level, message) {
  console.log(process.env.GITHUB_ACTIONS === 'true' ? `::${level}::${message}` : `${level}: ${message}`);
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    version: { type: 'string' }, out: { type: 'string' }, staged: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    'check-minimum': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/web-store.mjs [--version 0.1.6] [--out /path/to/new-output] [--staged] [--dry-run]\n'
      + '       node scripts/web-store.mjs --check-minimum');
    process.exit(0);
  }
  const manifest = JSON.parse(readFileSync(path.join(extensionSource, 'manifest.json'), 'utf8'));
  if (values['check-minimum']) {
    try {
      const itemId = extensionId(manifest.key);
      if (process.env.CWS_ITEM_ID && process.env.CWS_ITEM_ID !== itemId) throw new Error(`CWS_ITEM_ID is ${process.env.CWS_ITEM_ID}, but the manifest's key makes the extension ${itemId}`);
      const { minimum, served } = await checkMinimum({ itemId });
      console.log(`the bridge asks for extension ${minimum} or newer; the Chrome Web Store serves ${served}`);
      summary([`### Chrome Web Store: the store serves ${served}`, '', `- this release asks users for extension ${minimum} or newer (MINIMUM_EXTENSION_VERSION)`]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      summary(['### Chrome Web Store: release refused', '', `- ${message}`]);
      annotate('error', `Chrome Web Store: ${message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  const version = values.version || manifest.version;
  const out = path.resolve(values.out ?? path.join(mkdtempSync(path.join(tmpdir(), 'web-store-')), 'package'));
  const dryRun = values['dry-run'] === true;
  try {
    const result = await release({ version, out, staged: values.staged === true, dryRun });
    const verb = result.action === 'submitted' ? `Submitted ${version} for review` : dryRun && result.action === 'submit' ? `Would submit ${version} (dry run)` : `Nothing uploaded`;
    summary([`### Chrome Web Store: ${verb}`, '', `- ${result.reason}`, `- package: \`${result.receipt.file}\`, build \`${result.receipt.build}\`, sha256 \`${result.receipt.sha256}\``,
      ...(result.state ? [`- review state: \`${result.state}\`${result.staged ? ', held for a manual publish once approved' : ', live once approved'}`] : []),
      ...(result.warnings ?? []).map((w) => `- warning: ${w}`)]);
    if (result.action === 'submitted') annotate('notice', `Chrome Web Store: submitted ${version} for review (${result.state}).`);
    if (result.store?.submitted?.state === 'STAGED') annotate('warning', `Chrome Web Store: ${result.store.submitted.version} is approved and waits to be published from the Developer Dashboard.`);
    for (const w of result.warnings ?? []) annotate('warning', `Chrome Web Store: ${w}`);
    console.log(`package: ${out}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    summary(['### Chrome Web Store: failed', '', `- ${message}`]);
    annotate('error', `Chrome Web Store: ${message}`);
    process.exit(1);
  }
}
