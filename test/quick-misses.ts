/**
 * A miss must cost what it takes to find out, not a timeout — and must say what IS there.
 *
 * Each case here was measured in a front-end benchmark as seconds of nothing: a select asked for
 * an option it does not have (three timeouts in a row, ~20 s), a clipboard read waiting on a
 * permission prompt nobody answers (10 s), a wait or an expect for a control under a slightly
 * different name, and a find() handle whose node was re-rendered or reloaded underneath it.
 * Against a real throwaway Chrome, through the test harness: these are the notes the model reads.
 */

import { spawnChrome } from "./helpers.ts";
import { createHarness } from "./harness.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const page = (body: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>quick misses fixture</title>${body}`)}`;

/** A native select with a disabled option, a text field that is not a dropdown at all, and a
 *  custom dropdown: a button that reveals role=option rows. */
const FIXTURE_SELECT = page(`
<select aria-label="Status">
  <option value="paid">Paid</option><option value="pending">Pending</option><option value="void" disabled>Void</option>
</select>
<input aria-label="Amount">
<button aria-haspopup="listbox" onclick="document.getElementById('list').hidden = false">Fruit</button>
<div id="list" role="listbox" hidden>
  <div role="option" onclick="document.getElementById('picked').textContent = 'picked Apple'">Apple</div>
  <div role="option" onclick="document.getElementById('picked').textContent = 'picked Banana'">Banana</div>
</div>
<p id="picked">nothing picked</p>`);

/** How long `f` took, with what it answered. */
async function timed<T>(f: () => Promise<T>): Promise<{ out: T; ms: number }> {
  const t0 = Date.now();
  const out = await f();
  return { out, ms: Date.now() - t0 };
}

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  delete process.env.COMPUTER_USE_OBS_DELTA;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);
  const driver = profile.driver;
  const firstText = (r: { content: Array<{ type: string; text?: string }> }) => r.content.find((c) => c.type === "text")?.text ?? "";
  const open = async (url: string) => firstText(await h.act("open_url", { url }));
  const refOf = (obs: string, label: string) => obs.match(new RegExp(`(e\\d+): \\w+ "${label}"`))?.[1];
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  try {
    // ── select_option: an option the control does not have ────────────────────
    const sel = await open(FIXTURE_SELECT);
    const status = refOf(sel, "Status");
    const absent = await timed(() => h.act("select_option", { ref: status, option: "Refunded" }));
    check("an absent option is refused without waiting out the timeouts", !absent.out.ok && absent.ms < 3000, `${sec(absent.ms)}: ${absent.out.note.slice(0, 160)}`);
    check("...and the refusal lists the options the select does have", /Paid/.test(absent.out.note) && /Pending/.test(absent.out.note), absent.out.note.slice(0, 200));

    const byValue = await h.act("select_option", { ref: status, option: "pending" });
    const picked = (await h.api.observe()).elements.find((e) => e.name === "Status");
    check("an option is still picked by its value", byValue.ok && /Pending/.test(picked?.state ?? ""), `${byValue.note} | ${picked?.state}`);
    const byCase = await h.act("select_option", { ref: status, option: "PAID" });
    check("...and by its label whatever the case", byCase.ok && /Paid/.test((await h.api.observe()).elements.find((e) => e.name === "Status")?.state ?? ""), byCase.note);

    const disabled = await timed(() => h.act("select_option", { ref: status, option: "Void" }));
    check("a disabled option is refused as disabled, at once", !disabled.out.ok && disabled.ms < 3000 && /disabled/.test(disabled.out.note), `${sec(disabled.ms)}: ${disabled.out.note.slice(0, 160)}`);

    const amount = refOf(await open(FIXTURE_SELECT), "Amount");
    const notSelect = await timed(() => h.act("select_option", { ref: amount, option: "Refunded" }));
    check("a text field asked for an option answers quickly", !notSelect.out.ok && notSelect.ms < 4000, `${sec(notSelect.ms)}: ${notSelect.out.note.slice(0, 200)}`);
    check("...and says it is not a select", /not a <select>/.test(notSelect.out.note), notSelect.out.note.slice(0, 200));

    const custom = await open(FIXTURE_SELECT);
    const fruit = refOf(custom, "Fruit");
    const opened = await h.act("select_option", { ref: fruit, option: "Banana" });
    check("a custom dropdown is still opened and clicked", opened.ok && (await h.api.text()).includes("picked Banana"), opened.note);
    const fruit2 = refOf(await open(FIXTURE_SELECT), "Fruit");
    const customMiss = await timed(() => h.act("select_option", { ref: fruit2, option: "Cherry" }));
    check("a custom dropdown without the option answers quickly", !customMiss.out.ok && customMiss.ms < 4000, `${sec(customMiss.ms)}: ${customMiss.out.note.slice(0, 200)}`);
    check("...and lists the options it revealed", /Apple/.test(customMiss.out.note) && /Banana/.test(customMiss.out.note), customMiss.out.note.slice(0, 200));

    await driver.close();
  } finally {
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nQUICK MISSES OK" : `\nQUICK MISSES FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
