/**
 * The browser extension, packaged two ways from one identity and one readable file set:
 *
 * - `stageExtension(dir)` lays out the unpacked copy a host ships beside its bundle (imported by
 *   hosts that bundle computer-use);
 * - `node scripts/extension.mjs --version <v> --out <dir> [--public-key <pem>]` also writes the
 *   deterministic, uncompressed Chrome Web Store ZIP, with Node alone (including on Windows).
 */
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32 } from 'node:zlib';

export const extensionSource = fileURLToPath(new URL('../extension/', import.meta.url));
const files = ['background.js', 'group.js', 'relay.js', 'runtime-info.js', 'transport.js',
  'connect.html', 'connect.js', ...[16, 32, 48, 128].map((size) => `icons/icon-${size}.png`)];

export function extensionId(key) {
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
    .map((b) => 'abcdefghijklmnop'[b >> 4] + 'abcdefghijklmnop'[b & 15]).join('');
}

export function stageExtension(destination, options = {}) {
  const source = options.sourceDir ?? extensionSource;
  const manifest = JSON.parse(readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  manifest.version = options.version ?? manifest.version;
  if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(manifest.version)
    || manifest.version.split('.').some((n) => Number(n) > 65535)
    || !manifest.version.split('.').some(Number)) throw new Error('Extension version must contain 1–4 integers from 0 to 65535 and cannot be all zero.');
  if (manifest.description.length > 132) throw new Error('Extension description exceeds the Web Store 132-character limit.');
  const keyFile = options.publicKeyFile;
  if (keyFile) {
    const input = readFileSync(keyFile, 'utf8').trim();
    if (input.includes('PRIVATE KEY')) throw new Error('Provide the Web Store PUBLIC key, never a private key.');
    const key = input.includes('BEGIN PUBLIC KEY') ? createPublicKey(input)
      : createPublicKey({ key: Buffer.from(input.replace(/\s/g, ''), 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Expected an RSA public key from the Web Store Package tab.');
    manifest.key = key.export({ format: 'der', type: 'spki' }).toString('base64');
  }
  // Stable across machines and output paths. The loaded manifest identifies the running code,
  // even when an app update has already replaced the unpacked files on disk.
  delete manifest.version_name;
  const payload = files.map((name) => [name, readFileSync(path.join(source, name))]);
  const { key: _identity, ...behavior } = manifest;
  const hash = createHash('sha256').update(JSON.stringify(behavior));
  for (const [name, content] of payload) hash.update(name).update(content);
  manifest.version_name = `${manifest.version} (${hash.digest('hex').slice(0, 16)})`;
  payload.push(['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]);
  // The license and its notices travel with every copy of the code (Apache-2.0 §4). They are not
  // behavior, so they stay out of the fingerprint: changing them never reads as a new extension.
  for (const name of ['LICENSE', 'NOTICE']) payload.push([name, readFileSync(path.join(source, '..', name))]);
  for (const [name, content] of payload) {
    const target = path.join(destination, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { manifest, extensionId: extensionId(manifest.key), files: payload };
}

/** The Web Store ZIP and its receipt (the command line above). */
function packageForStore() {
  const { values } = parseArgs({ options: {
    version: { type: 'string' }, out: { type: 'string' }, 'public-key': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || !values.version || !values.out) {
    console.log('Usage: node scripts/extension.mjs --version 0.1.1 --out /path/to/new-output [--public-key /path/to/store-public-key.pem]');
    process.exit(values.help ? 0 : 1);
  }
  const out = path.resolve(values.out);
  if (existsSync(out)) throw new Error('Output already exists; choose a new directory so an earlier package is preserved.');
  const staged = stageExtension(path.join(out, 'extension'), { version: values.version, publicKeyFile: values['public-key'] });
  // The Web Store refuses an uploaded manifest that carries `key`: the store assigns the item's
  // identity itself. Only the ZIP drops it — the unpacked copy keeps it, so loading that locally
  // runs under the same ID, and the build fingerprint never covered `key` (stageExtension above).
  const { key: _identity, ...storeManifest } = staged.manifest;
  const zipFiles = staged.files.map(([name, content]) => name === 'manifest.json'
    ? [name, Buffer.from(`${JSON.stringify(storeManifest, null, 2)}\n`)] : [name, content]);
  const local = [], central = [];
  let offset = 0;
  for (const [name, content] of zipFiles.sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const filename = Buffer.from(name), checksum = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12); // fixed DOS date: 1980-01-01
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, content);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14); entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(content.length, 20); entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + content.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(zipFiles.length, 8); end.writeUInt16LE(zipFiles.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...local, directory, end]);
  const filename = `mirasim-browser-bridge-${staged.manifest.version}.zip`;
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, filename), zip);
  const receipt = { file: filename, version: staged.manifest.version, build: staged.manifest.version_name,
    extensionId: staged.extensionId, sha256: createHash('sha256').update(zip).digest('hex') };
  writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) packageForStore();
