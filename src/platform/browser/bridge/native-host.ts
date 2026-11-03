/**
 * Puts "Chrome can start the bridge's native-messaging host" on the machine: one wrapper and one
 * manifest per Chromium-family browser.
 *
 * **The host name is shared.** The store extension knows exactly two names
 * (`extension/background.js` `HOST_CANDIDATES`), and every program that runs this bridge (mirasim,
 * which bundles computer-use, and a standalone computer-use) registers under the SAME one; a
 * manifest per installer would let the last writer win. So each installer only records itself
 * (`hosts/<owner>.json` under {@link nativeHostRoot}, in {@link sharedHome}, the one place every
 * process on the machine agrees on), and the wrapper and manifests are rewritten from ALL records:
 *
 *  - the wrapper tries the records in priority order and runs the first program still on disk;
 *  - that program's `bridge-host` dials every recorded socket in the same order and pipes into the
 *    first that answers — so whichever bridge is running gets the extension, whoever installed it.
 *
 * Every installer keeps two disciplines:
 *
 *  - **A stable wrapper path, never a versioned one**: a manifest in the user's browser outlives
 *    any one release. The wrapper checks each record's program exists, so a removed one is skipped.
 *  - **Only browsers that exist get a manifest**. A browser installed later is covered by the next
 *    install, which is why the bridge re-runs it (`entries/commands/bridge.ts`).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computerUseHome, sharedHome } from "../../home.ts";

/** The name the store extension dials first; a development instance uses `<this>.dev`. */
export const NATIVE_HOST_NAME = "ai.mirasim.browser_bridge";

/** One installer's record: everything the wrapper needs to run IT, and to reach ITS bridge. */
export interface NativeHostEntry {
  /** Who registered — one record per owner per host name (`mirasim`, `mirasim-cu`). */
  owner: string;
  /** argv prefix that runs computer-use; `bridge-host --socket …` is appended. Absolute paths. */
  command: string[];
  /** The socket (Windows: named pipe) this owner's bridge listens on. */
  socket: string;
  /** Lower is tried first — both for which program runs the host and which socket it dials. */
  priority: number;
  extensionIds: string[];
  /** NativeMessagingHosts folders beyond the browser table (a browser run on a custom
   *  `--user-data-dir` reads its manifest from there). */
  manifestDirs: string[];
  /** PATH for the command. Chrome gives the host CHROME's environment, not a login shell's: an
   *  `#!/usr/bin/env node` launcher dies before any of our code runs, with no log line anywhere. */
  path?: string;
}

export interface NativeHostResult {
  name: string;
  wrapper: string;
  manifests: string[];
  owners: string[];
}

/**
 * Each Chromium-family browser's manifest folder, relative to HOME. A manifest serves ONE browser:
 * Chrome reads only its own folder, Edge only Edge's — an extension installed in Brave with the
 * manifest written only for Chrome gets "host not found" while everything looks installed. The
 * table is the union of two shipping installers (OpenAI's `installManifest.mjs`, Claude Code's).
 */
const MANIFEST_DIRS: Record<"darwin" | "linux", string[]> = {
  darwin: [
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    "Library/Application Support/Google/Chrome Beta/NativeMessagingHosts",
    "Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts",
    "Library/Application Support/Chromium/NativeMessagingHosts",
    "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
    "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    "Library/Application Support/Vivaldi/NativeMessagingHosts",
    "Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts",
    "Library/Application Support/Arc/User Data/NativeMessagingHosts",
  ],
  linux: [
    ".config/google-chrome/NativeMessagingHosts",
    ".config/google-chrome-beta/NativeMessagingHosts",
    ".config/google-chrome-unstable/NativeMessagingHosts",
    ".config/google-chrome-for-testing/NativeMessagingHosts",
    ".config/chromium/NativeMessagingHosts",
    ".config/microsoft-edge/NativeMessagingHosts",
    ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    ".config/vivaldi/NativeMessagingHosts",
    ".config/opera/NativeMessagingHosts",
  ],
};

