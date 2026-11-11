/**
 * `npm run build`: compile `src/` into `dist/`, the tree the published package runs.
 *
 * Starts from an empty `dist/`, so a file deleted from `src/` cannot linger in a tarball. The
 * published package carries no source: every emitted `.js` is minified in place (comments
 * dropped, locals renamed), and so is every script the browser driver runs inside a page; the
 * declarations lose their comments, and the native helpers' Swift and Rust sources stay
 * behind — the prebuilt helpers come from the platform packages.
 *
 * Minified file by file, not bundled: the layout `tsc` emits is what the runtime's own lookups
 * expect (`../../package.json` from `entries/`, the extension directory found by walking up).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { transformSync } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = (rel) => path.join(root, rel);
/** Slots in a page script that are filled in later: a `${…}` hole (as its stand-in), or a
 *  `__NAME__` marker the caller swaps for a value with String#replace. */
const SLOT = /__cuHole\d+__|__[A-Z][A-Z0-9_]*__/g;
const hole = (i) => `__cuHole${i}__`;

rmSync(at('dist'), { recursive: true, force: true });
// Through package.json: typescript's `exports` does not expose `bin/tsc`.
const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
execFileSync(process.execPath, [tsc, '-p', at('tsconfig.build.json')], { stdio: 'inherit' });

