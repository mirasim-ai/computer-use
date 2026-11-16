/**
 * Timeouts that only work in a fixed relation to one defined somewhere else.
 *
 * The bridge, the extension, the drivers and the native helpers each keep their own constants,
 * and several hold only while another one, in another file and often in another program, is
 * larger, smaller or equal: the extension's wait for the user must end before the bridge gives up
 * on the command that asked, a value copied across an import cycle must stay the copy. Nothing
 * else checks these, so a change to one side passes every suite while the pair stops working.
 *
 * The constants are read from the SOURCE, not imported: most are module-private, and the
 * extension's files are browser scripts that cannot load here. A constant this suite cannot find
 * (renamed, moved, no longer a plain number) fails it: fix the pair's entry below, do not drop it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const root = fileURLToPath(new URL("../", import.meta.url));
const sources = new Map<string, string>();
const source = (file: string): string => {
  if (!sources.has(file)) sources.set(file, readFileSync(root + file, "utf8"));
  return sources.get(file)!;
};

/** A product of plain numbers (`2 * 60_000`), or NaN for anything else. */
function numeric(expr: string): number {
  const factors = expr.split("*").map((f) => f.trim().replace(/_/g, ""));
  return factors.every((f) => /^\d+(\.\d+)?$/.test(f)) ? factors.reduce((n, f) => n * Number(f), 1) : NaN;
}

/** The value of `const NAME = <number>` (TypeScript, JavaScript) or `let NAME = <number>` (Swift)
 *  in one file. A miss is recorded as a failure and answers NaN, which fails every comparison. */
function constant(file: string, name: string): number {
  const m = new RegExp(`^\\s*(?:export |private )?(?:const|let) ${name}(?::\\s*\\w+)? = ([^;\\n]+);?\\s*$`, "m").exec(source(file));
  const value = m ? numeric(m[1]!) : NaN;
  if (Number.isNaN(value)) check(`${name} is a plain number in ${file}`, false, m ? `found \`${m[1]}\`` : "no such constant");
  return value;
}

/** How long a helper client waits after asking its helper to exit before it kills it. */
function killDelay(file: string): number {
  const m = /setTimeout\(\(\) => \{? ?child\.kill\((?:"SIGKILL")?\);? ?\}?, ([\d_]+)\)/.exec(source(file));
  const value = m ? numeric(m[1]!) : NaN;
  if (Number.isNaN(value)) check(`the kill delay is a plain number in ${file}`, false);
  return value;
}

/** The default of a helper client's request timeout: `opts.timeoutMs ?? <number>`. */
function requestTimeout(file: string): number {
  const m = /this\.timeoutMs = opts\.timeoutMs \?\? ([\d_]+);/.exec(source(file));
  const value = m ? numeric(m[1]!) : NaN;
  if (Number.isNaN(value)) check(`the request timeout default is a plain number in ${file}`, false);
  return value;
}

const BRIDGE = "src/platform/browser/bridge";

// ── The bridge and the extension ─────────────────────────────────────────────────────────
{
  const commandTimeout = constant(`${BRIDGE}/server-core.ts`, "EXTENSION_COMMAND_TIMEOUT_MS");
  const askWait = constant("extension/group.js", "ASK_WAIT_MS");
  check("the extension stops waiting for the user's answer before the bridge gives up on the command that asked",
    askWait < commandTimeout, `${askWait} < ${commandTimeout}`);

  const keepalive = constant(`${BRIDGE}/server.ts`, "KEEPALIVE_INTERVAL_MS");
  const silence = constant("extension/relay.js", "SILENCE_TIMEOUT_MS");
  check("the extension calls the bridge dead only after three of its pings went missing",
    silence === 3 * keepalive, `${silence} = 3 × ${keepalive}`);
  const silenceCheck = constant("extension/relay.js", "SILENCE_CHECK_MS");
  check("...and looks for that silence at least once per ping", silenceCheck <= keepalive, `${silenceCheck} ≤ ${keepalive}`);

  const standbyGrace = constant(`${BRIDGE}/server.ts`, "STANDBY_GRACE_MS");
  const backoffFirst = constant("extension/background.js", "BACKOFF_FIRST_MS");
  check("a browser that dropped off redials before a parked one is let in",
    backoffFirst < standbyGrace, `${backoffFirst} < ${standbyGrace}`);

  const firstConnect = constant(`${BRIDGE}/acquire-bridge.ts`, "FIRST_CONNECT_WAIT_MS");
  const backoffMax = constant("extension/background.js", "BACKOFF_MAX_MS");
  const extensionWait = constant(`${BRIDGE}/server-core.ts`, "EXTENSION_WAIT_MS");
  check("a fresh bridge waits out the extension's longest backoff",
    firstConnect > backoffMax, `${firstConnect} > ${backoffMax}`);
  check("...and longer than a client's handshake waits by itself",
    firstConnect > extensionWait, `${firstConnect} > ${extensionWait}`);

  const slowRounds = constant(`${BRIDGE}/server-core.ts`, "SLOW_COMMAND_ROUNDS");
  const runJsMax = constant("src/platform/chromium/run-js.ts", "RUN_JS_MAX_MS");
  check("a command on a tab that still answers may run as long as the longest run_js",
    slowRounds * commandTimeout >= runJsMax, `${slowRounds} × ${commandTimeout} ≥ ${runJsMax}`);

  const slowWarn = constant(`${BRIDGE}/server-core.ts`, "SLOW_CALL_WARN_MS");
  const shot = constant("src/platform/chromium/shot.ts", "SHOT_TIMEOUT_MS");
  const nav = constant("src/platform/browser/navigate.ts", "NAV_TIMEOUT_MS");
  const click = constant("src/platform/chromium/actions.ts", "CLICK_BUDGET_MS");
  check("the bridge logs a slow extension call before the tightest caller gives up on it",
    slowWarn < Math.min(shot, nav, click), `${slowWarn} < min(${shot}, ${nav}, ${click})`);

  check("closing the browser driver waits a whole evidence shot for the journal",
    constant("src/platform/browser/driver.ts", "JOURNAL_DRAIN_MS") > shot);
}

