/**
 * A rich-text body inside an iframe can be found and written — `node scripts/test.mjs iframe-editor`.
 *
 * A document editor keeps its body in an iframe, and an empty body is one line high with the
 * editor's "Write something…" laid over it as an element of its own. That placeholder held the
 * body's whole click point, so the body was taken for covered: listed nowhere, find() answered
 * "covered", writing to its ref was refused, and the advice (dismiss the cover, scroll clear of
 * it) named nothing that can be done. The title could be filled and the body could not.
 *
 * Each way such an editor is built is driven the way a model drives it: find the body by name,
 * write to it, read it back. And what must stay a cover is pinned too: a veil over the whole
 * frame, something over an entry that is NOT empty, and a notice with a button of its own over an
 * empty one.
 */

import { createServer } from "node:http";
import { spawnChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Result = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const allText = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").split("\nAPI reference")[0]!;
const line = (s: string, re: RegExp) => (s.split("\n").find((l) => re.test(l)) ?? s.split("\n")[0] ?? "").slice(0, 300);
const returned = <T>(s: string): T | null => {
  try { return JSON.parse(/Returned: (.*)/.exec(s)?.[1] ?? "null") as T; } catch { return null; }
};

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`;
const memo = (frame: string, extra = "") => `<h1>Memo</h1><input aria-label="Title">${frame}${extra}`;
const FRAME = (src: string) => `<iframe src="${src}" title="Body frame" width="700" height="300"></iframe>`;
/** The empty body as Draft.js lays it out: one line high, the placeholder a positioned sibling of
 *  the editable's wrapper, there only while the body is empty, and a click anywhere in the editor
 *  focusing the editable. */
const DRAFT = `<div class="root" style="position:relative" onclick="this.querySelector('[contenteditable]').focus()"
  oninput="this.querySelector('.placeholder').style.display = this.querySelector('[contenteditable]').innerText.trim() ? 'none' : ''">
<div class="placeholder" style="position:absolute;z-index:1;width:100%;color:#999">Write something…</div>
<div class="container"><div contenteditable="true" role="textbox" aria-label="Body" style="outline:none"><div><br></div></div></div></div>`;

function serve(): Promise<{ port: number; close: () => void }> {
  const srv = createServer((req, res) => {
    const port = (srv.address() as { port: number }).port;
    const other = `http://127.0.0.1:${port}`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    switch (new URL(req.url ?? "/", "http://x").pathname) {
      // ── editors that must work ──
      case "/placeholder.html": return void res.end(page("Placeholder", memo(FRAME("/frame-draft.html"))));
      case "/placeholder-cross-origin.html": return void res.end(page("Placeholder x", memo(FRAME(`${other}/frame-draft.html`))));
      case "/placeholder-sibling.html": // the placeholder a direct sibling of the editable, taller body
        return void res.end(page("Sibling", memo(FRAME("/frame-sibling.html"))));
      case "/written.html": // the classic one: an about:blank frame written into, its body editable
        return void res.end(page("Written", memo(`<iframe id="f" title="Body frame" width="700" height="300"></iframe>`,
          `<script>const d = document.getElementById('f').contentDocument; d.open(); d.write('<body contenteditable="true" aria-label="Body" role="textbox" style="min-height:200px"></body>'); d.close();</script>`)));
      case "/below.html": // the frame below the first screen
        return void res.end(page("Below", memo(`<div style="height:1400px">spacer</div>${FRAME("/frame-plain.html")}`)));
      case "/label.html": // not an iframe: a floating label over an empty input, the same shape
        return void res.end(page("Label", `<h1>Sign up</h1><div style="position:relative;width:300px"><span style="position:absolute;left:4px;top:2px;color:#999">Email address</span><input aria-label="Email" style="width:290px;height:22px"></div>`));
      // ── what must stay covered ──
      case "/veiled.html": // a veil over the whole frame document, the editor under it
        return void res.end(page("Veiled", memo(FRAME("/frame-veiled.html"))));
      case "/filled.html": // the entry holds text: what sits over it is no placeholder
        return void res.end(page("Filled", memo(FRAME("/frame-filled.html"))));
      case "/notice.html": // a notice with a button of its own over the empty entry
        return void res.end(page("Notice", memo(FRAME("/frame-notice.html"))));
      // ── frames ──
      case "/frame-draft.html": return void res.end(page("frame", DRAFT));
      case "/frame-sibling.html":
        return void res.end(page("frame", `<div style="position:relative"><div style="position:absolute;z-index:1;width:100%;color:#999">Write something…</div><div contenteditable="true" role="textbox" aria-label="Body" style="min-height:200px;outline:none"></div></div>`));
      case "/frame-plain.html":
        return void res.end(page("frame", `<div contenteditable="true" role="textbox" aria-label="Body" style="min-height:200px;outline:none"></div>`));
      case "/frame-veiled.html":
        return void res.end(page("frame", `<div style="position:fixed;inset:0;z-index:5;background:rgba(255,255,255,.6)">Loading…</div>${DRAFT.replace('<div class="placeholder"', '<div class="placeholder" hidden')}`));
      case "/frame-filled.html":
        return void res.end(page("frame", `<div style="position:relative"><div style="position:absolute;z-index:1;width:100%;background:#fff">Saving your draft</div><div contenteditable="true" role="textbox" aria-label="Body" style="outline:none">Dear team</div></div>`));
      case "/frame-notice.html":
        return void res.end(page("frame", `<div style="position:relative"><div style="position:absolute;z-index:1;width:100%;background:#fff">Sign in to write <button>Sign in</button></div><div contenteditable="true" role="textbox" aria-label="Body" style="outline:none"><div><br></div></div></div>`));
      default: return void res.end(page("404", "nope"));
    }
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    resolve({ port: (srv.address() as { port: number }).port, close: () => srv.close() });
  }));
}

