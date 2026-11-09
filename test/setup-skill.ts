/**
 * `mirasim-cu setup skill` — `node scripts/test.mjs setup-skill`.
 *
 * Hermetic: a scratch home with fake agent folders. No agent, no network.
 *
 *   · the shipped skill lands in Claude Code's and Codex's skills folders, only for an agent set up
 *     in that home;
 *   · two folders linked to one get one copy, and the Mirasim app's own folder is left to the app;
 *   · --remove takes back what it installed and nothing else.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSkillDirs, setupSkill, shippedSkills, SKILLS_ROOT } from "../src/entries/commands/setup-skill.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const names = shippedSkills();
check("the package ships the mirasim-computer-use skill", names.includes("mirasim-computer-use"), names.join(", "));
const shipped = readFileSync(join(SKILLS_ROOT, "mirasim-computer-use", "SKILL.md"), "utf8");
check("its SKILL.md names itself in the front matter", /^---\nname: mirasim-computer-use\ndescription: \S/.test(shipped));

// A home with Claude Code only: Codex's folder is not created.
{
  const home = mkdtempSync(join(tmpdir(), "cu-skill-"));
  mkdirSync(join(home, ".claude"));
  const dirs = defaultSkillDirs(home);
  check("only Claude Code's folder for a home without Codex", dirs.length === 1 && dirs[0] === join(home, ".claude", "skills"), dirs.join(", "));
  const r = setupSkill(dirs, { home });
  const dest = join(home, ".claude", "skills", "mirasim-computer-use", "SKILL.md");
  check("installs the skill there", r[0]?.result === "installed" && existsSync(dest) && readFileSync(dest, "utf8") === shipped);
  // A stale copy is replaced, a sibling skill untouched.
  writeFileSync(dest, "old");
  mkdirSync(join(home, ".claude", "skills", "other"));
  writeFileSync(join(home, ".claude", "skills", "other", "SKILL.md"), "mine");
  setupSkill(dirs, { home });
  check("a second run replaces the old copy", readFileSync(dest, "utf8") === shipped);
  const back = setupSkill(dirs, { home, remove: true });
  check("--remove takes it back", back[0]?.result === "removed" && !existsSync(join(home, ".claude", "skills", "mirasim-computer-use")));
  check("--remove leaves other skills", readFileSync(join(home, ".claude", "skills", "other", "SKILL.md"), "utf8") === "mine");
  check("--remove again finds nothing", setupSkill(dirs, { home, remove: true })[0]?.result === "absent");
}

// Both agents, their folders linked to one: one copy.
{
  const home = mkdtempSync(join(tmpdir(), "cu-skill-"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".agents"));
  mkdirSync(join(home, "shared"));
  symlinkSync(join(home, "shared"), join(home, ".claude", "skills"));
  symlinkSync(join(home, "shared"), join(home, ".agents", "skills"));
  const dirs = defaultSkillDirs(home);
  check("Claude Code's and Codex's folders", dirs.length === 2, dirs.join(", "));
  const r = setupSkill(dirs, { home });
  check("two links to one folder get one copy", r.length === 1 && existsSync(join(home, "shared", "mirasim-computer-use", "SKILL.md")));
}

// The Mirasim app links both to ~/.mirasim/skills: left to the app.
{
  const home = mkdtempSync(join(tmpdir(), "cu-skill-"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".mirasim", "skills"), { recursive: true });
  symlinkSync(join(home, ".mirasim", "skills"), join(home, ".claude", "skills"));
  const r = setupSkill(defaultSkillDirs(home), { home });
  check("the Mirasim app's folder is skipped", r[0]?.result === "skipped" && !existsSync(join(home, ".mirasim", "skills", "mirasim-computer-use")), JSON.stringify(r));
}

// No agent set up: nothing to do.
{
  const home = mkdtempSync(join(tmpdir(), "cu-skill-"));
  check("no agent folder, no target", defaultSkillDirs(home).length === 0);
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
