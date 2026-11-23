// Opt-in real Finder regression: node scripts/test.mjs macos-finder-live.
// Use list view with file extensions visible and a different app in front.
// Set FINDER_RENAME_MENU_TITLE on a desktop whose Finder menus are not English.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDriver } from "../src/platform/registry.ts";
import { AxHelperProcess } from "../src/platform/macos/ax-client.ts";
import { createHarness } from "./harness.ts";

const dir = mkdtempSync(join(tmpdir(), "cu-finder-rename-"));
const driver = createDriver("macos", { bundle: "com.apple.finder" });
const inspector = new AxHelperProcess();
const { api } = createHarness(driver);
const names = ["Before.csv", "Control.csv", "Decoy.csv"];
const files = () => readdirSync(dir).filter(name => !name.startsWith(".")).sort()
  .map(name => [name, statSync(join(dir, name)).ino, readFileSync(join(dir, name), "utf8")]);
let target: { pid: number; window: number } | undefined;
try {
  for (const name of names) writeFileSync(join(dir, name), name);
  const original = files();
  execFileSync("open", ["-g", dir]);
  for (let i = 0; i < 30; i++) {
    const win = (await driver.listTargets()).find(w => w.title.endsWith(" — " + basename(dir)));
    if (win) {
      const [pid, window] = win.id.split(":").map(Number);
      target = { pid: pid!, window: window! };
      assert((await driver.focusTarget(win.id)).ok);
      break;
    }
    await delay(100);
  }
  assert(target, "the fixture window must be visible");
  async function openRenameMenu() {
    const row = await api.find("Before.csv", { role: "textbox" });
    assert(row);
    await api.click(row);
    await api.act("ax_action", { ref: row.ref, action: "AXShowMenu" });
    const rename = await api.find(process.env.FINDER_RENAME_MENU_TITLE || "Rename", { role: "menuitem" });
    assert(rename);
    await api.click(rename);
    await api.wait({});
  }
  await openRenameMenu();
  const { pid } = target;
  const focus = async () => (await inspector.request("focused", { pid }) as {
    element: { ident: string; value: string };
  }).element;
  const editor = await focus();
  assert.equal(editor.value, "Before.csv");
  assert.equal(editor.ident, "ShrinkToFit Text Field");
  await api.keys("Escape");
  const control = await api.find("Control.csv", { role: "textbox" });
  assert(control);
  await api.click(control);
  await api.wait({});
  assert.equal((await focus()).ident, "ListView");
  await assert.rejects(api.act("type", { text: "Decoy" }), /0 of 5 characters.*focus/i);
  assert.deepEqual(files(), original);
  // Retrying after the refusal must not fall through to Finder type-to-select.
  await assert.rejects(api.act("type", { text: "Decoy" }), /0 of 5 characters.*focus/i);
  // The direct type op (used when Finder is in front) must reject the list too.
  await assert.rejects(inspector.request("type", { pid: target.pid, text: "Decoy" }), /0 of 5 characters.*focus/i);
  const { elements } = await inspector.request("tree", target) as {
    elements: { role: string; value: string; selected?: boolean }[];
  };
  const controlIndex = elements.findIndex(e => e.role === "AXTextField" && e.value === "Control.csv");
  assert(controlIndex >= 0);
  assert(elements.slice(0, controlIndex).findLast(e => e.role === "AXRow")?.selected,
    "Control.csv must stay selected after both refused input routes");
  await openRenameMenu();
  await api.act("type", { text: "After" });
  await api.keys("Enter");
  await api.wait({});
  const renamed = original.map(([name, inode, content]) =>
    [name === "Before.csv" ? "After.csv" : name, inode, content]);
  assert.deepEqual(files(), renamed);
  console.log("PASS  typing after the menu editor loses focus posts zero characters");
} finally {
  try {
    if (target) await inspector.request("closewindow", target);
  } finally {
    await driver.close();
    await inspector.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
