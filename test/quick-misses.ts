/**
 * A miss must cost what it takes to find out, not a timeout — and must say what IS there.
 *
 * Each case here was measured in a front-end benchmark as seconds of nothing: a select asked for
 * an option it does not have (three timeouts in a row, ~20 s), a clipboard read waiting on a
 * permission prompt nobody answers (10 s), a wait or an expect for a control under a slightly
 * different name, and a find() handle whose node was re-rendered or reloaded underneath it.
 * Against a real throwaway Chrome, through the test harness: these are the notes the model reads.
 */

import { createServer } from "node:http";
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

/** The clipboard exists only in a secure context, which a data: URL is not: one page on localhost. */
function serve(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // A headless Chrome denies the read at once; a window on someone's desk asks them, and the
      // promise waits for an answer. That is what this page stands in for: the permission still
      // at "prompt", and a read that never settles.
      res.end(`<!doctype html><title>clipboard fixture</title><button>Copy order number</button>
<script>
  navigator.permissions.query = async () => ({ state: "prompt" });
  Clipboard.prototype.readText = () => new Promise(() => {});
  Clipboard.prototype.read = () => new Promise(() => {});
</script>`);
    });
    srv.listen(0, "127.0.0.1", () => resolve({
      url: `http://localhost:${(srv.address() as { port: number }).port}/`,
      close: () => srv.close(),
    }));
  });
}

/** How long `f` took, with what it answered. */
async function timed<T>(f: () => Promise<T>): Promise<{ out: T; ms: number }> {
  const t0 = Date.now();
  const out = await f();
  return { out, ms: Date.now() - t0 };
}

async function main() {
  const chrome = await spawnChrome({});
  const site = await serve();
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

    // ── run_js: a clipboard read that waits on a permission prompt ────────────
    await open(site.url);
    const clip = await timed(() => h.act("run_js", { code: "navigator.clipboard.readText()" }));
    check("a clipboard read does not wait out the whole run_js budget", clip.ms < 4000, `${sec(clip.ms)}: ${clip.out.note.slice(0, 200)}`);
    check("...and the answer says why, and what to do instead", /permission prompt/.test(clip.out.note) && /recorder/.test(clip.out.note), clip.out.note.slice(0, 240));
    const own = await h.api.act("run_js", { code: "Object.prototype.hasOwnProperty.call(navigator.clipboard, 'readText')" });
    check("...and nothing is left on navigator.clipboard once the call is over", (own as unknown) === false, String(own));
    const mention = await timed(() => h.act("run_js", { code: "(() => { const read = () => navigator.clipboard.readText(); return typeof read; })()" }));
    check("code that only mentions the clipboard read still runs", mention.out.ok && /function/.test(mention.out.note), mention.out.note.slice(0, 120));

    await driver.close();
  } finally {
    site.close();
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nQUICK MISSES OK" : `\nQUICK MISSES FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
