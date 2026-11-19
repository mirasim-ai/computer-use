// Keep the Claude Code / Codex plugin in plugins/mirasim-computer-use in step with the package:
// the version in both manifests, the exact npm version the bundled MCP server runs, and the agent
// skill (a copy of skills/mirasim-computer-use, since a plugin may not reach outside its folder).
// Run after bumping package.json; test/plugin-manifests.ts fails until it has been run.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "plugins", "mirasim-computer-use");
const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const spec = `${name}@${version}`;

const edit = (file, fn) => {
  const path = join(plugin, file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  fn(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
};
edit(".claude-plugin/plugin.json", (m) => {
  m.version = version;
  m.mcpServers["mirasim-cu"].args = ["-y", spec, "mcp"];
});
edit("plugin.json", (m) => { m.version = version; });
edit("mcp.json", (m) => { m.mcpServers["mirasim-cu"].args = ["-y", spec, "mcp"]; });
copyFileSync(join(root, "skills", "mirasim-computer-use", "SKILL.md"), join(plugin, "skills", "mirasim-computer-use", "SKILL.md"));
console.log(`plugins/mirasim-computer-use → ${spec}`);
