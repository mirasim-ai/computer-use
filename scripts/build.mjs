/**
 * `npm run build`: compile `src/` into `dist/`, the tree the published package runs.
 *
 * Starts from an empty `dist/`, so a file deleted from `src/` cannot linger in a tarball. The
 * published package carries no source: every emitted `.js` is minified in place (comments
 * dropped, locals renamed), the declarations lose their comments, and the native helpers'
 * Swift and Rust sources stay behind — the prebuilt helpers come from the platform packages.
 *
 * Minified file by file, not bundled: the layout `tsc` emits is what the runtime's own lookups
 * expect (`../../package.json` from `entries/`, the extension directory found by walking up).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = (rel) => path.join(root, rel);

rmSync(at('dist'), { recursive: true, force: true });
// Through package.json: typescript's `exports` does not expose `bin/tsc`.
const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
execFileSync(process.execPath, [tsc, '-p', at('tsconfig.build.json')], { stdio: 'inherit' });

for (const entry of readdirSync(at('dist'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  const file = path.join(entry.parentPath, entry.name);
  // No keepNames: it wraps functions in a `__name` helper that a function handed to
  // `page.evaluate` would carry into the page, where the helper does not exist.
  const { code } = transformSync(readFileSync(file, 'utf8'), {
    loader: 'js', format: 'esm', target: 'es2022', minify: true, legalComments: 'inline', sourcefile: entry.name,
  });
  writeFileSync(file, code);
}
