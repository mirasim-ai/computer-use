/**
 * A click the page never received is not reported as a click — `node scripts/test.mjs click-receipt`.
 *
 * A click that was sent and not heard back about is settled by asking the page a trivial question:
 * a page that answers has handled it. Where something in front of the page takes the input, the
 * page answers all the same, and a click that never arrived came back as "clicked — the page was
 * busy handling it". Now the page is also asked whether it SAW the press (click-receipt.ts).
 *
 * `clickNamingCover` takes the thing it clicks as an argument, so the cases a browser will not
 * produce on demand are made by a stand-in whose `click` does what the case needs and then times
 * out the way Playwright does after dispatch. Everything else is the real page in a throwaway
 * headless Chrome:
 *
 *   · a click that goes through as usual is unchanged, and leaves no listener on the page;
 *   · sent, never arrived, page answers: refused as never received (was: "clicked");
 *   · sent, arrived, not heard back about: still a click, as a slow handler is;
 *   · a press that fell on another element is refused, naming it;
 *   · an event the page's own script dispatches is not a press;
 *   · a target inside an iframe, and one inside a shadow root, are heard where they are;
 *   · a stand-in that cannot be asked is judged as before.
 */

import { chromium, type Locator, type Page } from "playwright-core";
import { clickNamingCover } from "../src/platform/chromium/actions.ts";
import { sleep, spawnChrome } from "./helpers.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const HTML = `<!doctype html><title>Receipt</title>
<button id="go" onclick="document.getElementById('o').textContent += 'go;'">Go</button>
<button id="other" onclick="document.getElementById('o').textContent += 'other;'">Other</button>
<p id="o"></p>
<iframe id="f" srcdoc="<button id='in' onclick='parent.document.getElementById(&quot;o&quot;).textContent += &quot;in;&quot;'>Inside</button>" style="width:300px;height:80px"></iframe>
<div id="host"></div>
<script>
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="sh"><span>Shadow</span></button>';
  root.getElementById('sh').onclick = () => { document.getElementById('o').textContent += 'sh;'; };
