/**
 * The native-host flags `bridge --native-host` and `setup extension` share — one spelling, one
 * record shape (`platform/browser/bridge/native-host.ts`).
 */
import {
  defaultHostCommand,
  NATIVE_HOST_NAME,
  type NativeHostEntry,
} from "../../platform/browser/bridge/native-host.ts";

export const NATIVE_HOST_USAGE = `  --host-name N      native host name (default ${NATIVE_HOST_NAME})
  --owner O          whose record this is (default mirasim-cu); one record per owner
  --priority N       lower is tried first when several programs are recorded (default 100;
                     a negative one is written --priority=-1)
  --host-command C   the program Chrome should run, absolute; repeat for an interpreter + script
                     (default: the node and script running this command)
  --manifest-dir D   one more NativeMessagingHosts folder (a browser on a custom --user-data-dir)`;

export const NATIVE_HOST_OPTIONS = {
  "host-name": { type: "string" },
  owner: { type: "string" },
  priority: { type: "string" },
  "host-command": { type: "string", multiple: true },
  "manifest-dir": { type: "string", multiple: true },
} as const;

export interface NativeHostFlags {
  "host-name"?: string;
  owner?: string;
  priority?: string;
  "host-command"?: string[];
  "manifest-dir"?: string[];
}

export function hostName(flags: NativeHostFlags): string {
  return flags["host-name"] ?? NATIVE_HOST_NAME;
}

export function hostOwner(flags: NativeHostFlags): string {
  return flags.owner ?? "mirasim-cu";
}

/** This process's record, for the bridge listening on `socket`. */
export function hostEntry(flags: NativeHostFlags, socket: string, extensionIds: string[]): NativeHostEntry {
  const priority = flags.priority === undefined ? 100 : Number(flags.priority);
  if (!Number.isFinite(priority)) throw new Error(`--priority must be a number: ${flags.priority}`);
  return {
    owner: hostOwner(flags),
    command: flags["host-command"]?.length ? flags["host-command"] : defaultHostCommand(),
    socket,
    priority,
    extensionIds,
    manifestDirs: flags["manifest-dir"] ?? [],
    ...(process.platform === "win32" ? {} : { path: process.env.PATH ?? "/usr/bin:/bin" }),
  };
}
