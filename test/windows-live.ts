/**
 * Opt-in live smoke for the Windows driver: real windows, real UI Automation, real input.
 * `npx tsx test/windows-live.ts` on a Windows desktop. It opens Calculator and Character Map, drives
 * them with explicit desktop interaction (see windows/driver.ts) and closes
 * what it opened. Not part of `npm test`: it takes the user's foreground and keyboard.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { WindowsDriver } from "../src/platform/windows/driver.ts";
import { createHarness, firstText } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function waitWindow(d: WindowsDriver, match: RegExp, ms = 15_000): Promise<string> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    const t = (await d.listTargets()).find((x) => match.test(x.title));
    if (t) return t.id;
  }
  throw new Error(`no window matching ${match}`);
}

const driver = new WindowsDriver({ interaction: "background" });
const h = createHarness(driver);
const opened: string[] = [];
try {
  // ── Background mode: reads work; coordinate actions are refused before input ──
  const targets = await driver.listTargets();
  check("lists windows", targets.length > 0, `${targets.length} windows`);

  execFileSync("cmd.exe", ["/c", "start", "", "calc.exe"], { stdio: "ignore" });
  const calc = await waitWindow(driver, /(计算器|Calculator)/);
  opened.push(calc);
  await driver.focusTarget(calc);
  // A UWP window is listed before its XAML content is up; wait for the keypad, not for the frame.
  let obs = "";
  let took = 0;
  for (const end = Date.now() + 10_000; Date.now() < end && !/num7Button/.test(obs); await sleep(300)) {
    const t0 = Date.now();
    obs = firstText(await h.observe());
    took = Date.now() - t0;
  }
  check("observes Calculator's keypad", /button "[^"]+" ⟨id: num7Button⟩/.test(obs), `${obs.split("\n").length} lines, last read ${took} ms`);
  const refused = await h.act("click", { x: 1, y: 1 });
  check("background mode refuses a coordinate click", !refused.ok && /desktop interaction/.test(refused.note), refused.note.slice(0, 90));

  // ── Desktop mode: activate + UIA patterns, verified by read-back ──
  driver.interactionMode = "desktop";
  // AutomationIds, not names: Calculator's button names follow the system language (Seven, Plus, Equals in English).
  for (const id of ["clearButton", "num7Button", "plusButton", "num8Button", "equalButton"]) {
    const el = await h.api.find(id);
    if (!el) { check(`find ${id}`, false); continue; }
    await h.api.click(el.ref);
  }
  const shown = await h.api.text();
  check("7+8 = 15 via Invoke", /显示为 15|Display is 15/.test(shown), shown.match(/(显示为|Display is) [\d,.]+/)?.[0] ?? "no result text");

  const saved = await h.api.screenshot() as unknown as { path?: string };
  const png = saved.path ? readFileSync(saved.path) : Buffer.alloc(0);
  check("screenshot is a PNG", png.subarray(1, 4).toString() === "PNG", `${png.length} bytes at ${saved.path}`);

  // ── Character Map (Win32): set_text through ValuePattern, then a button by Invoke appends ──
  execFileSync("cmd.exe", ["/c", "start", "", "charmap.exe"], { stdio: "ignore" });
  const map = await waitWindow(driver, /(字符映射表|Character Map)/);
  opened.push(map);
  await driver.focusTarget(map);
  const field = (await h.api.observe()).elements.find((e) => e.role === "textbox");
  check("Character Map has its copy field", !!field, field ? `${field.ref} "${field.name}"` : "");
  if (field) {
    const ok = await h.api.setTextBestEffort(field.ref, "abc");
    check("set_text via ValuePattern", (await h.api.value(field.ref)) === "abc", `verified=${ok}`);
    const select = await h.api.find("选择(S)") ?? await h.api.find("Select");
    if (select) await h.api.click(select.ref);
    const after = await h.api.value((await h.api.observe()).elements.find((e) => e.role === "textbox")!.ref);
    check("Select button (Invoke) appended a character", after.length === 4, `"${after}"`);
  }
} finally {
  // Close only what this run opened; neither app asks to save.
  driver.interactionMode = "desktop";
  for (const id of opened) {
    try {
      await driver.focusTarget(id);
      await h.api.keys("alt+F4");
      await sleep(400);
    } catch { /* already gone */ }
  }
  await driver.close();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
