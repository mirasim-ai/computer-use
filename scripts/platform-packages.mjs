#!/usr/bin/env node
/**
 * The per-platform npm packages that carry the native helpers — the macOS accessibility helper
 * (Swift, `src/platform/macos/ax/`) and the Windows UI Automation helper (Rust,
 * `src/platform/windows/uia/`) — so an npm install drives native apps without a Swift or Rust
 * toolchain. The runtime finds them through `src/platform/platform-package.ts`.
 *
 *   node scripts/platform-packages.mjs build <target>... [--out <dir>] [--cache <dir>]
 *       compile each target's helper and write its package to `<dir>/<target>/` (default
 *       `dist-platform/`); a macOS target needs swiftc, a Windows one cargo on Windows. With
 *       `--cache`, a helper whose sources and toolchain are unchanged is copied from there
 *       instead of compiled (CI keeps that directory between runs)
 *   node scripts/platform-packages.mjs pin
 *       list every target as an optional dependency of this package, at this package's version
 *
 * `pin` runs at publish time only, on the CI checkout: until the platform packages exist on the
 * registry, a lockfile that names them would resolve a name anyone could register.
 *
 * Every package is versioned in lockstep with `@mirasim/computer-use` and pinned exactly, so a
 * helper always speaks the protocol of the client that spawns it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestFile = path.join(root, 'package.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));

const AX_HELPER = 'computer-use-ax-helper';
const UIA_HELPER = 'computer-use-uia-helper.exe';

/** `<process.platform>-<process.arch>` → what that package carries. */
const TARGETS = {
  'darwin-arm64': { helper: AX_HELPER, build: (out) => buildAx('arm64', out), inputs: axInputs },
  'darwin-x64': { helper: AX_HELPER, build: (out) => buildAx('x86_64', out), inputs: axInputs },
  'win32-x64': { helper: UIA_HELPER, build: (out) => buildUia('x86_64', out), inputs: uiaInputs, notices: ['THIRD_PARTY_NOTICES'] },
  'win32-arm64': { helper: UIA_HELPER, build: (out) => buildUia('aarch64', out), inputs: uiaInputs, notices: ['THIRD_PARTY_NOTICES'] },
};

