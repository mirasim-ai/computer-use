/** Hermetic coverage of the Windows per-app consent — no helper process, no desktop. A canned
 * transport answers the helper's protocol (`windows`, `apps`, `appinfo`, `launch`, …) and records
 * the order of the calls, because the order is the point: the user is asked about an app BEFORE
 * it is started.
 *
 * What the real helper answers on a real desktop (which program a Start-menu entry runs, how
 * long a Store app takes to attach to its frame) is `windows-live`'s to show, not this suite's.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { approvalsAddCommand } from "../src/platform/cli-command.ts";
import { WindowsDriver } from "../src/platform/windows/driver.ts";
import { launchConsent } from "../src/platform/windows/launch.ts";
import { UiaRequestError, type UiaTransport } from "../src/platform/windows/uia-client.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Row { hwnd: number; pid: number; process: string; title: string; class: string; rect: { x: number; y: number; w: number; h: number }; minimized: boolean; foreground: boolean }
const row = (hwnd: number, process: string, title: string, extra: Partial<Row> = {}): Row =>
  ({ hwnd, pid: hwnd + 1000, process, title, class: "W", rect: { x: 0, y: 0, w: 800, h: 600 }, minimized: false, foreground: false, ...extra });

const START_MENU = [
  { name: "计算器", id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
  { name: "Some Tool", id: "{6D809377-6AF0-444B-8957-A3773F02200E}\\Some\\launcher.lnk" },
];

interface Stub {
  transport: UiaTransport;
  /** Every helper op and every question, in the order they happened. */
  log: string[];
  rows: Row[];
  /** What `appinfo` says each Start-menu entry runs; absent = it cannot tell (`exe: null`). */
  exe: Record<string, string>;
  /** A helper that predates `appinfo`. */
  oldHelper: boolean;
  /** The window a `launch` opens, and how many `windows` reads still show it as the bare frame. */
  opens: { row: Row; frameReads: number } | null;
  /** Seconds since the user last touched the keyboard or pointer. */
  idle: () => number;
}

function stub(): Stub {
  const s: Stub = {
    log: [], rows: [row(1, "explorer", "Documents")], exe: {}, oldHelper: false, opens: null, idle: () => 60,
    transport: {
      async request(op, params = {}) {
        s.log.push(op);
        const entry = START_MENU.find((a) => [a.name.toLowerCase(), a.id.toLowerCase()].includes(String(params.app ?? "").toLowerCase()));
        switch (op) {
          case "windows": {
            const opened = s.opens && s.rows.find((r) => r.hwnd === s.opens!.row.hwnd);
            if (opened && s.opens!.frameReads-- <= 0) opened.process = s.opens!.row.process;
            return { windows: s.rows.map((r) => ({ ...r })) };
          }
          case "apps": return { apps: START_MENU };
          case "appinfo":
            if (s.oldHelper) throw new UiaRequestError("unknown_op", "unknown op 'appinfo'");
            return entry ? { name: entry.name, id: entry.id, via: "start_menu", exe: s.exe[entry.name] ?? null } : { name: params.app, via: "shell", exe: params.app };
          case "launch":
            if (s.opens) s.rows.push({ ...s.opens.row, process: s.opens.frameReads > 0 ? "ApplicationFrameHost" : s.opens.row.process });
            return { name: entry?.name ?? params.app, via: entry ? "start_menu" : "shell", pid: 0 };
          case "humanidle": return { seconds: s.idle(), listening: true };
          case "foreground": return { hwnd: 1, pid: 1001, process: "explorer", title: "Documents" };
          default: throw new UiaRequestError("unknown_op", `unknown op '${op}'`);
        }
      },
      async close() {},
    },
  };
  return s;
}

type Persist = "session" | "always" | undefined;
function asker(s: Stub, answer: () => { allowed: boolean; persist?: Persist }) {
  const asked: Array<{ message: string; app: string; launch: boolean }> = [];
  let revoke: (ids: string[]) => void = () => {};
  let answeredAt = 0;
  return {
    asked,
    revoke: (ids: string[]) => revoke(ids),
    answeredAt: () => answeredAt,
    consent: {
      available: () => true,
      ask: async (message: string, meta: Record<string, unknown>) => {
        const m = meta["mirasim-computer-use/windowsApp"] as { app: string; launch?: boolean };
        asked.push({ message, app: m.app, launch: m.launch === true });
        s.log.push(`ask:${m.app}`);
        answeredAt = Date.now();
        const a = answer();
        return { allowed: a.allowed, ...(a.persist ? { persist: a.persist } : {}) };
      },
      onRevoke: (cb: (ids: string[]) => void) => { revoke = cb; },
    },
  };
}