</script>`;

/** What Playwright throws when a click's time runs out after the click was dispatched. */
const sentNotHeard = () => Object.assign(new Error("locator.click: Timeout 2000ms exceeded.\nCall log:\n  - attempting click action\n  - performing click action"), { name: "TimeoutError" });
const OPTS = { button: "left" as const, clickCount: 1 };

/** Listeners for a press on the main document's window, counted by the browser itself. */
async function pressListeners(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { result } = await cdp.send("Runtime.evaluate", { expression: "window" });
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId! });
    return listeners.filter((l) => l.type === "pointerdown" || l.type === "mousedown").length;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function main() {
  const chrome = await spawnChrome({});
  const browser = await chromium.connectOverCDP(chrome.cdpUrl);
  try {
    const page = await browser.contexts()[0]!.newPage();
    await page.setContent(HTML);
    const shown = () => page.locator("#o").textContent();
    const reset = () => page.evaluate("document.getElementById('o').textContent = ''");
    const go = page.locator("#go");
    /** A stand-in for `loc`: `act` is all its click does before it times out as sent-and-not-heard. */
    const standIn = (loc: Locator, act: () => Promise<unknown>) => ({
      click: async () => { await act(); throw sentNotHeard(); },
      evaluateHandle: (fn: unknown) => loc.evaluateHandle(fn as never),
    });
    const outcome = async (target: Parameters<typeof clickNamingCover>[0], loc: Locator, ref: string, name: string) => {
      try {
        const r = await clickNamingCover(target, loc, OPTS, ref, name);
        return r ? `${r.ok ? "ok" : "refused"}: ${r.note ?? ""}` : "gone";
      } catch (e) {
        return `threw: ${(e as Error).message}`;
      }
    };
    const centre = async (loc: Locator) => {
      const box = (await loc.boundingBox())!;
      return [box.x + box.width / 2, box.y + box.height / 2] as const;
    };

    // Playwright puts press listeners of its own on a page the first time anything is evaluated on
    // one of its elements (every click here already does that); they are the base to compare with.
    await go.evaluate(() => 1);
    const base = await pressListeners(page);

    // ── The usual click ────────────────────────────────────────────────────────────────────
    const usual = await outcome(go, go, "e1", "Go");
    check("a click that goes through as usual is answered as before", usual === "ok: " && await shown() === "go;", `${usual} / ${await shown()}`);
    await sleep(300);
    check("...and leaves no listener on the page", await pressListeners(page) === base, `${await pressListeners(page)}, were ${base}`);

    // ── Sent, never arrived ────────────────────────────────────────────────────────────────
    await reset();
    const lost = await outcome(standIn(go, async () => {}), go, "e1", "Go");
    check("a click that was sent and never reached the page is refused, though the page answers",
      /^threw: the click was sent, but the page never received it: no press reached e1 "Go"/.test(lost) && /observe before clicking again/.test(lost) && await shown() === "", lost);

    // ── Sent, arrived, not heard back about ────────────────────────────────────────────────
    await reset();
    const [gx, gy] = await centre(go);
    const slow = await outcome(standIn(go, () => page.mouse.click(gx, gy)), go, "e1", "Go");
    check("a click that arrived and was not heard back about is still a click",
      /^ok: clicked — the page was busy for [\d.]+s handling it/.test(slow) && await shown() === "go;", `${slow} / ${await shown()}`);

    // ── The press fell on something else ───────────────────────────────────────────────────
    await reset();
    const [ox, oy] = await centre(page.locator("#other"));
    const astray = await outcome(standIn(go, () => page.mouse.click(ox, oy)), go, "e1", "Go");
    check("a press that fell on another element is refused, naming it",
      /^threw: the click was sent, and its press fell on button#other "Other", not on e1 "Go"/.test(astray), astray);

    // ── A page script's own event is not a press ───────────────────────────────────────────
    await reset();
    const forged = await outcome(standIn(go, () => page.evaluate(`{
      const el = document.getElementById('go');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.click();
    }`)), go, "e1", "Go");
    check("an event the page's own script dispatched is not taken for the press",
      /^threw: the click was sent, but the page never received it/.test(forged) && await shown() === "go;", `${forged} / ${await shown()}`);

    // ── Inside an iframe, inside a shadow root ─────────────────────────────────────────────
    await reset();
    const inside = page.frameLocator("#f").locator("#in");
    const [ix, iy] = await centre(inside);
    const framed = await outcome(standIn(inside, () => page.mouse.click(ix, iy)), inside, "e7", "Inside");
    check("a press on a target inside an iframe is heard in that frame", /^ok: clicked/.test(framed) && await shown() === "in;", `${framed} / ${await shown()}`);
    const framedLost = await outcome(standIn(inside, () => page.mouse.click(gx, gy)), inside, "e7", "Inside");
    check("...and a press on the page around the iframe is not a press on it", /^threw: the click was sent, but the page never received it/.test(framedLost), framedLost);

    await reset();
    const shadow = page.locator("#sh");
    const [sx, sy] = await centre(shadow);
    const shadowed = await outcome(standIn(shadow, () => page.mouse.click(sx, sy)), shadow, "e9", "Shadow");
    check("a press on a target inside a shadow root, on its child, is heard", /^ok: clicked/.test(shadowed) && await shown() === "sh;", `${shadowed} / ${await shown()}`);

    // ── A stand-in that cannot be asked ────────────────────────────────────────────────────
    await reset();
    const blind = await outcome({ click: async () => { throw sentNotHeard(); } }, go, "e1", "Go");
    check("a target that cannot be asked for a receipt is judged as before", /^ok: clicked — the page was busy/.test(blind), blind);

    await sleep(300);
    check("after all of it no listener is left on the page", await pressListeners(page) === base, `${await pressListeners(page)}, were ${base}`);
  } finally {
    await browser.close().catch(() => {});
    chrome.cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall click-receipt checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