/** Everything a helper binary is a function of: its source files and the compiler that read them. */
function axInputs() {
  const dir = path.join(root, 'src', 'platform', 'macos', 'ax');
  return { files: readdirSync(dir).filter((f) => f.endsWith('.swift')).map((f) => path.join(dir, f)), toolchain: execFileSync('swiftc', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
}
function uiaInputs() {
  const dir = path.join(root, 'src', 'platform', 'windows', 'uia');
  const src = path.join(dir, 'src');
  const files = [path.join(dir, 'Cargo.toml'), path.join(dir, 'Cargo.lock'), ...readdirSync(src).map((f) => path.join(src, f))];
  return { files, toolchain: execFileSync('rustc', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
}

/** The cache key of one target's helper: the target, its toolchain, and every input file's bytes. */
function helperKey(target, spec) {
  const { files, toolchain } = spec.inputs();
  const hash = createHash('sha256').update(target).update(toolchain);
  for (const file of files.sort()) hash.update(path.relative(root, file)).update(readFileSync(file));
  return hash.digest('hex').slice(0, 32);
}

const packageName = (target) => `${manifest.name}-${target}`;

/**
 * An explicit deployment target: left out, swiftc builds for the BUILD machine's macOS, and the
 * helper dies in dyld on every older Mac. 13.0 is also the lowest the x86_64 slice links at with
 * the current Command Line Tools (below it swiftc force-loads an arm64-only compatibility library).
 *
 * Signed ad hoc, which is all a binary npm puts on disk needs: npm does not quarantine downloads,
 * and macOS attributes the accessibility grant to the app that launched the agent, not to us.
 */
function buildAx(arch, out) {
  const dir = path.join(root, 'src', 'platform', 'macos', 'ax');
  const sources = readdirSync(dir).filter((f) => f.endsWith('.swift')).sort().map((f) => path.join(dir, f));
  execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macos13.0`, ...sources, '-o', out], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', out], { stdio: 'inherit' });
}

/**
 * The CRT is linked statically: a default MSVC build imports vcruntime140.dll, which a stock
 * Windows install is not guaranteed to have. A cross-arch build needs `rustup target add <triple>`
 * and the matching MSVC build tools.
 */
function buildUia(arch, out) {
  const dir = path.join(root, 'src', 'platform', 'windows', 'uia');
  const triple = `${arch}-pc-windows-msvc`;
  const targetDir = path.join(dir, 'target');
  assertNoticed(dir, triple);
  execFileSync(cargoBin(), ['build', '--release', '--locked', '--manifest-path', path.join(dir, 'Cargo.toml'), '--target', triple, '--target-dir', targetDir], {
    stdio: 'inherit',
    env: { ...process.env, RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} -C target-feature=+crt-static`.trim() },
  });
  copyFileSync(path.join(targetDir, triple, 'release', UIA_HELPER), out);
}

/**
 * Every crate linked into the helper is listed in THIRD_PARTY_NOTICES, at its locked version:
 * a Cargo.lock change that adds or bumps one fails here until the file catches up. Procedural
 * macros run only at compile time and are left out on both sides.
 */
function assertNoticed(dir, triple) {
  const tree = execFileSync(cargoBin(), ['tree', '--locked', '--manifest-path', path.join(dir, 'Cargo.toml'), '--target', triple, '-e', 'normal,no-proc-macro', '--prefix', 'none', '--format', '{p}'], { encoding: 'utf8' });
  const listed = new Set(readFileSync(path.join(root, 'THIRD_PARTY_NOTICES'), 'utf8').split('\n').map((line) => line.split(/\s+/).slice(0, 2).join(' ')));
  const linked = new Set(tree.split('\n').map((line) => /^(\S+) v(\S+)/.exec(line)).filter((m) => m && m[1] !== 'computer-use-uia-helper').map((m) => `${m[1]} ${m[2]}`));
  const missing = [...linked].filter((crate) => !listed.has(crate));
  if (missing.length) throw new Error(`THIRD_PARTY_NOTICES lacks ${missing.join(', ')} (linked into ${UIA_HELPER} for ${triple})`);
}

/** rustup puts cargo in ~/.cargo/bin and onto PATH only for shells started afterwards. */
function cargoBin() {
  const home = path.join(process.env.USERPROFILE ?? homedir(), '.cargo', 'bin', 'cargo.exe');
  return existsSync(home) ? home : 'cargo';
}

function build(targets, outRoot, cacheDir) {
  for (const target of targets) {
    const spec = TARGETS[target];
    if (!spec) throw new Error(`unknown target ${target} (known: ${Object.keys(TARGETS).join(', ')})`);
    const [os, cpu] = target.split('-');
    const dir = path.join(outRoot, target);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, spec.helper);
    const cached = cacheDir ? path.join(cacheDir, `${target}-${helperKey(target, spec)}`) : null;
    if (cached && existsSync(cached)) {
      if (spec.helper === UIA_HELPER) assertNoticed(path.join(root, 'src', 'platform', 'windows', 'uia'), `${target === 'win32-arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`);
      copyFileSync(cached, bin);
      console.log(`${target}: helper unchanged, taken from the cache`);
    } else {
      spec.build(bin);
      if (cached) {
        mkdirSync(cacheDir, { recursive: true });
        copyFileSync(bin, cached);
      }
    }
    chmodSync(bin, 0o755);
    const notices = ['NOTICE', ...(spec.notices ?? [])];
    for (const name of ['LICENSE', ...notices]) copyFileSync(path.join(root, name), path.join(dir, name));
    const pkg = {
      name: packageName(target),
      version: manifest.version,
      description: `The ${target} native helper for ${manifest.name}.`,
      license: manifest.license,
      repository: manifest.repository,
      os: [os],
      cpu: [cpu],
      files: [spec.helper, ...notices],
    };
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`${pkg.name}@${pkg.version}: ${spec.helper} ${(statSync(bin).size / 1024).toFixed(0)} KB → ${dir}`);
  }
}

function pin() {
  manifest.optionalDependencies = Object.fromEntries(Object.keys(TARGETS).map((t) => [packageName(t), manifest.version]));
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`optionalDependencies: ${Object.keys(manifest.optionalDependencies).join(', ')} @ ${manifest.version}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'build') {
  const outAt = rest.indexOf('--out');
  const outRoot = path.resolve(outAt >= 0 ? rest.splice(outAt, 2)[1] : path.join(root, 'dist-platform'));
  const cacheAt = rest.indexOf('--cache');
  const cacheDir = cacheAt >= 0 ? path.resolve(rest.splice(cacheAt, 2)[1]) : null;
  if (!rest.length) throw new Error('build: name at least one target');
  build(rest, outRoot, cacheDir);
} else if (command === 'pin') {
  pin();
} else {
  console.error('usage: platform-packages.mjs build <target>... [--out <dir>] [--cache <dir>] | pin');
  process.exit(2);
}
