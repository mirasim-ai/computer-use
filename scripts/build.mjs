/**
 * `npm run build`: compile `src/` into `dist/`, the tree the published package runs.
 *
 * Starts from an empty `dist/`, so a file deleted from `src/` cannot linger in a tarball. The
 * native helpers' sources are copied in beside their clients (`ax/`, `uia/`): an install whose
 * platform package is missing (`--omit=optional`, a target nobody prebuilt) still has the dev
 * build's compile-once fallback, the same one a checkout uses.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = (rel) => path.join(root, rel);

rmSync(at('dist'), { recursive: true, force: true });
// Through package.json: typescript's `exports` does not expose `bin/tsc`.
const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
execFileSync(process.execPath, [tsc, '-p', at('tsconfig.build.json')], { stdio: 'inherit' });

cpSync(at('src/platform/macos/ax'), at('dist/platform/macos/ax'), { recursive: true });
for (const rel of ['Cargo.toml', 'Cargo.lock', 'src']) {
  cpSync(at(`src/platform/windows/uia/${rel}`), at(`dist/platform/windows/uia/${rel}`), { recursive: true });
}