/** On Windows the manifest is one file plus a registry key per browser pointing at it. Keys from
 *  Claude Code's installer; OpenAI writes only Chrome's, which misses Edge users. */
const WINDOWS_REGISTRY_ROOTS = [
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
  "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
  "HKCU\\Software\\Chromium\\NativeMessagingHosts",
  "HKCU\\Software\\Vivaldi\\NativeMessagingHosts",
  "HKCU\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts",
];

/** Where one host name's wrapper and records live. */
function nativeHostRoot(hostName = NATIVE_HOST_NAME): string {
  return path.join(sharedHome(), "native-host", hostName);
}

/** The socket a bridge run without a host listens on (a host names its own). */
export function defaultBridgeSocket(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\mirasim-computer-use-bridge";
  return path.join(computerUseHome(env), "bridge.sock");
}

/** How to run THIS computer-use again: the node that runs us plus the script we were started as.
 *  A host that launches us some other way (e.g. a bundle under Electron) passes its own. */
export function defaultHostCommand(): string[] {
  const script = process.argv[1];
  if (!script) throw new Error("cannot tell how this computer-use was started; pass --host-command");
  return [process.execPath, fs.realpathSync(script)];
}

/** Record `entry` and rewrite the wrapper and manifests from every record. Idempotent: an
 *  unchanged file is not written, so a periodic re-run never touches the browsers' folders. */
export function installNativeHost(entry: NativeHostEntry, hostName = NATIVE_HOST_NAME): NativeHostResult {
  checkName(hostName);
  checkOwner(entry.owner);
  if (!entry.command.length || entry.command.some((part) => !path.isAbsolute(part))) {
    throw new Error(`the host command must be absolute paths: ${JSON.stringify(entry.command)}`);
  }
  const ids = [...new Set(entry.extensionIds)];
  if (!ids.length || ids.some((id) => !/^[a-p]{32}$/.test(id))) throw new Error("Invalid Mirasim extension identity.");
  const record = `${JSON.stringify({ ...entry, extensionIds: ids }, null, 2)}\n`;
  writeIfChanged(path.join(nativeHostRoot(hostName), "hosts", `${entry.owner}.json`), record);
  return publish(hostName, readEntries(hostName), []);
}

/**
 * Take `owner`'s record back. The manifests stay while another installer is recorded — they are
 * its route too — and are rewritten without this one; the last record out removes them, the
 * wrapper and the registry keys, so no manifest is left naming a program nobody runs.
 */
export function removeNativeHost(owner: string, hostName = NATIVE_HOST_NAME, extraDirs: string[] = []): NativeHostResult {
  checkName(hostName);
  checkOwner(owner);
  const file = path.join(nativeHostRoot(hostName), "hosts", `${owner}.json`);
  const gone = readEntry(file);
  fs.rmSync(file, { force: true });
  const dropped = [...extraDirs, ...(gone?.manifestDirs ?? [])];
  const rest = readEntries(hostName);
  if (rest.length) return publish(hostName, rest, dropped);
  const removed: string[] = [];
  for (const dir of existing([...browserDirs(), ...dropped])) {
    const manifest = path.join(dir, `${hostName}.json`);
    if (fs.existsSync(manifest)) removed.push(manifest);
    fs.rmSync(manifest, { force: true });
  }
  fs.rmSync(wrapperPath(hostName), { force: true });
  if (process.platform === "win32") {
    fs.rmSync(windowsManifestPath(hostName), { force: true });
    for (const root of WINDOWS_REGISTRY_ROOTS) {
      try {
        execFileSync("reg", ["delete", `${root}\\${hostName}`, "/f"], { stdio: "ignore", windowsHide: true });
      } catch {
        /* never registered there */
      }
    }
  }
  return { name: hostName, wrapper: wrapperPath(hostName), manifests: removed, owners: [] };
}

/** Write the wrapper and every manifest for `entries`; `dropped` folders lose theirs unless an
 *  entry still lists them. */
