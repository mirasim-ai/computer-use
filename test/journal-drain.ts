/**
 * Journal drain bounds (`node scripts/test.mjs journal-drain`) — hermetic, no browser.
 *
 * `close()` waits for the journal's queued line so the run's last action keeps its
 * evidence shot.
 * That wait is on the exit path of every computer-use process, so the two properties that
 * matter are not "it works" but its BOUNDS: a healthy shot must cost ~nothing, and a
 * shot that never returns must not hold the process past the bound.
 *
 * ActionJournal takes its screenshot as a callback, so both cases are just a fake
 * callback — no Chrome, no profile.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionJournal } from "../src/platform/browser/journal.ts";
import { actionsFileFor } from "../src/platform/browser/acquire.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "computer-use-journal-"));
  dirs.push(d);
  return d;
}

async function main() {
  // ── A shot that never comes back must not hold the exit ────────────────────
  {
    const dir = scratch();
    const j = new ActionJournal(dir, () => new Promise<Buffer | null>(() => {}), () => "about:blank");
    j.publishAction("click", { x: 1, y: 1 }, null, { ok: true });
    const t0 = Date.now();
    let threw = false;
    await j.drain(200).catch(() => { threw = true; });
    const spent = Date.now() - t0;
    check("a hanging shot is abandoned at the bound", spent >= 190 && spent < 1500, `${spent}ms`);
    check("the drain never throws at its caller", !threw);
  }

  // ── The healthy case costs ~nothing (this runs on every process exit) ──────
  {
    const dir = scratch();
    const j = new ActionJournal(dir, () => Promise.resolve(Buffer.from("not-a-real-jpeg")), () => "about:blank");
    j.publishAction("click", { x: 1, y: 1 }, null, { ok: true });
    const t0 = Date.now();
    await j.drain(5_000);
    const spent = Date.now() - t0;
    check("a shot that answers does not pay the bound", spent < 1_000, `${spent}ms`);
    // And the point of waiting at all: the line is readable once drain returns.
    const lines = readFileSync(actionsFileFor(dir), "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]!) as { kind?: string; shot?: string };
    check("the queued line is on disk when drain returns", last.kind === "click", JSON.stringify(last));
    check("and it carries its shot", typeof last.shot === "string", last.shot ?? "(none)");
  }

  // ── Nothing queued: drain is a no-op, not a wait ───────────────────────────
  {
    const j = new ActionJournal(scratch(), () => Promise.resolve(null), () => "");
    const t0 = Date.now();
    await j.drain(5_000);
    check("an empty chain returns immediately", Date.now() - t0 < 200, `${Date.now() - t0}ms`);
  }

  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  console.log(failures ? `\njournal-drain: ${failures} FAILED` : "\njournal-drain: OK");
  // No process.exit: the drain test leaves nothing running, and exiting hard here
  // truncated the piped output that a CI log is made of.
  process.exitCode = failures ? 1 : 0;
}

void main();
