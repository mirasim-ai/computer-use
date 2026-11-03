/**
 * Hand the keyboard back when the browser takes it.
 *
 * macOS gives the keyboard to the FRONTMOST APPLICATION regardless of window position, so a
 * parked browser that activates (Chrome does whenever a page opens a real window) takes the
 * user's typing into a window they cannot see.
 *
 * Not opening one is the fix (KEEP_IN_TAB_JS); this is the net under it, for what a page script
 * cannot close — a `window.open()` with no URL, a popup with window features that survives, a
 * native picker. It runs only after we SAW a window appear, so other actions pay nothing.
 *
 * macOS only: `lsappinfo` is the whole focus API available without a native dependency. Every
 * step is best-effort and silent — it must never fail an action.
 */
import { execFile } from "node:child_process";

/** One `lsappinfo` call, bounded. Null on any failure — the caller then does nothing. */
function lsappinfo(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/lsappinfo", args, { timeout: 700 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function pidOf(asn: string): Promise<number | null> {
  const out = await lsappinfo(["info", "-only", "pid", asn]);
  const pid = Number(out?.match(/"pid"\s*=\s*(\d+)/)?.[1]);
  return Number.isFinite(pid) ? pid : null;
}

/** Is `browserPid` the frontmost application right now? ~3 ms; read BEFORE an action so a raise
 *  the user made is never mistaken for the page's. Unknown reads as "not frontmost", which only
 *  costs an extra check afterwards. */
export async function isFrontmost(browserPid: number | null): Promise<boolean> {
  if (process.platform !== "darwin" || !browserPid) return false;
  const front = (await lsappinfo(["front"]))?.trim().replace(/:$/, "");
  return !!front && (await pidOf(front)) === browserPid;
}

/**
 * Give the keyboard back to whoever had it, if `browserPid` took it.
 *
 * `visibleProcessList` is front-to-back, so the app to restore is the first entry that is not
 * our browser. If the frontmost app is NOT ours, this touches nothing.
 */
export async function returnFocusIfTaken(browserPid: number | null): Promise<void> {
  if (process.platform !== "darwin" || !browserPid) return;
  const list = await lsappinfo(["visibleProcessList"]);
  const asns = list?.match(/ASN:[^\s:"]*(?:-"[^"]*")?/g)?.map((a) => a.replace(/-"[^"]*"$/, "")) ?? [];
  if (asns.length < 2) return;
  if ((await pidOf(asns[0]!)) !== browserPid) return; // not us in front — leave the user alone
  for (const asn of asns.slice(1)) {
    if ((await pidOf(asn)) === browserPid) continue; // another window of the same browser
    const bundle = (await lsappinfo(["info", "-only", "bundleID", asn]))
      ?.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1];
    if (!bundle) return;
    await new Promise<void>((resolve) => {
      execFile("/usr/bin/open", ["-b", bundle], { timeout: 1500 }, () => resolve());
    });
    return;
  }
}
