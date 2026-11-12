/** Native Windows apps are not part of this release: the `windows` platform is refused, and the
 * tool's own text does not name it, unless the host opts in (registry.ts `windowsAppsOptedIn`).
 * No helper process, no desktop: drivers connect lazily, so mounting one starts nothing.
 */

import { resolveProfile } from "../src/platform/profile.ts";
import { createDriver, windowsAppsOptedIn } from "../src/platform/registry.ts";
import { apiReference, platformReference } from "../src/platform/tools/repl-docs.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const thrown = (run: () => unknown): string => {
  try { run(); return ""; } catch (e) { return (e as Error).message; }
};
/** Everything the model is told about the tools before the first call. */
const toolText = (driver: string, env: NodeJS.ProcessEnv): string =>
  JSON.stringify(resolveProfile({ driver, env }).tools.map((t) => [t.description, t.parameters]));

const plain: NodeJS.ProcessEnv = { ...process.env };
delete plain.COMPUTER_USE_UNSUPPORTED_WINDOWS;
const opted: NodeJS.ProcessEnv = { ...plain, COMPUTER_USE_UNSUPPORTED_WINDOWS: "1" };

check("the switch is exactly \"1\"", !windowsAppsOptedIn(plain) && windowsAppsOptedIn(opted)
  && !windowsAppsOptedIn({ ...plain, COMPUTER_USE_UNSUPPORTED_WINDOWS: "true" }));

const refused = thrown(() => createDriver("windows", { env: plain }));
check("a session that names windows is refused, told what it can mount instead",
  /not part of this release/.test(refused) && /available: browser, electron, macos;/.test(refused), refused);
const viaProfile = thrown(() => resolveProfile({ driver: "browser,windows", env: plain }));
check("the refusal reaches a session that lists it among others", /not part of this release/.test(viaProfile), viaProfile);
const unknown = thrown(() => createDriver("linux", { env: plain }));
check("an unknown platform's error does not offer windows", /unknown driver "linux"/.test(unknown) && !/windows/.test(unknown), unknown);

check("a host that opted in mounts it", createDriver("windows", { env: opted }).platform === "windows");
const unknownOpted = thrown(() => createDriver("linux", { env: opted }));
check("and is offered it by name", /available: browser, electron, macos, windows/.test(unknownOpted), unknownOpted);

const told = toolText("browser,macos", plain);
check("the tool text names no Windows surface where none is mounted", /native macOS apps/.test(told) && !/Windows|"windows"/.test(told),
  told.match(/.{40}Windows.{40}/i)?.[0] ?? "");
const toldOpted = toolText("browser,windows", opted);
check("and names it where one is", /native macOS \/ Windows apps/.test(toldOpted) && /Windows: limited UIA/.test(toldOpted) && /\\"windows\\"/.test(toldOpted));

// The API reference a session gets with its first result, per mounted platform.
const refs = (driver: string, env: NodeJS.ProcessEnv, windowsApps: boolean): string =>
  resolveProfile({ driver, env }).drivers.map((d) => apiReference(d, windowsApps) + platformReference(d, windowsApps)).join("\n");
const ref = refs("browser,macos", plain, false);
check("the API reference says nothing of Windows where none is mounted", /\.png on macOS\)/.test(ref) && !/Windows/.test(ref),
  ref.match(/.{40}Windows.{40}/)?.[0] ?? "");
const refOpted = refs("browser,windows", opted, true);
check("and keeps what it said where one is", /\.png on macOS and Windows\)/.test(refOpted) && /Windows refuses a region/.test(refOpted) && /Untitled - Notepad/.test(refOpted));
check("a Windows driver's own reference says it unasked", /Windows refuses a region/.test(apiReference(createDriver("windows", { env: opted }))));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
