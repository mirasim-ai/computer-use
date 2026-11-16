/**
 * No result carries half a character — `node scripts/test.mjs text-cut`.
 *
 * A string cut by its UTF-16 length can end between the two units of an emoji. JSON writes
 * that lone surrogate as an escape a strict parser refuses, so the client loses the whole
 * result over one name. Hermetic, over the stubbed macOS helper:
 *
 *   · the cut itself stops one unit short of splitting a pair, and is otherwise `slice`;
 *   · a returned value and a log line cut at their caps end on a whole character;
 *   · half a character the code (or a page) produced itself still leaves well-formed.
 */

import { MacosDriver } from "../src/platform/macos/driver.ts";
import { createComputerUseTools } from "../src/platform/tools/index.ts";
import { RETURN_CAP } from "../src/platform/tools/repl-budget.ts";
import { cutText, wellFormed } from "../src/platform/text-cut.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const units = (s: string) => [...s].length === s.length ? "no pairs" : `${s.length} units`;
const ownership = { claim: async () => {}, release: async () => {}, releaseAll: async () => {} };

async function main() {
  // ── The cut ──────────────────────────────────────────────────────────────────────────────
  const face = "\u{1F600}";
  check("a cut between characters is slice", cutText("abcdef", 4) === "abcd" && cutText("abc", 4) === "abc" && cutText("abcd", 4) === "abcd");
  check("a cut that would split a pair stops one unit short", cutText(`abc${face}z`, 4) === "abc", JSON.stringify(cutText(`abc${face}z`, 4)));
  check("a pair that fits is kept whole", cutText(`abc${face}z`, 5) === `abc${face}`, units(cutText(`abc${face}z`, 5)));
  check("a pair that ends the string exactly at the cap is kept", cutText(`ab${face}`, 4) === `ab${face}`);
  check("half a character already there is replaced, on either side", wellFormed("a\uD83Db") === "a�b" && wellFormed("a\uDE00b") === "a�b");
  check("whole text is left as it is", wellFormed(`a${face}b 文字`) === `a${face}b 文字`);

  // ── Through a call ───────────────────────────────────────────────────────────────────────
  const driver = new MacosDriver({ transport: stubTransport().transport, ...ONE_APP });
  const tools = Object.fromEntries(createComputerUseTools([{ driver }], { ownership }).map((t) => [t.name, t]));
  const run = async (code: string) => {
    const r = await tools.computer_repl!.execute({ code, observation: "none", interaction: "desktop" } as never);
    return r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n").split("\nAPI reference")[0]!;
  };
  // The emoji's two units sit on either side of the cap.
  const long = await run(`return 'A'.repeat(${RETURN_CAP - 1}) + '\\u{1F600}' + 'B'.repeat(50);`);
  check("a returned value cut at its cap ends on a whole character", /A… \(cut at 12000 of/.test(long) && !LONE.test(long) && !long.includes("�"),
    long.split("\n").find((l) => l.startsWith("Returned"))?.slice(-120) ?? long.slice(0, 200));
  const logged = await run("computer.log('L'.repeat(199) + '\\u{1F600}' + 'tail'); return 1;");
  check("a log line cut at its cap ends on a whole character", /L{199}/.test(logged) && !LONE.test(logged) && !logged.includes("�"),
    logged.split("\n").find((l) => l.includes("LLLL"))?.slice(-60) ?? logged.slice(0, 200));
  const half = await run("return 'half ' + String.fromCharCode(0xD83D) + ' end';");
  check("half a character the code itself returned leaves as U+FFFD, the rest untouched", !LONE.test(half) && /half � end/.test(half),
    JSON.stringify(half.split("\n").find((l) => l.startsWith("Returned")) ?? half.slice(0, 200)));
  check("...so the result survives being written as UTF-8 and read back", Buffer.from(half, "utf8").toString("utf8") === half);
  await driver.close();

  console.log(failures ? `\n${failures} check(s) failed` : "\nall text-cut checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
