/**
 * What a run's failure says when the script reached for a name this runtime does not have.
 *
 * Models arrive with Playwright and Puppeteer in their fingers: `w.goto(url)`, `w.fill(t, 'x')`,
 * `w.press('Enter')`, `w.evaluate(js)`. V8 answers `w.goto is not a function`, which names what
 * is missing and nothing about what is there, so the next call is another guess. These helpers
 * turn that into the verb this runtime does have, in the shape it takes, and the handle's own
 * verb list. Pure functions over names and schemas: repl.ts decides what the receiver is.
 */

import type { TSchema } from "typebox";

/** Invented names (lowercased) → the real verbs that do that job, best first. Only the ones the
 *  handle actually has are offered, so a macOS handle is never told to openUrl. */
const ALIASES: Record<string, string[]> = {};
const alias = (verbs: string[], names: string[]) => { for (const n of names) ALIASES[n] = verbs; };
alias(["openUrl"], ["goto", "navigate", "navigateto", "open", "visit", "load", "go", "gotourl", "openpage", "browse", "loadurl", "seturl"]);
alias(["newTab"], ["newpage", "opentab", "newwindow", "createtab", "openinnewtab"]);
alias(["setText", "paste", "type"], ["type", "fill", "input", "typetext", "entertext", "write", "sendkeys", "filltext", "setvalue",
  "enter", "insert", "inserttext", "clear", "clearandtype"]);
alias(["keys"], ["press", "keyboard", "presskey", "sendkey", "key", "hotkey", "shortcut", "keypress", "keydown", "keyup", "presskeys"]);
alias(["text", "value", "page"], ["gettext", "textcontent", "innertext", "readtext", "content", "getcontent", "html", "gethtml",
  "innerhtml", "outerhtml", "read", "extract", "gettextcontent", "pagetext"]);
alias(["value"], ["getvalue", "inputvalue", "readvalue", "getinputvalue"]);
alias(["runJs"], ["evaluate", "eval", "exec", "execute", "runscript", "executescript", "evaluatejs", "js", "script", "runjavascript",
  "javascript", "evaluatehandle", "addscripttag"]);
alias(["wait"], ["waitfor", "waitforselector", "waitfortext", "waitforelement", "waitfornavigation", "waitforloadstate", "waitfortimeout",
  "waitforurl", "waitforfunction", "waituntil", "sleep", "pause", "delay", "waitforidle", "waitforload"]);
alias(["selectOption"], ["select", "selectoptions", "choose", "selectbylabel", "selectbyvalue", "pick", "setselect"]);
alias(["click"], ["check", "uncheck", "tap", "dblclick", "doubleclick", "rightclick", "clickon", "clickelement", "toggle", "submit"]);
alias(["find", "observe"], ["query", "queryselector", "queryselectorall", "$", "$$", "locator", "getbyrole", "getbytext", "getbylabel",
  "getbyplaceholder", "findelement", "findelements", "findbyname", "findall", "search", "locate", "get", "element", "elements"]);
alias(["screenshot", "observe"], ["snapshot", "capture", "takescreenshot", "screen", "screencapture"]);
alias(["back"], ["goback", "historyback", "navigateback"]);
alias(["reload"], ["refresh", "reloadpage"]);
alias(["closeTab"], ["close", "closepage", "closewindow"]);
alias(["scroll"], ["scrollto", "scrollintoview", "scrolldown", "scrollup", "scrollby", "scrollintoviewifneeded"]);
alias(["hover"], ["mouseover", "mousemove", "movemouse"]);
alias(["expect"], ["assert", "verify", "expecttext", "should", "asserttext"]);

/** Names that are not verbs at all, and what they mean here. */
const READS: Record<string, string> = {
  url: "the address is (await w.observe()).url",
  geturl: "the address is (await w.observe()).url",
  currenturl: "the address is (await w.observe()).url",
  location: "the address is (await w.observe()).url",
  gettitle: "the title is w.title, or (await w.observe()).title",
};

