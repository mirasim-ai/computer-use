/**
 * Where computer-use keeps its state: `COMPUTER_USE_HOME`, else `~/.mirasim-computer-use`.
 * Everything this process writes for itself (managed profile, `run/<slug>/` slots, "always
 * allow" lists, the bridge's socket and logs, helper caches, downloads) lives under it, so a
 * host keeps its sessions apart by naming ONE directory.
 *
 * {@link sharedHome} is the exception: the default home whatever a host set, for state every
 * process on the machine must agree on — the ownership database (one arbiter per OS user), the
 * native-messaging host records (one wrapper per host name) and the browser's download staging
 * (Chrome keeps it process-wide). README → Install lists the same three.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The state directory this process uses. */
export function computerUseHome(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.COMPUTER_USE_HOME?.trim();
  return custom ? resolve(custom) : sharedHome();
}

/** The default home — also where machine-wide state lives when a host moved the rest. */
export function sharedHome(): string {
  return join(homedir(), ".mirasim-computer-use");
}
