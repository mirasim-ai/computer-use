/**
 * Make a snippet's top-level declarations OUTLIVE the call that ran them.
 *
 * Each call runs as the body of an async function (for `await` and `return`), where `const tab`
 * would die with the function. As in Node's own REPL (`lib/internal/repl/await.js`), top-level
 * declarations become assignments and their names are hoisted as script-level `var`s, which live
 * on the context's global object.
 *
 * Only the program's TOP-LEVEL statements are touched; a `const` inside a loop or a block is
 * the function's own business and stays put. Three forms are rewritten:
 *
 *     const a = 1, {b, c} = o;   →   (a = 1), ({b, c} = o);        var a, b, c;
 *     function f() {…}           →   f = function f() {…};         var f;
 *     class C {…}                →   C = class C {…};              var C;
 *
 * Parsed with acorn, not a regex, so strings and templates around a declaration survive.
 */

import { parse, type Node } from "acorn";

type Pattern = Node & {
  type: string;
  name?: string;
  properties?: Array<Node & { type: string; value?: Pattern; argument?: Pattern }>;
  elements?: Array<Pattern | null>;
  left?: Pattern;
  argument?: Pattern;
};

/** Every binding a destructuring pattern introduces. */
function namesOf(p: Pattern, out: string[]): void {
  switch (p.type) {
    case "Identifier": out.push(p.name!); break;
    case "ObjectPattern": for (const prop of p.properties!) namesOf(prop.type === "RestElement" ? prop.argument! : prop.value!, out); break;
    case "ArrayPattern": for (const el of p.elements!) if (el) namesOf(el, out); break;
    case "AssignmentPattern": namesOf(p.left!, out); break;
    case "RestElement": namesOf(p.argument!, out); break;
  }
}

/** The snippet as a script the repl can run: hoisted names, then the async body, invoked. */
export function prepareCode(src: string): string {
  const program = parse(src, {
    ecmaVersion: "latest", sourceType: "script",
    allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
  });
  const names: string[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const slice = (n: Node) => src.slice(n.start, n.end);
  for (const node of program.body as Array<Node & { type: string; declarations?: Array<Node & { id: Pattern; init: Node | null }>; id?: Pattern | null }>) {
    if (node.type === "VariableDeclaration") {
      const parts = node.declarations!.map((d) => {
        namesOf(d.id, names);
        return `(${slice(d.id)} = ${d.init ? slice(d.init) : "undefined"})`;
      });
      edits.push({ start: node.start, end: node.end, text: `${parts.join(", ")};` });
    } else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) {
      names.push(node.id.name!);
      edits.push({ start: node.end, end: node.end, text: ";" });
      edits.push({ start: node.start, end: node.start, text: `${node.id.name} = ` });
    }
  }
  let body = src;
  for (const e of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, e.start) + e.text + body.slice(e.end);
  const hoist = names.length ? `var ${[...new Set(names)].join(", ")};\n` : "";
  return `${hoist}(async () => {\n${body}\n})()`;
}
