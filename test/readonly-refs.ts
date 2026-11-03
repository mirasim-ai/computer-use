/** Real Chrome regression for observation identities.
 * Reads must leave markup alone, while refs still reach fields, frames, shadow DOM and scroll. */
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { spawnChrome } from "./helpers.ts";
import { createHarness, firstText } from "./harness.ts";
import { resolveProfile } from "../src/platform/profile.ts";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

const WATCH = `<script>window.mutations=[];new MutationObserver(ms=>window.mutations.push(...ms.filter(m=>m.attributeName?.startsWith('data-mf')).map(m=>m.attributeName))).observe(document.body,{attributes:true,subtree:true});</script>`;
const MAIN = `<!doctype html><title>Readonly reference fixture</title>
<section role="group" aria-label="Session A"><input aria-label="Message" value="A"></section>
<section role="group" aria-label="Session B"><input aria-label="Message" value="B"></section>
<label>Draft<input id="draft" aria-label="Draft" value="original"></label>
<button onclick="document.getElementById('draft').replaceWith(document.getElementById('draft').cloneNode())">Rebuild field</button>
<div id="shadow"></div><iframe src="/frame" title="Nested frame"></iframe>
<div aria-label="Outer"><div aria-label="Inner"><p>deep treasure text</p></div></div>
<div role="region" aria-label="Scrollable list" style="height:130px;overflow:auto;width:360px">
${Array.from({ length: 30 }, (_, i) => `<p>List item ${i}</p>`).join("")}</div>
<script>document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow field">';</script>${WATCH}`;
const FRAME = `<!doctype html><title>Child frame</title><input aria-label="Frame field">${WATCH}`;

async function main() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url === "/frame" ? FRAME : MAIN);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chrome = await spawnChrome({});
  const profile = resolveProfile({ driver: "browser", cdpUrl: chrome.cdpUrl });
  const verifier = await chromium.connectOverCDP(chrome.cdpUrl);
  const h = createHarness(profile.driver);
  try {
    await h.act("open_url", { url: base });
    const page = verifier.contexts()[0]!.pages().find(p => p.url() === `${base}/`)!;
    const before = await h.api.observe();
    const draft = before.elements.find(e => e.name === "Draft")!;
    const again = await h.api.observe();
    check("repeated reads retain the same ref", again.elements.find(e => e.name === "Draft")?.ref === draft.ref);
    const shallow = await h.api.page({ depth: 1 });
    const node = shallow.match(/\(node (n\d+)\)/)?.[1];
    check("a shallow read still returns a drill handle", !!node);
    if (node) check("a drill handle resolves without DOM markers", !(await h.api.page({ node })).includes("page read failed"));
    check("subtree reads resolve the original ref", (await h.api.page({ ref: draft.ref })).includes("original"));
    const unchanged = await page.evaluate(`(() => {
      const mutations = window.mutations;
      const child = document.querySelector("iframe").contentWindow;
      const shadow = document.getElementById("shadow").shadowRoot;
      return mutations.length === 0 && child.mutations.length === 0 &&
        !document.querySelector("[data-mfref],[data-mfnode]") && !shadow.querySelector("[data-mfref],[data-mfnode]");
    })()`);
    check("observe and page reads write no DOM markers, including frame and shadow", unchanged === true);

    for (const scope of [{ role: "textbox" }, { visible: true }, { role: "textbox", visible: true }]) {
      let refused = false;
      try { await h.api.setText(await h.api.find("Message", scope), "wrong"); }
      catch (e) { refused = /write would be a guess/.test(String(e)); }
      check(`filters do not waive an unresolved write tie: ${JSON.stringify(scope)}`, refused);
    }
    await h.api.setText(await h.api.find("Message", { role: "textbox", near: "Session B" }), "B updated");
    check("a uniquely scoped write reaches only Session B", await page.evaluate(`(() => {
      const inputs = [...document.querySelectorAll('input[aria-label="Message"]')];
      return inputs[0].value === "A" && inputs[1].value === "B updated";
    })()`));
    await h.api.setText(draft.ref, "written by ref");
    await h.api.setText(await h.api.find("Shadow field"), "shadow value");
    await h.api.setText(await h.api.find("Frame field"), "frame value");
    check("refs can fill main, shadow and frame fields", await page.evaluate(`
      document.getElementById("draft").value === "written by ref" &&
      document.getElementById("shadow").shadowRoot.querySelector("input").value === "shadow value" &&
      document.querySelector("iframe").contentDocument.querySelector("input").value === "frame value"`));

    await h.api.click(await h.api.find("Rebuild field"));
    const rebuilt = await h.api.observe();
    const fresh = rebuilt.elements.find(e => e.name === "Draft")!;
    check("a cloned replacement gets a fresh identity", fresh.ref !== draft.ref);
    let stale = false;
    try { await h.api.setText(draft.ref, "must not land"); } catch { stale = true; }
    check("an old explicit ref cannot write into the replacement", stale);
    await h.api.setText(fresh.ref, "fresh value");
    const region = await h.api.find("Scrollable list");
    const scrolled = await h.act("scroll", { ref: region!.ref, to: "bottom" });
    check("ref-targeted scroll still reaches its original container", scrolled.ok &&
      await page.locator('[aria-label="Scrollable list"]').evaluate(el => el.scrollTop > 0));
    check("scroll receipt identifies the container", firstText(scrolled).includes("Scrollable list"));
  } finally {
    await profile.driver.close();
    await verifier.close();
    chrome.cleanup();
    server.closeAllConnections();
    server.close();
  }
  console.log(failures ? `READONLY REFS FAILED (${failures})` : "READONLY REFS OK");
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