// ── One call, and what ends it ───────────────────────────────────────────────────────────
{
  const BUDGET = "src/platform/tools/repl-budget.ts";
  const runJsMax = constant("src/platform/chromium/run-js.ts", "RUN_JS_MAX_MS");
  const stuckGrace = constant(BUDGET, "STUCK_GRACE_MS");
  check("a call is ended from outside only after the longest verb could have come back",
    stuckGrace >= runJsMax, `${stuckGrace} ≥ ${runJsMax}`);
  check("code that never yields is stopped before the call's own wall clock",
    constant(BUDGET, "SYNC_MAX_MS") < constant(BUDGET, "MAX_MS"));

}

// ── A page still arriving ────────────────────────────────────────────────────────────────
{
  const quiet = constant("src/platform/chromium/page-base.ts", "POST_NAV_QUIET_MS");
  const retry = constant("src/platform/chromium/page-driver.ts", "POST_NAV_RETRY_MS");
  const step = constant("src/platform/chromium/page-driver.ts", "POST_NAV_STEP_MS");
  check("a post-navigation read can see the page hold still within its retry budget", quiet < retry, `${quiet} < ${retry}`);
  check("...in whole steps", quiet % step === 0 && retry % step === 0, `${quiet}, ${retry} in steps of ${step}`);
}

// ── The native helpers ───────────────────────────────────────────────────────────────────
{
  // `abandon()` waits this long on a close; a helper that ignores its exit request is killed
  // inside that wait, so an abandoned native driver leaves no helper behind.
  const abandonClose = constant("src/platform/driver-base.ts", "ABANDON_CLOSE_MS");
  for (const file of ["src/platform/macos/ax-client.ts", "src/platform/windows/uia-client.ts"]) {
    const kill = killDelay(file);
    check(`a helper that will not exit is killed before an abandoned driver stops waiting (${file})`,
      kill < abandonClose, `${kill} < ${abandonClose}`);
  }

  const axTimeout = requestTimeout("src/platform/macos/ax-client.ts");
  check("one slice of a macOS settle wait fits in one helper request",
    constant("src/platform/macos/press-rungs.ts", "SETTLED_SLICE_MS") < axTimeout);

  check("the macOS page-scroll cap is the helper's",
    constant("src/platform/macos/scroll-pages.ts", "MAX_SCROLL_PAGES") === constant("src/platform/macos/ax/ax-scroll.swift", "MAX_SCROLL_PAGES"));

  // Declared twice because importing one into the other would be a runtime cycle.
  check("a macOS write's read-back waits as long as a press's",
    constant("src/platform/macos/act-element.ts", "WRITE_SETTLE_MS") === constant("src/platform/macos/press-rungs.ts", "PRESS_SETTLE_MS"));
  check("...in the same steps",
    constant("src/platform/macos/act-element.ts", "WRITE_SETTLE_STEP_MS") === constant("src/platform/macos/press-rungs.ts", "PRESS_SETTLE_STEP_MS"));

  for (const [platform, file] of [["macOS", "src/platform/macos/click-verb.ts"], ["Windows", "src/platform/windows/driver-yield.ts"]] as const) {
    const quiet = constant(file, "HUMAN_QUIET_MS");
    const wait = constant(file, "HUMAN_WAIT_MS");
    check(`${platform}: the wait for the user to stop is shorter than the quiet time asked of them`,
      wait < quiet, `${wait} < ${quiet}`);
  }
  check("both desktops call the user idle after the same quiet time",
    constant("src/platform/macos/click-verb.ts", "HUMAN_QUIET_MS") === constant("src/platform/windows/driver-yield.ts", "HUMAN_QUIET_MS"));
  check("...and wait for it as long",
    constant("src/platform/macos/click-verb.ts", "HUMAN_WAIT_MS") === constant("src/platform/windows/driver-yield.ts", "HUMAN_WAIT_MS"));

  check("Windows verifies typed and pasted text for the same time",
    constant("src/platform/windows/driver.ts", "INPUT_VERIFY_MS") === constant("src/platform/windows/text-verbs.ts", "VERIFY_MS"));
}

console.log(`\npaired-timeouts: ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