function publish(hostName: string, entries: NativeHostEntry[], dropped: string[]): NativeHostResult {
  const wrapper = wrapperPath(hostName);
  writeIfChanged(wrapper, process.platform === "win32" ? windowsWrapper(entries) : posixWrapper(entries), 0o700);

  const ids = [...new Set(entries.flatMap((e) => e.extensionIds))];
  const manifest = `${JSON.stringify({
    name: hostName,
    description: "Mirasim browser bridge (computer-use)",
    path: wrapper,
    type: "stdio",
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  }, null, 2)}\n`;
  const extra = [...new Set(entries.flatMap((e) => e.manifestDirs))];
  const written: string[] = [];
  if (process.platform === "win32") {
    const file = windowsManifestPath(hostName);
    writeIfChanged(file, manifest);
    written.push(file);
    registerWindows(hostName, file);
  } else {
    const dirs = browserDirs();
    for (const dir of existing([...dirs, ...extra])) {
      const file = path.join(dir, `${hostName}.json`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        writeIfChanged(file, manifest);
        written.push(file);
      } catch {
        // A folder we cannot write: skip this browser, the others still get theirs.
      }
    }
    // A folder only the removed record named; the browser table and the others' folders stay.
    for (const dir of existing(dropped.filter((d) => !extra.includes(d) && !dirs.includes(d)))) {
      fs.rmSync(path.join(dir, `${hostName}.json`), { force: true });
    }
  }
  return { name: hostName, wrapper, manifests: written, owners: entries.map((e) => e.owner) };
}

/** Every recorded bridge, in the order the wrapper tries them — who else may hold the extension. */
export function recordedBridges(hostName = NATIVE_HOST_NAME): Array<{ owner: string; socket: string }> {
  return readEntries(hostName).map((e) => ({ owner: e.owner, socket: e.socket }));
}

/** The records, in the order the wrapper tries them. A record that does not parse is skipped. */
function readEntries(hostName: string): NativeHostEntry[] {
  const dir = path.join(nativeHostRoot(hostName), "hosts");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => readEntry(path.join(dir, n)))
    .filter((e): e is NativeHostEntry => e !== null)
    .sort((a, b) => a.priority - b.priority || a.owner.localeCompare(b.owner));
}

function readEntry(file: string): NativeHostEntry | null {
  try {
    const e = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<NativeHostEntry>;
    if (typeof e.owner !== "string" || !Array.isArray(e.command) || typeof e.socket !== "string") return null;
    return {
      owner: e.owner,
      command: e.command.filter((p): p is string => typeof p === "string"),
      socket: e.socket,
      priority: typeof e.priority === "number" ? e.priority : 100,
      extensionIds: Array.isArray(e.extensionIds) ? e.extensionIds.filter((id): id is string => typeof id === "string") : [],
      manifestDirs: Array.isArray(e.manifestDirs) ? e.manifestDirs.filter((d): d is string => typeof d === "string") : [],
      ...(typeof e.path === "string" ? { path: e.path } : {}),
    };
  } catch {
    return null;
  }
}

/** Every browser's manifest folder on this platform. Linux honours `XDG_CONFIG_HOME`. */
function browserDirs(): string[] {
  const home = os.homedir();
  const table = process.platform === "darwin" ? MANIFEST_DIRS.darwin : process.platform === "linux" ? MANIFEST_DIRS.linux : [];
  const configHome = process.env.XDG_CONFIG_HOME?.trim();
  return table.map((rel) => {
    if (process.platform === "linux" && configHome && rel.startsWith(".config/")) {
      return path.join(configHome, rel.slice(".config/".length));
    }
    return path.join(home, rel);
  });
}

/** The folders whose browser folder EXISTS: never conjure a Vivaldi profile folder on a machine
 *  without Vivaldi. */
function existing(dirs: string[]): string[] {
  return [...new Set(dirs)].filter((dir) => {
    try {
      return fs.statSync(path.dirname(dir)).isDirectory();
    } catch {
      return false;
    }
  });
}

function wrapperPath(hostName: string): string {
  return path.join(nativeHostRoot(hostName), process.platform === "win32" ? "chrome-native-host.bat" : "chrome-native-host");
}

