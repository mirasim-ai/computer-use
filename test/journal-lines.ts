/**
 * What a long run's journal keeps (`node scripts/test.mjs journal-lines`) — hermetic.
 *
 * A run of more than 24 steps prints its first and last twelve and counts the rest. The count
 * used to take every step in the middle, so one that failed and was caught by the code, or that
 * came back uncertain, was not in the result at all. Only steps that went through may be counted
 * away.
 */

import { renderJournal } from "../src/platform/tools/api-run.ts";
import type { JournalLine } from "../src/platform/tools/api-contract.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const step = (i: number, over: Partial<JournalLine> = {}): JournalLine =>
  ({ i, kind: "click", target: `e${i}`, ok: true, note: "clicked", outcome: "dispatched", ...over });
const run = (n: number, over: Record<number, Partial<JournalLine>> = {}) =>
  Array.from({ length: n }, (_, k) => step(k + 1, over[k + 1]));

{
  const short = renderJournal(run(24));
  check("a run of 24 steps is listed whole", short.length === 24 && !short.some((l) => /not listed/.test(l)), `${short.length} lines`);
}
{
  const clean = renderJournal(run(40));
  check("a long run that went through prints both ends and counts the middle",
    clean.length === 25 && /^ {2}1\. click e1/.test(clean[0]!) && /… 16 steps that went through are not listed …/.test(clean[12]!)
    && /^ {2}40\. click e40/.test(clean[24]!), clean[12]);
}
{
  const out = renderJournal(run(40, { 20: { outcome: "uncertain", note: "sent, and the page has not answered" } }));
  const at = out.findIndex((l) => /^ {2}20\. click e20 \[uncertain\]/.test(l));
  check("a step in the middle that came back uncertain is listed", at > 0, out.find((l) => /not listed/.test(l)));
  check("...with the steps around it counted on either side, and its own number kept",
    /… 7 steps that went through are not listed …/.test(out[at - 1] ?? "") && /… 8 steps that went through are not listed …/.test(out[at + 1] ?? ""),
    `${out[at - 1]} | ${out[at + 1]}`);
}
{
  const out = renderJournal(run(40, { 15: { ok: false, outcome: "blocked", note: "e15 is covered" } }));
  check("a step in the middle that failed and was caught by the code is listed as FAILED",
    out.some((l) => /^ {2}15\. click e15 FAILED \[blocked\]: e15 is covered/.test(l)), out.find((l) => /not listed/.test(l)));
}
{
  // A failed read carries no outcome; it is still a failure.
  const out = renderJournal(run(40, { 18: { kind: "expect", ok: false, outcome: undefined, note: "condition was not verified" } }));
  check("a failed step with no outcome is listed too", out.some((l) => /^ {2}18\. expect e18 FAILED/.test(l)), out.find((l) => /not listed/.test(l)));
}
{
  const out = renderJournal(run(40, { 13: { outcome: "uncertain" }, 14: { ok: false, outcome: "blocked" }, 28: { outcome: "uncertain" } }));
  const marks = out.filter((l) => /not listed/.test(l));
  check("steps to keep that sit side by side, or against an edge, leave no empty count between them",
    marks.length === 1 && /… 13 steps that went through are not listed …/.test(marks[0]!), marks.join(" | "));
}
{
  const out = renderJournal(run(26, { 13: { outcome: "uncertain" } }));
  check("one step counted away is said in the singular", out.some((l) => /… 1 step that went through is not listed …/.test(l)), out.find((l) => /not listed/.test(l)));
}
{
  const all = renderJournal(run(60, Object.fromEntries(Array.from({ length: 60 }, (_, k) => [k + 1, { ok: false, outcome: "blocked" as const }]))));
  check("a run in which every step failed is listed whole", all.length === 60 && !all.some((l) => /not listed/.test(l)), `${all.length} lines`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall journal-lines checks passed");
process.exit(failures ? 1 : 0);
