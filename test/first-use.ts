/**
 * What a first call that gets something wrong is told — `node scripts/test.mjs first-use`.
 *
 * Hermetic, over the stubbed macOS helper: every message here is the repl's or the shared API's,
 * and a model that wrote the wrong thing must read, in the refusal, the thing to write instead.
 */

import { createComputerUseTools } from "../src/platform/tools/index.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";

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
  } finally {
    await driver.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall first-use checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
