/** What a model reads before and with its first call: the resident tool description and the API
 * reference. No driver connects, so nothing starts.
 */

import { resolveProfile } from "../src/platform/profile.ts";
import { apiReference, replDescription } from "../src/platform/tools/repl-docs.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Claude Code sends at most 2,048 characters of an MCP tool's description and drops the rest,
// and the last sentence is the one about confirming a message before it is sent.
for (const windowsApps of [false, true]) {
  const d = replDescription(windowsApps);
  check(`the description fits Claude Code's 2048 characters (windows: ${windowsApps})`, d.length <= 2048, String(d.length));
}
check("the description ends on the confirm-before-sending rule", /unless they already approved those exact details\.$/.test(replDescription(false)));

const ref = (driver: string): string => {
  const [d] = resolveProfile({ driver, env: { ...process.env } }).drivers;
  return apiReference(d!, false);
};
const browser = ref("browser");
check("a platform verb's description is given whole, past its first sentence",
  /w\.newTab\(\{url\?\}\) — .*not a handle/.test(browser), browser.match(/w\.newTab.*$/m)?.[0] ?? "");
check("and so are its fields", /toRef\?: /.test(browser) && /confirmed\?: /.test(browser));
check("unloaded tabs are a browser matter only", /unloaded:true/.test(browser) && !/unloaded:true/.test(ref("macos")) && !/unloaded:true/.test(ref("electron")));
check("page() is offered for web pages only", /web pages: w\.openUrl\(\{url\}\), w\.page/.test(replDescription(false)) && !/w\.page\(/.test(ref("macos")));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
