/**
 * Per-app knowledge, hermetically — `node scripts/test.mjs macos-app-notes`.
 *
 * The same stubbed apps as the other macOS suites. What is pinned here: an app's note rides the
 * OBSERVATION TEXT, arrives the first time this session observes that app and never again, an app
 * nobody has written about costs nothing, and a second app is told about itself rather than about
 * the first.
 *
 * The text carrier is the point: every path in reads it (`mirasim-cu mcp`, where the
 * HOST is the agent, as much as computer-use's own loop). A side-channel content part would reach
 * neither a host that reads the first text part nor one that re-serialises results
 * (`entries/mcp.ts` rebuilds a part from `type` and `text` alone).
 */

import { createHarness } from "./harness.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { appNote } from "../src/platform/macos/app-notes.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";
import { createComputerUseTools } from "../src/platform/tools/index.ts";
import type { ToolResult } from "../src/platform/types.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: ToolResult) => r.content.find((c) => c.type === "text")?.text ?? "";

/** A harness bound to one stubbed app — a fresh driver, so its "already told" set starts empty. */
function session(bundle: string) {
  const stub = stubTransport();
  return createHarness(new MacosDriver({ transport: stub.transport, env: {}, bundle }));
}

async function main() {
  // ── First observation of an app carries its note; the next one does not ────────────────
  {
    const h = session("com.apple.calculator");
    const first = firstText(await h.observe({}));
    check("the first observation of an app carries its note, in the observation text",
      /Calculator, known quirks/.test(first), first.split("\n").slice(0, 2).join(" / "));
    check("…carrying what was measured, not a paraphrase of it",
      /AXIncrement/.test(first) && /Click them instead/.test(first));
    check("…and the observation itself is still there, unchanged",
      /Title:/.test(first) && /全部清除|计算器/.test(first));

    const second = firstText(await h.observe({}));
    check("the second observation does not repeat it", !/Calculator, known quirks/.test(second),
      second.split("\n")[0]);
    const third = firstText(await h.act("click", { ref: "e3" }));
    check("…nor does an ACT's observation, later in the same session",
      !/Calculator, known quirks/.test(third), third.split("\n")[0]);
  }

  // ── An app nobody has written about costs nothing ───────────────────────────────────────
  {
    const h = session("com.example.agenthost");
    const first = firstText(await h.observe({}));
    check("an app with no note adds nothing to the observation", !/known quirks/.test(first),
      first.split("\n")[0]);
  }

  // ── A different app is told about ITSELF ────────────────────────────────────────────────
  {
    const h = session("com.apple.TextEdit");
    const first = firstText(await h.observe({}));
    check("a different app gets its own note, not the first one's",
      /TextEdit, known quirks/.test(first) && !/Calculator, known quirks/.test(first));
    check("…and it says the thing a model would otherwise get wrong",
      /openAndSavePanelService/.test(first) && /AXCancel/.test(first));
  }

  // ── The table itself ────────────────────────────────────────────────────────────────────
  check("lookup is by bundle id and case-insensitive — the walk reports what the app declares",
    appNote("com.apple.TextEdit") !== null && appNote("COM.APPLE.TEXTEDIT") === appNote("com.apple.TextEdit"));
  check("a note carries the app's own measured facts, not a generic warning",
    /Back to app/.test(appNote("com.openai.codex") ?? "") && /Enter/.test(appNote("com.apple.finder") ?? ""));
  // An app whose TREE can be empty needs the routes that do not go through the tree — otherwise
  // the note would only confirm the dead end the model has already met.
  check("the note for an app that can read as empty names the routes that are not the tree",
    /menu/i.test(appNote("com.microsoft.VSCode") ?? "") && /click\(\{x, y\}\)/.test(appNote("com.microsoft.VSCode") ?? ""));
  check("an unknown bundle, an empty one and a display NAME all answer nothing",
    appNote("com.example.nothing") === null && appNote("") === null && appNote("Calculator") === null
      && appNote(null) === null && appNote(undefined) === null);

  // ── `observation: 'brief'` must not cut the pack in half ─────────────────────
  // The head is an ARRAY of entries and the pack is ONE entry carrying several lines, so the
  // count is TEXT lines — counting entries would cut inside the pack, leaving its heading alone.
  {
    const [repl] = createComputerUseTools({ driver: new MacosDriver({ transport: stubTransport().transport, ...ONE_APP }) });
    const run = async (observation?: string) => {
      const r = await repl!.execute((observation ? { code: "return 1;", observation } : { code: "return 1;" }) as never);
      return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    };
    const pack = appNote("com.apple.calculator") ?? "";
    const lastLine = pack.trim().split("\n").at(-1)!.trim();
    check("the pack has more than one line, or this check proves nothing", pack.split("\n").length > 2, `${pack.split("\n").length} lines`);
    const brief = await run("brief");
    check("brief keeps the knowledge pack whole, heading AND body",
      brief.includes("Calculator, known quirks:") && brief.includes(lastLine), lastLine.slice(0, 60));
    check("…and still drops the element listing", !/^e\d+: /m.test(brief));
    // Counted, not searched: the pack is already inside the HEAD that brief keeps, and a
    // multi-line block never matches a single kept LINE, so it could be appended twice.
    check("…and exactly once — the block is not appended on top of the head that already has it",
      brief.split("Calculator, known quirks:").length - 1 === 1,
      `${brief.split("Calculator, known quirks:").length - 1}×`);
  }

  // ── A result that declares no shape is not trimmed to nothing ────────────────
  // A result with no line counts must not be cut to Number(undefined ?? 0): `launchApp` under
  // observation:'brief' would start the app and leave no trace of it.
  {
    const stub = stubTransport();
    // A session with no app named refuses the read.
    const [repl] = createComputerUseTools({ driver: new MacosDriver({ transport: stub.transport, env: {} }) });
    for (const observation of ["brief", "none"]) {
      const r = await repl!.execute({ code: "return 7;", observation } as never);
      const said = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      check(`a failed read under observation:'${observation}' still answers what ran`,
        said.trim().length > 0 && /Returned: 7/.test(said) && /no app was named/.test(said),
        said.trim() ? said.split("\n")[0]!.slice(0, 70) : "(EMPTY — the whole result vanished)");
    }
  }

  // ── What `observation:'none'` keeps, and what it must stop keeping ───────────
  // Not "every line that starts with NOTE:": notes ABOUT the listing must go with the listing,
  // while the pack — delivered once per session, and marked delivered when taken — carries no
  // NOTE: prefix and must survive.
  {
    const stub = stubTransport();
    stub.scrolledAway = true;   // gives the observation a listing note to be wrong about
    const [repl] = createComputerUseTools({ driver: new MacosDriver({ transport: stub.transport, ...ONE_APP }) });
    const none = (await repl!.execute({ code: "return 1;", observation: "none" } as never))
      .content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    check("none still carries the one-shot knowledge pack — taking it is what spends it",
      none.includes("Calculator, known quirks:") && none.includes((appNote("com.apple.calculator") ?? "").trim().split("\n").at(-1)!.trim()));
    check("…and drops the notes that describe the listing it just removed",
      !/outside the window/.test(none) && !/Targets:/.test(none) && !/^e\d+: /m.test(none),
      (none.match(/outside the window[^\n]{0,40}/) ?? ["(none — correct)"])[0]);
    check("…while the run's own journal is untouched", /Run completed/.test(none) && /Returned: 1/.test(none));
  }

  // ── One entry may not SWALLOW the next ───────────────────────────────────────────────
  // These notes are template literals in one table, so an escaped backtick inside one runs it
  // into its neighbours and the table still typechecks. One header per note is the invariant.
  for (const bundle of ["com.apple.QuickTimePlayerX", "org.blenderfoundation.blender", "com.apple.finder",
    "com.apple.TextEdit", "com.apple.calculator", "com.microsoft.Excel", "com.microsoft.Word", "com.apple.systempreferences"]) {
    const note = appNote(bundle) ?? "";
    const headers = note.match(/known quirks/g)?.length ?? 0;
    check(`${bundle}'s note ends where it should — one entry, not the table after it`,
      !!note && headers === 1 && !note.includes('": `'), `${headers} headers, ${note.length} chars`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall macos app-note checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
