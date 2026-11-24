/**
 * Uploading the extension to the Chrome Web Store — `node scripts/test.mjs web-store`.
 *
 * Every release tag runs scripts/web-store.mjs, and most carry no new extension: it must upload
 * only a version newer than both the one the store serves and the one in review, stop when a person
 * has to settle a review first, and send the store the very ZIP scripts/extension.mjs packs, to the
 * one item the manifest's key names.
 *
 * Hermetic: the script against a fake Google (no network), packing into scratch directories.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Action = "submit" | "skip" | "refuse";
interface StoreState { published: string | null; submitted: { state: string; version: string | null } | null; takenDown: boolean }
interface Receipt { file: string; version: string; build: string; extensionId: string; sha256: string }
interface Result { action: Action | "packed" | "submitted"; reason: string; state?: string | null; dryRun?: boolean; receipt: Receipt }
type FakeFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) => Promise<Response>;
interface WebStore {
  decide(version: string, store: StoreState): { action: Action; reason: string };
  storeState(status: unknown): StoreState;
  release(options: { version: string; out: string; staged?: boolean; dryRun?: boolean; env: Record<string, string>;
    fetch: FakeFetch; log?: (line: string) => void; pollInterval?: number; pollLimit?: number }): Promise<Result>;
}
// A plain .mjs with no declarations: imported by URL, typed here.
const webStore = (await import(new URL("../scripts/web-store.mjs", import.meta.url).href)) as WebStore;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function rejects(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

const ITEM = "khflooofmndpmafhofjdcpjfgnlpikhg";
const NAME = `https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/${ITEM}`;
const env = { CWS_CLIENT_ID: "client-1", CWS_CLIENT_SECRET: "client-secret-1", CWS_REFRESH_TOKEN: "refresh-secret-1", CWS_PUBLISHER_ID: "pub-1", CWS_ITEM_ID: ITEM };

const revision = (state: string, ...versions: string[]) => ({ state, distributionChannels: versions.map((crxVersion) => ({ deployPercentage: 100, crxVersion })) });
const status = (published: string | null, submitted?: [string, string]) => ({
  name: `publishers/pub-1/items/${ITEM}`, itemId: ITEM,
  ...(published ? { publishedItemRevisionStatus: revision("PUBLISHED", published) } : {}),
  ...(submitted ? { submittedItemRevisionStatus: revision(submitted[0], submitted[1]) } : {}),
});
const store = (published: string | null, submitted?: [string, string]) => webStore.storeState(status(published, submitted));

// ── What to do, from the store's state alone ──
const cases: Array<[string, string, StoreState, Action]> = [
  ["a newer version than the store serves is submitted", "0.1.5", store("0.1.4"), "submit"],
  ["the version the store serves is nothing to do", "0.1.5", store("0.1.5"), "skip"],
  ["an older version than the store serves is nothing to do", "0.1.5", store("0.1.6"), "skip"],
  ["the version already in review is nothing to do", "0.1.5", store("0.1.4", ["PENDING_REVIEW", "0.1.5"]), "skip"],
  ["a newer version while another is in review waits for a person", "0.1.6", store("0.1.4", ["PENDING_REVIEW", "0.1.5"]), "refuse"],
  ["a newer version while another waits to be published waits for a person", "0.1.6", store("0.1.4", ["STAGED", "0.1.5"]), "refuse"],
  ["a rejected version may be submitted again", "0.1.5", store("0.1.4", ["REJECTED", "0.1.5"]), "submit"],
  ["after a cancelled review the version is submitted", "0.1.5", store("0.1.4", ["CANCELLED", "0.1.5"]), "submit"],
  ["an item never published takes its first version", "0.1.0", store(null), "submit"],
  ["versions compare by number: 0.1.10 is newer than 0.1.9", "0.1.10", store("0.1.9"), "submit"],
  ["versions compare by number: 0.1.9 is older than 0.1.10", "0.1.9", store("0.1.10"), "skip"],
  ["a taken-down item waits for a person", "0.1.5", { ...store("0.1.4"), takenDown: true }, "refuse"],
];
for (const [label, version, state, expected] of cases) {
  const d = webStore.decide(version, state);
  check(label, d.action === expected, `${d.action}: ${d.reason}`);
}
const rollout = webStore.storeState({ publishedItemRevisionStatus: { state: "PUBLISHED",
  distributionChannels: [{ deployPercentage: 100, crxVersion: "0.1.4" }, { deployPercentage: 10, crxVersion: "0.1.5" }] } });
check("during a partial rollout the store serves its newest version", rollout.published === "0.1.5", JSON.stringify(rollout));

// ── Against a fake Google ──
interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }
function fakeGoogle(before: object, replies: { upload?: [number, object]; afterUpload?: object; token?: [number, object]; publish?: object } = {}) {
  const calls: Call[] = [];
  let uploaded = false;
  const fetch: FakeFetch = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    const reply = ([code, body]: [number, object]) => new Response(JSON.stringify(body), { status: code });
    if (url === "https://oauth2.googleapis.com/token") return reply(replies.token ?? [200, { access_token: "access-1", expires_in: 3600 }]);
    if (url === `${NAME}:fetchStatus`) return reply([200, uploaded && replies.afterUpload ? replies.afterUpload : before]);
    if (url === `https://chromewebstore.googleapis.com/upload/v2/publishers/pub-1/items/${ITEM}:upload`) {
      uploaded = true;
      return reply(replies.upload ?? [200, { itemId: ITEM, uploadState: "SUCCEEDED", crxVersion: "0.1.5" }]);
    }
    if (url === `${NAME}:publish`) return reply([200, replies.publish ?? { itemId: ITEM, state: "PENDING_REVIEW" }]);
    return reply([404, { error: { message: `no route ${url}` } }]);
  };
  return { calls, fetch, to: (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)) };
}

const scratch = mkdtempSync(path.join(tmpdir(), "web-store-test-"));
let n = 0;
const out = () => path.join(scratch, `out-${++n}`);
const quiet = () => {};

{
  const google = fakeGoogle(status("0.1.4"));
  const dir = out();
  const result = await webStore.release({ version: "0.1.5", out: dir, env, fetch: google.fetch, log: quiet });
  check("a newer version is uploaded and submitted", result.action === "submitted" && result.state === "PENDING_REVIEW", JSON.stringify(result));
  const [token] = google.to("/token");
  const form = new URLSearchParams(String(token?.body));
  check("the access token comes from the refresh token", form.get("grant_type") === "refresh_token"
    && form.get("refresh_token") === env.CWS_REFRESH_TOKEN && form.get("client_id") === env.CWS_CLIENT_ID);
  check("the store is called with that access token", google.calls.filter((c) => c.url.includes("chromewebstore"))
    .every((c) => c.headers.Authorization === "Bearer access-1"));
  const [upload] = google.to(":upload");
  const zip = readFileSync(path.join(dir, result.receipt.file));
  check("the upload is the packed ZIP, byte for byte", upload !== undefined && Buffer.compare(Buffer.from(upload.body as Uint8Array), zip) === 0
    && upload.headers["Content-Type"] === "application/zip");
  const text = zip.toString("latin1");
  check("the ZIP carries the version and no key", text.includes('"version": "0.1.5"') && !text.includes('"key"'));
  const [publish] = google.to(":publish");
  check("publishing goes live once approved", JSON.parse(String(publish?.body)).publishType === "DEFAULT_PUBLISH");
  check("the calls go token, status, upload, publish", google.calls.map((c) => c.url.replace(/.*[/:]/, "")).join(" ") === "token fetchStatus upload publish",
    google.calls.map((c) => c.url).join(" "));
}
{
  const google = fakeGoogle(status("0.1.4"));
  await webStore.release({ version: "0.1.5", out: out(), staged: true, env, fetch: google.fetch, log: quiet });
  check("staged asks the store to hold the approved version", JSON.parse(String(google.to(":publish")[0]?.body)).publishType === "STAGED_PUBLISH");
}
{
  const google = fakeGoogle(status("0.1.4"), { upload: [200, { itemId: ITEM, uploadState: "IN_PROGRESS" }], afterUpload: { ...status("0.1.4"), lastAsyncUploadState: "SUCCEEDED" } });
  const result = await webStore.release({ version: "0.1.5", out: out(), env, fetch: google.fetch, log: quiet, pollInterval: 0 });
  check("an upload still processing is waited for, then submitted", result.action === "submitted" && google.to(":publish").length === 1);
}
{
  const google = fakeGoogle(status("0.1.4"), { upload: [200, { itemId: ITEM, uploadState: "IN_PROGRESS" }], afterUpload: { ...status("0.1.4"), lastAsyncUploadState: "FAILED" } });
  const error = await rejects(() => webStore.release({ version: "0.1.5", out: out(), env, fetch: google.fetch, log: quiet, pollInterval: 0 }));
  check("an upload the store failed is not submitted", error !== null && google.to(":publish").length === 0, error ?? "");
}
{
  const google = fakeGoogle(status("0.1.4"), { upload: [200, { itemId: ITEM, uploadState: "IN_PROGRESS" }] });
  const error = await rejects(() => webStore.release({ version: "0.1.5", out: out(), env, fetch: google.fetch, log: quiet, pollInterval: 0, pollLimit: 3 }));
  check("an upload that never finishes processing stops, unsubmitted", error?.includes("still processing") === true && google.to(":publish").length === 0, error ?? "");
}
{
  const google = fakeGoogle(status("0.1.4"), { upload: [400, { error: { code: 400, message: "Invalid version: must be greater than the published version" } }] });
  const error = await rejects(() => webStore.release({ version: "0.1.5", out: out(), env, fetch: google.fetch, log: quiet }));
  check("an upload the store refuses says why and is not submitted", error?.includes("must be greater") === true && google.to(":publish").length === 0, error ?? "");
}
{
  const google = fakeGoogle(status("0.1.4"), { upload: [200, { itemId: ITEM, uploadState: "SUCCEEDED", crxVersion: "0.1.4" }] });
  const error = await rejects(() => webStore.release({ version: "0.1.5", out: out(), env, fetch: google.fetch, log: quiet }));
  check("a package the store reads as another version is not submitted", error !== null && google.to(":publish").length === 0, error ?? "");
}
{
  const google = fakeGoogle(status("0.1.5"));
  const result = await webStore.release({ version: "0.1.5", out: out(), env, fetch: google.fetch, log: quiet });
  check("a release whose extension the store serves uploads nothing", result.action === "skip" && google.to(":upload").length === 0 && google.to(":publish").length === 0);
}
{
  const google = fakeGoogle(status("0.1.4", ["PENDING_REVIEW", "0.1.5"]));
  const error = await rejects(() => webStore.release({ version: "0.1.6", out: out(), env, fetch: google.fetch, log: quiet }));
  check("a newer version while another is in review stops before uploading", error?.includes("in review") === true && google.to(":upload").length === 0, error ?? "");
}
{
  const google = fakeGoogle(status("0.1.4"));
  const result = await webStore.release({ version: "0.1.5", out: out(), dryRun: true, env, fetch: google.fetch, log: quiet });
  check("a dry run reads the store and uploads nothing", result.action === "submit" && result.dryRun === true
    && google.to(":fetchStatus").length === 1 && google.to(":upload").length === 0 && google.to(":publish").length === 0);
}
{
  const google = fakeGoogle(status("0.1.4"));
  const result = await webStore.release({ version: "0.1.5", out: out(), dryRun: true, env: {}, fetch: google.fetch, log: quiet });
  check("a dry run without credentials packs and calls nobody", result.action === "packed" && google.calls.length === 0);
  const error = await rejects(() => webStore.release({ version: "0.1.5", out: out(), env: { CWS_CLIENT_ID: "client-1" }, fetch: google.fetch, log: quiet }));
  check("a real run with credentials missing names them and calls nobody",
    error?.includes("CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_PUBLISHER_ID") === true && google.calls.length === 0, error ?? "");
}
{
  const google = fakeGoogle(status("0.1.4"));
  const error = await rejects(() => webStore.release({ version: "0.1.5", out: out(), env: { ...env, CWS_ITEM_ID: "abcdefghijklmnopabcdefghijklmnop" }, fetch: google.fetch, log: quiet }));
  check("an item ID other than the manifest's key stops before any call", error?.includes("another item") === true && google.calls.length === 0, error ?? "");
}
{
  const google = fakeGoogle(status("0.1.4"), { token: [400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }] });
  const error = await rejects(() => webStore.release({ version: "0.1.5", out: out(), env, fetch: google.fetch, log: quiet }));
  check("an expired refresh token says to issue a new one", error?.includes("revoked or expired") === true && google.to(":fetchStatus").length === 0, error ?? "");
  check("...without repeating the secrets", !!error && !error.includes(env.CWS_REFRESH_TOKEN) && !error.includes(env.CWS_CLIENT_SECRET));
}

// ── The command line, as web-store.yml runs it: an empty --version means the manifest's ──
{
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(readFileSync(path.join(root, "extension", "manifest.json"), "utf8")) as { version: string };
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CWS_") && !k.startsWith("GITHUB_")));
  const dir = out();
  const run = spawnSync(process.execPath, ["scripts/web-store.mjs", "--version", "", "--out", dir, "--dry-run"], { cwd: root, env: clean, encoding: "utf8" });
  const receipt = run.status === 0 ? JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Receipt : null;
  check("a dry run with no version packs the manifest's version", receipt?.version === manifest.version && receipt.extensionId === ITEM,
    `exit ${run.status} ${run.stderr || run.stdout}`.trim());
  const real = spawnSync(process.execPath, ["scripts/web-store.mjs", "--out", out()], { cwd: root, env: clean, encoding: "utf8" });
  check("a real run without credentials fails", real.status === 1 && real.stdout.includes("missing CWS_CLIENT_ID"), `exit ${real.status} ${real.stdout}`.trim());
}

rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall web-store checks passed");
process.exit(failures ? 1 : 0);