async function main() {
  const chrome = await spawnChrome({});
  const fixtures = await serve();
  // The page on localhost and its other origin on 127.0.0.1, as in page-opened-tabs.
  const at = (path: string) => `http://localhost:${fixtures.port}${path}`;
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  process.env.COMPUTER_USE_OBS_DELTA = "0";
  delete process.env.COMPUTER_USE_WINDOW;
  delete process.env.COMPUTER_USE_TAB;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const tool = Object.fromEntries(profile.tools.map((t) => [t.name, t.execute]));
  const run = async (code: string) => allText(await tool.computer_repl({ code, observation: "none" }) as Result);
  const state = (name: string) => `((await w.observe()).elements.find((e) => e.name === '${name}') ?? {}).state ?? null`;

  try {
    await run("const w = await computer.surface(); await w.openUrl({ url: 'about:blank' });");

    // ── Editors that must work: find by name, write, read back ───────────────────────────────
    const editors: Array<[string, string, string]> = [
      ["/placeholder.html", "Body", "an empty one-line body under its placeholder, in a same-origin frame"],
      ["/placeholder-cross-origin.html", "Body", "…the same in a cross-origin frame"],
      ["/placeholder-sibling.html", "Body", "a taller body whose placeholder is its direct sibling"],
      ["/written.html", "Body", "a frame written into, its whole body editable"],
      ["/below.html", "Body", "a frame below the first screen"],
      ["/label.html", "Email", "an empty input under its floating label (no frame)"],
    ];
    for (const [path, name, what] of editors) {
      const out = await run(`await w.openUrl({ url: '${at(path)}' });
        const listed = (await w.observe()).elements.concat((await w.observe()).offscreenElements ?? []).some((e) => e.name === '${name}');
        const found = await w.find('${name}');
        let wrote = null; try { wrote = found ? String(await w.setText(found, 'hello body')) : null; } catch (e) { wrote = 'threw: ' + e.message; }
        return { listed, found: !!found, wrote, holds: ${state(name)} };`);
      const r = returned<{ listed: boolean; found: boolean; wrote: string | null; holds: string | null }>(out);
      check(`${what}: listed, found by name, written and read back`,
        !!r && r.listed && r.found && !/threw/.test(String(r.wrote)) && /hello body/.test(String(r.holds)), line(out, /Returned|STOPPED/));
    }

    // A click goes where a person's goes: onto the placeholder, which the editor answers by
    // taking the caret.
    const clicked = await run(`await w.openUrl({ url: '${at("/placeholder.html")}' });
      let said; try { said = String(await w.click(await w.find('Body'))); } catch (e) { said = 'threw: ' + e.message; }
      return { said, focused: await w.runJs({ code: "document.querySelector('iframe').contentDocument.activeElement.getAttribute('aria-label')" }) };`);
    const c = returned<{ said: string; focused: string | null }>(clicked);
    check("a click on the empty body lands on its placeholder and the editor takes the caret", !!c && !/threw/.test(c.said) && c.focused === "Body", line(clicked, /Returned|STOPPED/));

    // ── What must stay a cover ───────────────────────────────────────────────────────────────
    const covers: Array<[string, string]> = [
      ["/veiled.html", "a veil over the whole frame, larger than the editor"],
      ["/filled.html", "a banner over a body that is not empty"],
      ["/notice.html", "a notice with a button of its own over an empty body"],
    ];
    for (const [path, what] of covers) {
      const out = await run(`await w.openUrl({ url: '${at(path)}' });
        const why = await w.find('Body', { why: true });
        return { listed: (await w.observe()).elements.some((e) => e.name === 'Body'), reason: why.reason ?? null, ref: why.ref ?? null };`);
      const r = returned<{ listed: boolean; reason: string | null; ref: string | null }>(out);
      check(`${what} is still a cover: the body is not listed and find says covered`,
        !!r && !r.listed && r.reason === "covered" && r.ref === null, line(out, /Returned|STOPPED/));
    }
  } finally {
    await Promise.all(profile.drivers.map((d) => d.close().catch(() => {})));
    fixtures.close();
    chrome.cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall iframe-editor checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