let pageScripts = 0;
for (const entry of readdirSync(at('dist'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  const file = path.join(entry.parentPath, entry.name);
  // No keepNames: it wraps functions in a `__name` helper that a function handed to
  // `page.evaluate` would carry into the page, where the helper does not exist.
  const { code } = transformSync(readFileSync(file, 'utf8'), {
    loader: 'js', format: 'esm', target: 'es2022', minify: true, legalComments: 'inline', sourcefile: entry.name,
  });
  const out = minifyPageScripts(code, path.relative(at('dist'), file));
  pageScripts += out.count;
  writeFileSync(file, out.code);
}
console.error(`build: dist/ minified, ${pageScripts} page scripts among it`);

/**
 * The scripts the browser driver runs inside the page are JS source held in strings
 * (`String.raw\`(el) => {…}\``), which minifying the module leaves as written. Each one is
 * minified on its own: its `${…}` holes become stand-in identifiers, the text is minified, and
 * the literal is re-emitted as a string concatenation. Anything this cannot do safely fails
 * the build rather than ship a script that may not run.
 */
function minifyPageScripts(code, name) {
  const found = [];
  walk(parse(code, { ecmaVersion: 'latest', sourceType: 'module' }), null, (node, parent) => {
    if (node.type === 'TaggedTemplateExpression' && isStringRaw(node.tag)) {
      found.push({ node, parts: node.quasi.quasis.map((q) => q.value.raw), holes: node.quasi.expressions });
      return false;
    }
    if (node.type === 'TemplateLiteral' && parent?.type !== 'TaggedTemplateExpression') {
      found.push({ node, parts: node.quasis.map((q) => q.value.cooked), holes: node.expressions });
    } else if (node.type === 'Literal' && typeof node.value === 'string') {
      found.push({ node, parts: [node.value], holes: [] });
    }
  });
  const edits = [];
  for (const { node, parts, holes } of found) {
    const text = parts.map((part, i) => (i ? hole(i - 1) : '') + part).join('');
    // Multi-line text that parses as JS: prose and one-line snippets never do both.
    if (!text.includes('\n') || !/^\s*(\(|function\b|async\b)/.test(text) || !parsesAsScript(text)) continue;
    let shipped;
    try {
      shipped = minifyScript(text);
    } catch (e) {
      throw new Error(`build: page script in ${name} (${text.trim().slice(0, 40)}…): ${e.message}`);
    }
    const pieces = [];
    let rest = shipped;
    for (let i = 0; i < holes.length; i++) {
      const [before, after] = rest.split(hole(i));
      pieces.push(JSON.stringify(before), `(${code.slice(holes[i].start, holes[i].end)})`);
      rest = after;
    }
    pieces.push(JSON.stringify(rest));
    edits.push({ start: node.start, end: node.end, text: `(${pieces.filter((p) => p !== '""').join('+') || '""'})` });
  }
  // A script inside another's hole is already carried, as written, by the outer edit.
  const outer = edits.filter((e) => !edits.some((o) => o !== e && o.start <= e.start && e.end <= o.end));
  let out = code;
  for (const e of outer.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { code: out, count: outer.length };
}

/**
 * One page script, minified. An expression comes back as `(expr)`; a declaration
 * (`function findMarked(…) {…}`) keeps its name, since top-level names are not renamed outside
 * a bundle. Slots are global identifiers to the minifier, so they keep their names too; it does
 * drop the parentheses it finds redundant around one (`(__PAGE_REFS__)()` → `__PAGE_REFS__()`),
 * so every slot read as code gets them back. A slot inside a string stays as it is.
 */
function minifyScript(text) {
  const asExpression = parsesAs(`(${text}\n)`);
  const input = asExpression ? `__cuOut__=(${text}\n);` : text;
  const inUses = slotUses(input);
  // What fills a slot may name the script's own locals (`unreachedJs("root")` reads the tree
  // walk's `root`), so a script with slots keeps every name and every statement: only its
  // whitespace and comments go. One without slots is minified in full.
  const keepNames = inUses.counts.size > 0;
  const options = keepNames ? { minifyWhitespace: true } : { minify: true };
  let out = transformSync(input, { loader: 'js', target: 'es2022', legalComments: 'none', ...options }).code.trim();
  if (keepNames) {
    const lost = [...declaredNames(input)].filter((n) => !declaredNames(out).has(n));
    if (lost.length) throw new Error(`minifying dropped declared names: ${lost.join(', ')}`);
  }
  // A function expression's own name is its `.name` as the page sees it (`window.x = function
  // x() {}` has no other): renaming it is fine, dropping it is not.
  if (namedFunctionExpressions(out) !== namedFunctionExpressions(input)) throw new Error('minifying dropped a function expression\'s name');
  if (asExpression) {
    if (!out.startsWith('__cuOut__=') || !out.endsWith(';')) throw new Error(`unexpected minifier output ${out.slice(0, 60)}`);
    out = `(${out.slice('__cuOut__='.length, -1)})`;
  } else if (out.endsWith(';')) {
    out = out.slice(0, -1);
  }
  const outUses = slotUses(out);
  for (const id of new Set([...inUses.counts.keys(), ...outUses.counts.keys()])) {
    const a = inUses.counts.get(id), b = outUses.counts.get(id);
    if (a?.code !== b?.code || a?.text !== b?.text) throw new Error(`slot ${id} changed in minifying`);
  }
  let shipped = out;
  for (const at of outUses.reads.sort((x, y) => y - x)) {
    const end = at + shipped.slice(at).match(/^[\w$]+/)[0].length;
    shipped = `${shipped.slice(0, at)}(${shipped.slice(at, end)})${shipped.slice(end)}`;
  }
  const stub = (form) => form.replace(SLOT, '0');
  if (!parsesAsScript(stub(shipped))) throw new Error('no longer parses after minifying');
  // String#replace reads `$&`, `$'`, `` $` ``, `$$`, `$1` and `$<` in a replacement: a minified
  // name `$` beside one of those would splice the wrong text into the script that embeds it.
  if (/\$[$&`'\d<]/.test(shipped) && !/\$[$&`'\d<]/.test(text)) throw new Error('minified text holds a String#replace pattern');
  for (let i = 0; text.includes(hole(i)); i++) {
    if (shipped.split(hole(i)).length !== 2) throw new Error(`${hole(i)} is not in the output exactly once`);
  }
  return shipped;
}

/** Where each slot appears: how often in all (`text`), how often as code (`code`), and the
 *  offsets of the code reads. A slot used as a name (a declaration, a property, a parameter)
 *  is refused: parentheses cannot go around it. So is a slot that is a statement by itself:
 *  what fills it may be statements, which the parentheses would turn into a syntax error. */
function slotUses(source) {
  const program = parse(source.startsWith('(') ? `${source}\n` : source, { ecmaVersion: 'latest' });
  const counts = new Map();
  const reads = [];
  for (const id of new Set(source.match(SLOT) ?? [])) counts.set(id, { text: source.split(id).length - 1, code: 0 });
  walk(program, null, (node, parent, key) => {
    if (node.type !== 'Identifier' || !counts.has(node.name)) return;
    const named = /Declaration|Declarator|Function|Class|Property|MethodDefinition|Label|Import|Export|Pattern/.test(parent?.type ?? '')
      && !(parent.type === 'VariableDeclarator' && key === 'init')
      && !(parent.type === 'Property' && key === 'value' && !parent.shorthand)
      && !(/Function/.test(parent.type) && key === 'body')
      && !(parent.type === 'AssignmentPattern' && key === 'right');
    if (named || (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed)) {
      throw new Error(`slot ${node.name} is used as a name, not a value`);
    }
    if (parent?.type === 'ExpressionStatement') {
      throw new Error(`slot ${node.name} is a statement by itself: build that string from pieces, not as one template`);
    }
    counts.get(node.name).code++;
    reads.push(node.start);
  });
  return { counts, reads };
}

function namedFunctionExpressions(source) {
  let count = 0;
  walk(parse(source, { ecmaVersion: 'latest' }), null, (node) => { if (node.type === 'FunctionExpression' && node.id) count++; });
  return count;
}

/** Every name the script binds: variables, functions, classes, parameters. */
function declaredNames(source) {
  const names = new Set();
  const bind = (pattern) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') names.add(pattern.name);
    else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties) bind(p.type === 'RestElement' ? p.argument : p.value);
    else if (pattern.type === 'ArrayPattern') for (const p of pattern.elements) bind(p);
    else if (pattern.type === 'RestElement') bind(pattern.argument);
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left);
  };
  walk(parse(source, { ecmaVersion: 'latest' }), null, (node) => {
    if (node.type === 'VariableDeclarator') bind(node.id);
    else if (/Function|Class/.test(node.type)) { bind(node.id); for (const p of node.params ?? []) bind(p); }
    else if (node.type === 'CatchClause') bind(node.param);
  });
  return names;
}

function isStringRaw(tag) {
  return tag.type === 'MemberExpression' && !tag.computed && tag.object.name === 'String' && tag.property.name === 'raw';
}

function parsesAs(text) {
  try { parse(text, { ecmaVersion: 'latest' }); return true; } catch { return false; }
}

function parsesAsScript(text) {
  return parsesAs(`(${text}\n)`) || parsesAs(text);
}

/** Depth-first over an acorn tree; the visitor returns false to skip a node's children. */
function walk(node, parent, visit, key) {
  if (visit(node, parent, key) === false) return;
  for (const [k, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, node, visit, k);
    } else if (value && typeof value.type === 'string') {
      walk(value, node, visit, k);
    }
  }
}
