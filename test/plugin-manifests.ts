/**
 * The Claude Code / Codex plugin stays in step with the package — `node scripts/test.mjs plugin-manifests`.
 *
 * Hermetic: reads the manifests in the repository, nothing else.
 *
 *   · both plugin manifests carry package.json's version, and the bundled MCP server runs exactly
 *     that version from npm (a plugin pinned to an older one would describe tools it does not have);
 *   · the plugin's copy of the agent skill is the shipped one;
 *   · each marketplace lists the plugin under its manifest name, from its folder.
 * `node scripts/sync-plugin.mjs` fixes the first two after a version bump.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const json = (p: string) => JSON.parse(read(p));
const pkg = json("package.json");
const spec = `${pkg.name}@${pkg.version}`;
const dir = "plugins/mirasim-computer-use";
const claude = json(`${dir}/.claude-plugin/plugin.json`);
const portable = json(`${dir}/plugin.json`);
const mcp = json(`${dir}/mcp.json`);
const fix = "run node scripts/sync-plugin.mjs";

check("the Claude Code manifest has package.json's version", claude.version === pkg.version, `${claude.version} vs ${pkg.version}; ${fix}`);
check("the portable (Codex) manifest has package.json's version", portable.version === pkg.version, `${portable.version} vs ${pkg.version}; ${fix}`);
check("Claude Code's bundled server runs that exact npm version",
  JSON.stringify(claude.mcpServers?.["mirasim-cu"]?.args) === JSON.stringify(["-y", spec, "mcp"]), `${JSON.stringify(claude.mcpServers?.["mirasim-cu"]?.args)}; ${fix}`);
check("Codex's bundled server runs that exact npm version",
  JSON.stringify(mcp.mcpServers?.["mirasim-cu"]?.args) === JSON.stringify(["-y", spec, "mcp"]), `${JSON.stringify(mcp.mcpServers?.["mirasim-cu"]?.args)}; ${fix}`);
check("Codex's bundled server says it is a local (stdio) one", mcp.mcpServers?.["mirasim-cu"]?.type === "stdio");
check("the plugin's skill is the shipped skill",
  read(`${dir}/skills/mirasim-computer-use/SKILL.md`) === read("skills/mirasim-computer-use/SKILL.md"), fix);
check("both manifests name the plugin the same", claude.name === "mirasim-computer-use" && portable.name === claude.name);

const claudeMarket = json(".claude-plugin/marketplace.json");
const codexMarket = json(".agents/plugins/marketplace.json");
const ce = claudeMarket.plugins?.find((p: { name: string }) => p.name === claude.name);
const xe = codexMarket.plugins?.find((p: { name: string }) => p.name === claude.name);
check("the Claude Code marketplace lists it from its folder", ce?.source === `./${dir}`, JSON.stringify(ce?.source));
check("the Codex marketplace lists it from its folder", xe?.source?.source === "local" && xe?.source?.path === `./${dir}`, JSON.stringify(xe?.source));

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall passed");
