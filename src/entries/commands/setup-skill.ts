/**
 * `mirasim-cu setup skill` — copy the agent skill this package ships (`skills/<name>/SKILL.md`)
 * into the skill folders the agents read, so a Claude Code or Codex user gets it without
 * finding the package on disk (under `npx` it lives in npx's cache).
 *
 *   ~/.claude/skills   Claude Code
 *   ~/.agents/skills   Codex
 *
 * A copy, not a link: a link into npx's cache breaks when the cache is cleared. So the copy is
 * as old as the last run, and the usage says to run it again after an upgrade.
 *
 * Two folders that are one folder (the Mirasim app links both to `~/.mirasim/skills`) get one
 * copy. That folder is skipped: the app installs its own copy there, pinned to the version it
 * ships, and leaves alone a directory it did not write — so ours would block its updates.
 */

import { cpSync, existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the package keeps its skills: `skills/` at the package root, from `src/` and `dist/` alike. */
export const SKILLS_ROOT = fileURLToPath(new URL("../../../skills/", import.meta.url));

export interface SkillTarget {
  /** The skills folder as given. */
  dir: string;
  /** What happened there. */
  result: "installed" | "removed" | "absent" | "skipped";
  /** Why it was skipped. */
  note?: string;
}

/** The skills folders of the agents set up under `home`: Claude Code's when `~/.claude` exists,
 *  Codex's when `~/.codex` (or `~/.agents`) does. */
export function defaultSkillDirs(home = homedir()): string[] {
  const dirs: string[] = [];
  if (existsSync(join(home, ".claude"))) dirs.push(join(home, ".claude", "skills"));
  if (existsSync(join(home, ".codex")) || existsSync(join(home, ".agents"))) dirs.push(join(home, ".agents", "skills"));
  return dirs;
}

/** The skill directories this package ships. */
export function shippedSkills(root = SKILLS_ROOT): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "SKILL.md")))
    .map((e) => e.name);
}

/** A folder resolved through its links; a missing one resolves as far as it exists. */
function canonical(dir: string): string {
  try { return realpathSync(dir); } catch { return resolve(dir); }
}

/**
 * Install (or with `remove`, take back) every shipped skill in each folder. `home` decides where
 * the Mirasim app's folder is, so a test can run it in a scratch home.
 */
export function setupSkill(dirs: string[], opts: { remove?: boolean; home?: string; root?: string } = {}): SkillTarget[] {
  const root = opts.root ?? SKILLS_ROOT;
  const names = shippedSkills(root);
  const appDir = canonical(join(opts.home ?? homedir(), ".mirasim", "skills"));
  const seen = new Set<string>();
  const out: SkillTarget[] = [];
  for (const dir of dirs) {
    const real = canonical(dir);
    if (seen.has(real)) continue;
    seen.add(real);
    if (real === appDir) {
      out.push({ dir, result: "skipped", note: "the Mirasim app keeps this folder and installs its own copy" });
      continue;
    }
    let touched = false;
    for (const name of names) {
      const dest = join(dir, name);
      if (opts.remove) {
        if (!existsSync(dest)) continue;
        rmSync(dest, { recursive: true, force: true });
      } else {
        rmSync(dest, { recursive: true, force: true });
        cpSync(join(root, name), dest, { recursive: true });
      }
      touched = true;
    }
    out.push({ dir, result: opts.remove ? (touched ? "removed" : "absent") : "installed" });
  }
  return out;
}
