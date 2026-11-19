/**
 * What a first call that gets something wrong is told — `node scripts/test.mjs first-use`.
 *
 * Hermetic, over the stubbed macOS helper: every message here is the repl's or the shared API's,
 * and a model that wrote the wrong thing must read, in the refusal, the thing to write instead.
 */

import { createComputerUseTools } from "../src/platform/tools/index.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";
import { statusLineShows } from "../src/platform/driver-wait.ts";
import { chordIsText } from "../src/platform/tools/api.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
type Result = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const allText = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
const head = (s: string) => s.split("\n")[0] ?? "";

async function main() {
  const stub = stubTransport();
  const driver = new MacosDriver({ transport: stub.transport, ...ONE_APP });
  const ownership = { claim: async () => {}, release: async () => {}, releaseAll: async () => {} };
  const tools = Object.fromEntries(createComputerUseTools([{ driver }], { ownership }).map((t) => [t.name, t]));
  const call = async (params: Record<string, unknown>) => allText(await tools.computer_repl!.execute({ observation: "brief", ...params }) as Result);
  const run = (code: string) => call({ code });

  try {
    const bound = await run("const w = await computer.surface('com.apple.calculator'); return w.id;");
    check("the session binds its app", /Returned: /.test(bound), head(bound));

    // ── A verb name from another library is answered with the one this runtime has ─────────
    const fill = head(await run("await w.fill('e2', 'x');"));
    check("w.fill names setText in the shape it takes, and lists the handle's verbs",
      /w\.fill is not a function — a surface handle has no fill — instead: await w\.setText\(t, "text"\)/.test(fill)
        && /Verbs on w: .*\bobserve\b.*\bsetText\b/.test(fill), fill);
    const press = head(await run("await w.press('Enter');"));
    check("w.press names keys", /instead: await w\.keys\("Enter"\)/.test(press), press);
    const getText = head(await run("return await w.getText();"));
    check("w.getText names text() and value(t)", /await w\.text\(\).*await w\.value\(t\)/.test(getText), getText);
    const openURL = head(await run("await w.setTEXT('e2', 'x');"));
    check("a real verb spelt in another case is named as it is spelt", /instead: await w\.setText\(t, "text"\)/.test(openURL), openURL);
    const nothing = head(await run("await w.frobnicate();"));
    check("a name with no counterpart still lists the handle's verbs", /a surface handle has no frobnicate — Verbs on w: /.test(nothing), nothing);
    const title = head(await run("return w.title();"));
    check("calling a property says it is one", /title is a property of the handle, not a verb — read it as w\.title/.test(title), title);
    // A platform that has no openUrl is never told to use one.
    const goto = head(await run("await w.goto('https://example.com');"));
    check("w.goto on a macOS handle offers no openUrl", /a surface handle has no goto — Verbs on w:/.test(goto) && !/openUrl/.test(goto), goto);

    const top = head(await run("await computer.click('e2');"));
    check("computer.<verb> says verbs live on a handle and shows the bind",
      /computer\.click is not a function — computer has only surfaces\(\), surface\(\), help\(\)|computer has only .*click is a verb on a surface handle, bound first: const w = await computer\.surface\(\); await w\.click\(t\)/.test(top), top);
    const topOdd = head(await run("await computer.goto('https://example.com');"));
    check("computer.<unknown> lists the handle verbs", /verbs live on a surface handle, bound first: .* the verbs are .*\bfind\b/.test(topOdd), topOdd);

    // Handles stay ordinary objects: nothing above may change what a script can ask of one.
    const plain = await run("return {goto: typeof w.goto, then: 'then' in w, json: JSON.parse(JSON.stringify(w)).id === w.id};");
    check("…while typeof, `in` and JSON.stringify of a handle are untouched",
      /Returned: \{"goto":"undefined","then":false,"json":true\}/.test(plain), plain.split("\n").find((l) => l.startsWith("Returned")) ?? head(plain));
    const own = head(await run("const o = {}; o.goto();"));
    check("a script's own object missing a method keeps V8's words", /^Run STOPPED .*TypeError: o\.goto is not a function$/.test(own), own);
    // ── expect refuses an option by name, and a "gone" condition is sent to wait ──────────
    const gone = head(await run("await w.expect({text_gone: 'Loading'});"));
    check("expect({text_gone}) names the option, lists what it takes and writes the wait guard",
      /expect does not take text_gone — it takes one of text, control, url or value \(with equals\), and ms/.test(gone)
        && /if \(!await w\.wait\(\{text_gone: "…"\}\)\) throw new Error/.test(gone), gone);
    const odd = head(await run("await w.expect({text: 'x', timeout: 3000});"));
    check("…and any other unknown option is named too", /expect does not take timeout — /.test(odd) && !/wait\(\{/.test(odd), odd);
    // ── wait refuses what it does not read, instead of running as wait({}) ────────────────
    const foo = head(await run("return await w.wait({foo: 1});"));
    check("wait({foo}) is refused, naming foo and listing what wait takes",
      /wait does not take foo\. It takes ms, text, control, text_gone, control_gone, url, url_gone, loaded/.test(foo), foo);
    const timeout = head(await run("return await w.wait({text: 'Saved', timeout: 3000});"));
    check("…a timeout is pointed at ms", /wait does not take timeout — the budget is ms\./.test(timeout), timeout);
    const selector = head(await run("return await w.wait({selector: '#done'});"));
    check("…a selector at control and text", /wait does not take selector — name the control \(wait\(\{control: "Save"\}\)\)/.test(selector), selector);
    // ── keys never cuts a count short in silence ──────────────────────────────────────────
    const before = stub.calls.length;
    const many = head(await run("await w.keys('Backspace', 50);"));
    check("keys with a count over 20 is refused, saying the maximum and to call again",
      /keys presses a chord at most 20 times per keys\(\) call, and was asked for 50 — nothing was pressed\. Call it again for the rest: keys\("Backspace", 20\)/.test(many), many);
    check("…before anything was pressed", !stub.calls.slice(before).some((c) => /key/.test(c.op)), stub.calls.slice(before).map((c) => c.op).join(","));
    // ── keys refuses text before pressing anything ────────────────────────────────────────
    const typed = head(await run("await w.keys('hello world');"));
    check("keys('hello world') is refused as text, pointing at setText and, on macOS, type",
      /"hello world" is text, not a key or chord — nothing was pressed\. To fill a field: setText\(t, "hello world"\) replaces its value; to insert at the caret: type\(\{text: "hello world"\}\)/.test(typed), typed);
    // ── A platform verb handed a string shows the object it meant, the string in place ──────
    const launch = head(await run("await w.launchApp('com.apple.TextEdit');"));
    check("launchApp('<bundle>') is answered with launchApp({bundle: '<bundle>'})",
      /launchApp takes an options object, not "com\.apple\.TextEdit" — pass its arguments as an object: launchApp\(\{bundle: "com\.apple\.TextEdit"\}\)/.test(launch), launch);
    const ax = head(await run("await w.axAction('AXPress');"));
    check("…and a verb that requires two options shows both", /axAction\(\{ref: t, action: "…"\}\)/.test(ax), ax);
    // ── find within a find that matched nothing says so ──────────────────────────────────
    const inside = head(await run("return await w.find('全部清除', {within: await w.find('No such dialog anywhere')});"));
    check("find(…, {within: null}) says the find passed as within matched nothing",
      /find's `within` is null — the find\(\) passed as within matched nothing .* Check that control's role and name/.test(inside), inside);
    const why = head(await run("return await w.find('全部清除', {within: await w.find('No such dialog anywhere', {why: true})});"));
    check("…and a why-miss passed as within quotes its own note", /find's `within` is a find\(\) that matched nothing: no match/.test(why), why);
  } finally {
    await driver.close();
  }

  // ── A wait on a surface that went away answers as a wait does, true or false ──────────────
  // `if (!await w.wait({text: 'Done'}))` must not read a closed window as "Done appeared".
  {
    const st = stubTransport();
    st.extraWindow = "numbered";
    const second = new MacosDriver({ transport: st.transport, ...ONE_APP });
    const tools = Object.fromEntries(createComputerUseTools([{ driver: second }], { ownership }).map((t) => [t.name, t]));
    const go = async (code: string) => allText(await tools.computer_repl!.execute({ code, observation: "brief" }) as Result);
    try {
      await go("p = await computer.surface('49403:9911'); await p.observe(); return 1;");
      st.extraWindow = false;     // the panel closes
      const out = await go("return [await p.wait({text: 'Done', ms: 100}), await p.wait({control_gone: 'Cancel', ms: 100})];");
      check("a wait for something to appear on a gone surface answers false, and one for something to go answers true",
        /Returned: \[false,true\]/.test(out), out.split("\n").find((l) => l.startsWith("Returned")) ?? head(out));
      check("…and the journal says the surface is gone",
        /wait 49403:9911 FAILED: 49403:9911 is gone — closed or replaced, so nothing can appear on it any more/.test(out)
          && /wait 49403:9911: 49403:9911 is gone — closed or replaced, so what was waited on to go went with it/.test(out),
        out.split("\n").filter((l) => /^\s+\d+\. wait/.test(l)).join(" | "));
    } finally {
      await second.close();
    }
  }
  // ── Which text a control_gone falls back to: a status line, never a word in a sentence ───
  check("a line that is the name, with an ellipsis, a glyph or a percentage around it, is a status line",
    statusLineShows("Tasks\nLoading tasks…\nSave", "Loading tasks") && statusLineShows("⏳ Saving… 40%", "Saving…")
      && statusLineShows("FETCHING TASKS", "Fetching tasks"));
  check("…a sentence that carries the name is not, nor is a longer label",
    !statusLineShows("Press Stop to cancel", "Stop") && !statusLineShows("Loading tasks for Bob", "Loading tasks") && !statusLineShows("", "…"));

  const keysOk = ["Enter", "enter", "ArrowDown", "Control+a", "Meta+Shift+z", "F5", "f12", "Space", " ", "Control+ ", "cmd+shift+s",
    "a", "A", "é", "+", "Control++", "PageDown", "Escape", "Shift+Tab", "alt+f4", "PrintScreen", "NumpadEnter", "KeyA", "\u2318\u21e7N"];
  const keysText = ["hello world", "hello", "abc", "Control+hello", "HELLO", "type this", "Enter please"];
  const wrongOk = keysOk.filter((c) => chordIsText(c));
  const wrongText = keysText.filter((c) => !chordIsText(c));
  check("every key name and chord the platforms take still goes through", !wrongOk.length, JSON.stringify(wrongOk));
  check("…and text is told apart from them", !wrongText.length, JSON.stringify(wrongText));

  console.log(failures ? `\n${failures} check(s) failed` : "\nall first-use checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
