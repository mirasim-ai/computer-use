/**
 * Every suite runs through here, in a scratch HOME made for the run and removed after it, so no
 * suite touches the machine it runs on: the state directory, the machine-wide ownership records
 * and download staging, a native-messaging host registration.
 *
 *   node scripts/test.mjs unit             the suites that need no browser and no desktop (`npm test`)
 *   node scripts/test.mjs browser          the suites against a throwaway headless Chrome (`npm run test:browser`)
 *   node scripts/test.mjs all              unit + browser + the managed-Chrome and extension suites (`npm run test:all`)
 *   node scripts/test.mjs <name>... [--]   named suites, `test/<name>.ts` (e.g. `repl macos-forms`)
 *   node scripts/test.mjs <file> [args]    one suite file, with its own arguments
 *
 * The live suites drive real apps on this desktop and are never in a group: `macos-live`,
 * `windows-live`, `electron-live`.
 *
 * The one thing a suite takes from the real home is Playwright's browser cache, where the extension
 * suite finds a Chromium that still loads extensions: its path is handed over as
 * PLAYWRIGHT_BROWSERS_PATH. Chrome itself is found by path (`COMPUTER_USE_CHROME`, test/helpers.ts).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GROUPS = {
  unit: [
    'blank-args', 'viewport-line', 'journal-drain', 'repl-guards',
    'macos-ui', 'macos-windows', 'macos-budgets', 'macos-targets', 'macos-elements', 'macos-marks',
    'macos-window-match', 'macos-grants', 'macos-diagnostics', 'macos-mouse', 'macos-app-notes', 'macos-forms', 'bridge-acquire',
    'ownership', 'setup-skill',
  ],
  browser: [
    'smoke', 'scroll-behaviors', 'forms-fill', 'select-text', 'paste', 'repl', 'settle-controlled',
    'ref-lifecycle', 'nesting', 'read-page-behaviors', 'readonly-refs', 'screenshot-scopes', 'tab-targeting',
    'named-tabs', 'attach-recovery', 'attached-profile', 'connection-recovery', 'browser-state', 'mcp-log',
    'excerpt-cuts', 'diagnostics', 'media-features', 'last-tab', 'find-why', 'page-opened-tabs', 'quick-misses',
  ],
};
GROUPS.all = [...GROUPS.unit, ...GROUPS.browser, 'managed-chrome', 'extension-bridge', 'extension-access'];

const root = fileURLToPath(new URL('../', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const [target, ...args] = process.argv.slice(2);
if (!target) {
  console.error(`usage: node scripts/test.mjs <${Object.keys(GROUPS).join('|')}|name...|file [args]>`);
  process.exit(2);
}
/** A group, one suite file with its arguments, or one or more suite names. */
function resolveSuites() {
  if (GROUPS[target]) return GROUPS[target].map((name) => [`test/${name}.ts`]);
  if (/\.[cm]?[jt]s$/.test(target)) return [[target, ...args]];
  return [target, ...args].map((name) => {
    const file = `test/${name}.ts`;
    if (!existsSync(path.join(root, file))) {
      console.error(`no suite ${name} (test/${name}.ts); groups: ${Object.keys(GROUPS).join(', ')}`);
      process.exit(2);
    }
    return [file];
  });
}
const suites = resolveSuites();

/** Where Playwright keeps its browsers on this platform, read before HOME moves. */
function playwrightCache() {
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'ms-playwright');
}

/** A scratch HOME for one run, and the environment every suite in it gets. */
function scratchEnv() {
  const home = mkdtempSync(path.join(tmpdir(), 'computer-use-test-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || playwrightCache() };
  // A state directory set in the caller's shell would be the real one again.
  delete env.COMPUTER_USE_HOME;
  return { home, env };
}
// A Chrome still flushing its profile can hold files for a moment.
const removeHome = (home) => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const seconds = (started) => ((Date.now() - started) / 1000).toFixed(1);

const failed = [];
if (target === 'unit') {
  // The unit suites drive stubs, never a browser or a desktop, so they run side by side, each in a
  // HOME of its own; their output is printed whole, one suite after another, as each finishes.
  const queue = [...suites];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [file, ...rest] = next;
      const { home, env } = scratchEnv();
      const started = Date.now();
      const child = spawn(process.execPath, [tsx, file, ...rest], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const out = [];
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => out.push(d));
      const status = await new Promise((resolve) => child.on('close', (code, signal) => resolve(signal ?? code)));
      removeHome(home);
      if (status !== 0) failed.push(`${file} (${typeof status === 'string' ? status : `exit ${status}`})`);
      process.stdout.write(`\n── ${file}\n${Buffer.concat(out).toString()}── ${file}: ${status === 0 ? 'ok' : 'FAILED'} in ${seconds(started)}s\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(availableParallelism(), suites.length) }, worker));
} else {
  // Browser suites run one at a time: each drives a real Chrome, and their settle timings assume
  // the machine is not busy with another one.
  const { home, env } = scratchEnv();
  try {
    for (const [file, ...rest] of suites) {
      if (suites.length > 1) console.log(`\n── ${file}`);
      const started = Date.now();
      const { status, signal } = spawnSync(process.execPath, [tsx, file, ...rest], { cwd: root, env, stdio: 'inherit' });
      if (status !== 0) failed.push(`${file} (${signal ?? `exit ${status}`})`);
      if (suites.length > 1) console.log(`── ${file}: ${status === 0 ? 'ok' : 'FAILED'} in ${seconds(started)}s`);
    }
  } finally {
    removeHome(home);
  }
}
if (suites.length > 1) console.log(failed.length ? `\n${failed.length} of ${suites.length} failed: ${failed.join(', ')}` : `\nall ${suites.length} passed`);
process.exit(failed.length ? 1 : 0);