function windowsManifestPath(hostName: string): string {
  return path.join(nativeHostRoot(hostName), `${hostName}.json`);
}

/** Every recorded socket, in priority order: the host pipes into the first that answers. */
function socketArgs(entries: NativeHostEntry[], quote: (s: string) => string): string {
  return entries.map((e) => `--socket ${quote(e.socket)}`).join(" ");
}

function posixWrapper(entries: NativeHostEntry[]): string {
  const sockets = socketArgs(entries, shellQuote);
  const lines = [
    "#!/bin/sh",
    "# Chrome native messaging host for the Mirasim browser extension (computer-use's bridge).",
    "# Generated by mirasim-cu from the records next to this file — do not edit; every",
    "# installer rewrites it.",
    "#",
    "# Each block is one installed computer-use, in priority order: the first whose program is",
    "# still on disk runs the host, which dials every recorded bridge socket in the same order.",
    "# CHROME starts this, with CHROME's environment, so each block brings the PATH its program",
    "# was installed with.",
  ];
  for (const e of entries) {
    const checks = e.command.map((part, i) => `[ ${i === 0 ? "-x" : "-e"} ${shellQuote(part)} ]`).join(" && ");
    lines.push(
      `# ${e.owner}`,
      `if ${checks}; then`,
      ...(e.path ? [`  PATH=${shellQuote(e.path)}`, "  export PATH"] : []),
      `  exec ${e.command.map(shellQuote).join(" ")} bridge-host ${sockets} "$@"`,
      "fi",
    );
  }
  lines.push("exit 1", "");
  return lines.join("\n");
}

/**
 * The `.bat` twin — no shebang there. Every argument carries its own quotes, and `%` is written
 * `%%` (cmd expands `%…%` inside quotes too, so a path containing `%` would be quietly rewritten).
 *
 * ⚠️ Not run on a real Windows machine yet; the shape follows Claude Code's installer.
 */
function windowsWrapper(entries: NativeHostEntry[]): string {
  const quote = (value: string): string => `"${value.replaceAll("%", "%%")}"`;
  const sockets = socketArgs(entries, quote);
  const lines = [
    "@echo off",
    "REM Chrome native messaging host for the Mirasim browser extension (computer-use's bridge).",
    "REM Generated by mirasim-cu - do not edit; every installer rewrites it.",
  ];
  entries.forEach((e, i) => {
    lines.push(`REM ${e.owner}`);
    for (const part of e.command) lines.push(`if not exist ${quote(part)} goto next${i}`);
    lines.push(`${e.command.map(quote).join(" ")} bridge-host ${sockets} %*`, "exit /b", `:next${i}`);
  });
  lines.push("exit /b 1", "");
  return lines.join("\r\n");
}

/** `reg add` rather than a registry library: `reg.exe` ships with Windows. A browser that is not
 *  installed, or a key that cannot be written, is skipped. ⚠️ Not run on a real Windows machine. */
function registerWindows(hostName: string, manifestPath: string): void {
  for (const root of WINDOWS_REGISTRY_ROOTS) {
    try {
      execFileSync("reg", ["add", `${root}\\${hostName}`, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* next browser */
    }
  }
}

/** Write only when the content changed, via a rename so Chrome never reads half a file — or runs
 *  a wrapper that is not executable yet. */
function writeIfChanged(file: string, content: string, mode?: number): void {
  try {
    if (fs.readFileSync(file, "utf8") === content) return;
  } catch {
    /* missing: write it */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  if (mode !== undefined && process.platform !== "win32") fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** The wrapper is `/bin/sh`: a path with a space or a quote must not split. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Chrome's rule for host names: lowercase alphanumerics, `_` and `.`. */
function checkName(hostName: string): void {
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(hostName)) throw new Error(`invalid native host name: ${hostName}`);
}

/** The owner becomes a file name. */
function checkOwner(owner: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || owner.startsWith(".")) throw new Error(`invalid native host owner: ${owner}`);
}
