/**
 * The bridge extension's identity: the Chrome Web Store item `khflooofmndpmafhofjdcpjfgnlpikhg`,
 * the only copy the bridge admits (the Origin check, the handshake's runtime ID check and the
 * native host's `allowed_origins`).
 *
 * extension/manifest.json carries the store item's public key as `key`, so a source load
 * (`--load-extension`, tests) gets the store ID too. The store refuses an uploaded manifest
 * that carries `key`; `scripts/extension.mjs` drops it from the Web Store ZIP.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function extensionManifest(): { key: string; version: string; version_name?: string } {
  return JSON.parse(readFileSync(join(extensionDir(), 'manifest.json'), 'utf8'));
}
/** Derived from extension/manifest.json's `key` — see {@link extensionIdFromKey}. */
export const MIRASIM_EXTENSION_ID = extensionIdFromKey(extensionManifest().key);

/** Chrome's ID scheme: SHA-256 of the SPKI DER, first 16 bytes, hex mapped a–p. */
export function extensionIdFromKey(manifestKeyBase64: string): string {
  const der = Buffer.from(manifestKeyBase64, "base64");
  const hash = createHash("sha256").update(der).digest();
  return [...hash.subarray(0, 16)].map((b) => "abcdefghijklmnop"[b >> 4]! + "abcdefghijklmnop"[b & 15]!).join("");
}

/** Where the unpacked extension lives: `<package root>/extension`, found by walking up, because
 *  the depth differs per shape (src via tsx and dist: 4 levels; a host's esbuild bundle: 2). */
export function extensionDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "extension");
    if (existsSync(join(candidate, "manifest.json"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("bridge extension directory not found beside the computer-use build (packaging bug)");
}