const storeFile = () => join(mkdtempSync(join(tmpdir(), "computer-use-win-approvals-")), "approvals.json");
const CALC = `app:${START_MENU[0]!.id}`;
const calcRow = () => row(7, "CalculatorApp", "计算器", { class: "ApplicationFrameWindow" });
const thrown = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

async function main() {
  // ── Asked before the app is started; a no starts nothing ─────────────────────────────────
  {
    const s = stub();
    s.exe["计算器"] = "CalculatorApp";
    s.opens = { row: calcRow(), frameReads: 0 };
    let allowed = false;
    const a = asker(s, () => ({ allowed, persist: "session" }));
    const drv = new WindowsDriver({ interaction: "desktop", transport: s.transport, consent: a.consent, env: { COMPUTER_USE_WINDOWS_APPROVALS: storeFile() } });

    const refused = await thrown(drv.focusTarget(CALC));
    check("a declined app is never started", a.asked.length === 1 && !s.log.includes("launch"), s.log.join(" "));
    check("...and the refusal says so, with the way to allow it ahead of time",
      /permission to use CalculatorApp was not granted/.test(refused) && /approvals add CalculatorApp/.test(refused) && /Nothing was started/.test(refused), refused);
    check("the question is about the app's own program, says it will be started, and shows its Start-menu name",
      a.asked[0]!.message === 'Allow Computer Use to start, see and control CalculatorApp ("计算器")?' && a.asked[0]!.launch, a.asked[0]!.message);

    allowed = true;
    const bound = await drv.focusTarget(CALC);
    check("an allowed app is started only after the answer", bound.ok && s.log.indexOf("launch") > s.log.lastIndexOf("ask:CalculatorApp"), s.log.join(" "));
    check("...and its window is not asked about a second time", a.asked.length === 2, a.asked.map((q) => q.app).join());
  }

  // ── Allowed ahead of time under the executable's name: starts with no question ───────────
  {
    const s = stub();
    s.exe["计算器"] = "CalculatorApp";
    s.opens = { row: calcRow(), frameReads: 0 };
    const file = storeFile();
    writeFileSync(file, JSON.stringify({ approvedApps: ["calculatorapp"] }));
    const a = asker(s, () => ({ allowed: false }));
    const drv = new WindowsDriver({ interaction: "desktop", transport: s.transport, consent: a.consent, env: { COMPUTER_USE_WINDOWS_APPROVALS: file } });
    const bound = await drv.focusTarget(CALC);
    check("`approvals add CalculatorApp` covers the launch and the window: no question at all", bound.ok && a.asked.length === 0, `${bound.note} | asked ${a.asked.length}`);
  }

  // ── An entry whose program cannot be told ahead: asked by its Start-menu name, once ───────
  {
    const s = stub();
    s.opens = { row: row(11, "sometool64", "Some Tool — Untitled"), frameReads: 0 };
    const file = storeFile();
    let persist: Persist = "always";
    const a = asker(s, () => ({ allowed: true, persist }));
    const drv = new WindowsDriver({ interaction: "desktop", transport: s.transport, consent: a.consent, env: { COMPUTER_USE_WINDOWS_APPROVALS: file } });
    const tool = `app:${START_MENU[1]!.id}`;
    const bound = await drv.focusTarget(tool);
    check("the launch is asked about by the Start-menu name, and the window it opens is covered by that answer",
      bound.ok && a.asked.length === 1 && a.asked[0]!.message === "Allow Computer Use to start, see and control Some Tool?", a.asked.map((q) => q.message).join(" | "));
    check("...while only the name the user was asked about is written to disk", readFileSync(file, "utf8").includes("some tool") && !readFileSync(file, "utf8").includes("sometool64"), readFileSync(file, "utf8").trim());
    check("the session may go on using that window's program", (await drv.listTargets()).some((t) => /Some Tool — Untitled — sometool64/.test(t.title)));
    a.revoke(["Some Tool"]);
    check("taking the asked-about name back takes the program it ran as back too",
      (await drv.listTargets()).some((t) => /^sometool64 — not cleared/.test(t.title)), (await drv.listTargets()).map((t) => t.title).join(" | "));

    // The same, answered for one call only.
    persist = undefined;
    s.rows = s.rows.filter((r) => r.hwnd !== 11);
    await drv.focusTarget(tool);
    const during = (await drv.listTargets()).some((t) => /— sometool64$/.test(t.title));
    drv.endCall();
    const after = (await drv.listTargets()).some((t) => /^sometool64 — not cleared/.test(t.title));
    check("an answer for this call covers the opened window for this call, and no longer", during && after, `during ${during}, after ${after}`);
  }

  // ── A helper that predates `appinfo` still starts apps, asked about by name ───────────────
  {
    const s = stub();
    s.oldHelper = true;
    s.opens = { row: calcRow(), frameReads: 0 };
    const a = asker(s, () => ({ allowed: true, persist: "session" }));
    const drv = new WindowsDriver({ interaction: "desktop", transport: s.transport, consent: a.consent, env: { COMPUTER_USE_WINDOWS_APPROVALS: storeFile() } });
    const bound = await drv.focusTarget(CALC);
    check("without appinfo the question names the Start-menu entry, still before the launch",
      bound.ok && a.asked.length === 1 && a.asked[0]!.app === "计算器" && s.log.indexOf("launch") > s.log.indexOf("ask:计算器"), `${a.asked.map((q) => q.app).join()} | ${s.log.join(" ")}`);
  }

  // ── Answering the question is not "the user is busy" ─────────────────────────────────────
  {
    const s = stub();
    s.exe["计算器"] = "CalculatorApp";
    s.opens = { row: calcRow(), frameReads: 0 };
    const a = asker(s, () => ({ allowed: true, persist: "session" }));
    // The key press that answered the question is the user's last input.
    s.idle = () => (a.answeredAt() ? (Date.now() - a.answeredAt()) / 1000 : 60);
    const drv = new WindowsDriver({ interaction: "desktop", transport: s.transport, consent: a.consent, env: { COMPUTER_USE_WINDOWS_APPROVALS: storeFile() } });
    const bound = await drv.focusTarget(CALC);
    check("the launch waits out the answer's own key press instead of refusing over it", bound.ok && s.log.includes("launch"), bound.note ?? "");
    // Somebody typing all along is still refused, and by the app's name rather than its id.
    s.rows = s.rows.filter((r) => r.hwnd !== 7);
    s.idle = () => 0.2;
    const busy = await thrown(drv.focusTarget(CALC));
    check("a user who keeps typing still stops the launch, named as they know the app", /launch_app was NOT sent/.test(busy) && /"计算器"/.test(busy), busy.slice(0, 150));
  }

  // ── No client to ask: every app is cleared, as before, and nothing waits ─────────────────
  {
    const s = stub();
    s.opens = { row: calcRow(), frameReads: 0 };
    const drv = new WindowsDriver({ interaction: "desktop", transport: s.transport, env: { COMPUTER_USE_WINDOWS_APPROVALS: storeFile() } });
    const bound = await drv.focusTarget(CALC);
    check("a client that cannot ask starts and binds the app unasked", bound.ok && s.log.includes("launch"), bound.note ?? "");
  }

  // ── The pure halves ──────────────────────────────────────────────────────────────────────
  {
    const list = START_MENU;
    check("launchConsent prefers the program, then the Start-menu name, then what was typed",
      JSON.stringify(launchConsent("计算器", { name: "计算器", via: "start_menu", exe: "CalculatorApp" }, list)) === '{"app":"CalculatorApp","shown":"计算器"}'
      && launchConsent(START_MENU[0]!.id, null, list).app === "计算器" && launchConsent("mspaint", null, list).app === "mspaint");
    check("the approvals command quotes a name with a space in it",
      approvalsAddCommand("Some Tool", "/x/bin/mirasim-cu.mjs") === 'mirasim-cu approvals add "Some Tool"' && approvalsAddCommand("WINWORD", "/x/bin/mirasim-cu.mjs") === "mirasim-cu approvals add WINWORD");
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

void main();