/** How each universal verb is written; a platform verb's shape comes from its schema. */
const SHAPES: Record<string, string> = {
  observe: "observe()",
  find: "find(\"Save\", {role: \"button\"})",
  text: "text()  — the surface's whole readable text",
  value: "value(t)  — one field's value",
  page: "page()",
  screenshot: "screenshot()",
  click: "click(t)",
  hover: "hover(t)",
  setText: "setText(t, \"text\")  — replaces the whole field",
  keys: "keys(\"Enter\")",
  scroll: "scroll({direction: \"down\"})",
  wait: "wait({control: \"Save\"}), wait({text: \"Saved\"}) or wait({ms: 500})",
  expect: "expect({text: \"Saved\"})",
};

/** A placeholder for a required option, by its name. */
const PLACEHOLDERS: Record<string, string> = {
  url: "\"https://…\"",
  code: "\"document.title\"",
  ref: "t",
  option: "\"…\"",
  text: "\"…\"",
  bundle: "\"com.apple.TextEdit\"",
  id: "\"<tab id>\"",
  path: "\"…\"",
};

/** What a platform verb's schema says about it: the option names it REQUIRES (never `kind`). */
function required(schema: TSchema | undefined): string[] {
  const s = schema as { required?: string[] } | undefined;
  return (s?.required ?? []).filter((k) => k !== "kind");
}

/** Where a sentence about a verb ends: after a paste or a type, say what each does. */
const NOTES: Record<string, string> = {
  paste: "  — inserts at the caret",
  type: "  — types at the keyboard focus",
};

/**
 * How `verb` is written, with its required options filled in: `openUrl({url: "https://…"})`.
 * `given` is a string the script passed positionally; when the verb requires exactly one option,
 * it is shown in that option's place, so the refusal is the call the script meant.
 */
export function verbShape(verb: string, schema?: TSchema, given?: string): string {
  if (SHAPES[verb]) return SHAPES[verb]!;
  const keys = required(schema);
  if (!schema && !keys.length) return `${verb}(…)`;
  const value = (k: string) => (given !== undefined && keys.length === 1 ? JSON.stringify(given) : PLACEHOLDERS[k] ?? "\"…\"");
  return `${verb}(${keys.length ? `{${keys.map((k) => `${k}: ${value(k)}`).join(", ")}}` : ""})${NOTES[verb] ?? ""}`;
}

/** The real verbs on `members` for an invented `name`, or [] when it suggests none. */
export function realVerbsFor(name: string, members: string[]): string[] {
  const lower = name.toLowerCase();
  // `openURL`, `settext`, `runJS`: the verb exists, spelt differently.
  const cased = members.filter((m) => m !== name && m.toLowerCase() === lower);
  if (cased.length) return cased;
  return (ALIASES[lower] ?? []).filter((v) => members.includes(v));
}

/**
 * The tail for `<receiver>.<name> is not a function` on a surface handle: what to call instead,
 * and every verb the handle has. `props` are the handle's data members (id, title, …): calling
 * one of those is reading it.
 */
export function onHandle(receiver: string, name: string, members: string[], props: string[], schemas: Map<string, TSchema>): string {
  if (props.includes(name)) return `${name} is a property of the handle, not a verb — read it as ${receiver}.${name}`;
  const real = realVerbsFor(name, members);
  const read = READS[name.toLowerCase()];
  const instead = real.length
    ? `instead: ${real.map((v) => `await ${receiver}.${verbShape(v, schemas.get(v))}`).join("; or ")}. `
    : read ? `${read.replace(/\bw\b/g, receiver)}. ` : "";
  return `a surface handle has no ${name} — ${instead}Verbs on ${receiver}: ${members.join(", ")}`;
}

/** The tail for `computer.<name> is not a function`: verbs live on a handle, bound first. */
export function onComputer(name: string, members: string[], handleVerbs: string[], schemas: Map<string, TSchema>): string {
  const listed = members.map((m) => `${m}()`).join(", ");
  const real = handleVerbs.includes(name) ? [name] : realVerbsFor(name, handleVerbs);
  if (!real.length) {
    return `computer has only ${listed}; verbs live on a surface handle, bound first: const w = await computer.surface(); `
      + `then w.<verb>(…) — the verbs are ${handleVerbs.join(", ")}`;
  }
  return `computer has only ${listed}; ${real[0]} is a verb on a surface handle, bound first: `
    + `const w = await computer.surface(); await w.${verbShape(real[0]!, schemas.get(real[0]!))}`;
}
