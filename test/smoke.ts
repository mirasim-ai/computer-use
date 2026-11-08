/**
 * Smoke test: exercise the browser tree toolset end to end against a real Chrome —
 * spawn a throwaway instance, then drive it through the repl's API and read the driver's renderings.
 *
 * Checks: open_url → observe (refs, roles, form state) → click by ref (changed verdict)
 * → set_text (state shows filled:, value stays out of the name) → frozen detection →
 * stale ref wording → observe what:text/screenshot → targets listing. Refs are sticky
 * (they survive re-observes) and repeat observations render as deltas — both asserted
 * here at the rendered surface; test/scroll-behaviors.ts covers the mechanics.
 */

import { spawnChrome } from "./helpers.ts";
import { createHarness } from "./harness.ts";

const FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><title>computer-use smoke</title>
<main>
  <h1>Smoke fixture</h1>
  <p id="status">idle</p>
  <button onclick="document.getElementById('status').textContent='clicked!'">Reveal</button>
  <input placeholder="Search here">
  <a href="#x">Some link</a>
</main>`)}`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";

async function main() {
  const chrome = await spawnChrome({});
  process.env.COMPUTER_USE_CDP_URL = chrome.cdpUrl;
  const { resolveProfile } = await import("../src/platform/profile.ts");
  const profile = resolveProfile({ driver: "browser" });
  const h = createHarness(profile.driver);

  try {
    // Before anything is opened: an empty list on about:blank must not read as "the page
    // has nothing" — or the fresh session's first step is spent re-observing it.
    const blank = firstText(await h.observe({}));
    check("a fresh blank tab says it is blank", /this tab is blank and nothing has been opened/.test(blank), blank.split("\n").slice(0, 2).join(" / "));

    const nav = await h.act("open_url", { url: FIXTURE });
    const navText = firstText(nav);
    check("open_url returns observation", navText.includes("computer-use smoke"));
    check("observe lists button with name", /e\d+: button "Reveal"/.test(navText));
    check("observe lists input with placeholder name + empty state", /textbox "Search here" \[empty\]/.test(navText));
    check("observe lists link", /link "Some link"/.test(navText));
    check("body excerpt present", navText.includes("Smoke fixture"));

    const refMatch = navText.match(/(e\d+): button "Reveal"/);
    check("button ref found", !!refMatch);
    const click = await h.act("click", { ref: refMatch![1], name: "Reveal" });
    const clickText = firstText(click);
    check("click dispatched", click.ok, click.note);
    check("click effect visible (status=clicked!)", clickText.includes("clicked!"));
    check("verdict is changed (no frozen warning)", !clickText.includes("did NOT change"));

    // Refs are sticky: the input ref from the FIRST observation is still valid after the
    // click; the intervening re-observe (unchanged screen) must render as a delta.
    const obs = await h.observe({});
    check("re-observe with no change renders as a delta", obs.details?.obsKind === "delta", String(obs.details?.obsKind));
    check("delta says earlier refs remain valid", firstText(obs).includes("refs from earlier observations remain valid"));
    const inputRef = navText.match(/(e\d+): textbox "Search here"/)?.[1];
    check("input ref found in first observation (sticky)", !!inputRef);
    const fillText = firstText(await h.act("set_text", { ref: inputRef!, name: "Search here", text: "hello" }));
    // The field is focused right after the write, so the state reads "focused, filled:…".
    check("set_text reflected in state", fillText.includes("filled:hello"));
    check("set_text read-back confirms the write", fillText.includes("the field now contains «hello»"));
    check("value does not become the name", fillText.includes('textbox "Search here"'), "identity stays on placeholder");

    const noopText = firstText(await h.act("keys", { chord: "Shift" }));
    check("frozen detected after no-effect action", noopText.includes("did NOT change"));

    // A LOOK at the same static page is frozen too, but nothing failed: the act wording
    // ("your last action had no effect, do not repeat") must not be what a re-observe says.
    const lookText = firstText(await h.observe({}));
    check("a repeat observe is not accused of a failed action", !lookText.includes("did NOT change") && lookText.includes("that was a look, not an action"),
      lookText.split("\n").filter((l) => l.startsWith("NOTE")).join(" | ") || "(no NOTE)");
    // A round that read content and did nothing else: the re-observe advice is not for it.
    await h.api.text();
    const afterRead = firstText(await h.observe({}));
    check("a content read does not end on the re-observe advice", !afterRead.includes("that was a look"),
      afterRead.split("\n").filter((l) => l.startsWith("NOTE")).join(" | ") || "(no NOTE)");
    // run_js reads content the same way.
    const afterJs = firstText(await h.act("run_js", { code: "document.title" }));
    check("a run_js read does not end on the re-observe advice", !afterJs.includes("that was a look"),
      afterJs.split("\n").filter((l) => l.startsWith("NOTE")).join(" | ") || "(no NOTE)");

    // run_js waits 10s for a value unless the code says how long it is meant to run.
    const driver = profile.driver;
    const quick = await driver.perform("run_js", { code: "new Promise(() => {})", ms: 1000 });
    check("ms sets how long run_js waits, and the timeout says longer code can pass it",
      !quick.ok && /no result within 1s/.test(quick.note ?? "") && /pass ms \(up to 45s\)/.test(quick.note ?? ""), quick.note);
    check("…and that a promise waiting on a permission is not helped by a longer wait, with the way to check a copy",
      /can wait forever/.test(quick.note ?? "") && /navigator\.clipboard\.writeText with a recorder/.test(quick.note ?? ""), quick.note);
    const slow = await driver.perform("run_js", { code: "new Promise((r) => setTimeout(() => r('late'), 10500))", ms: 15000 });
    check("…and code meant to run past the 10s default finishes with its value", slow.ok && slow.value === "late", slow.note);
    const cut = await driver.perform("run_js", { code: "new Promise(() => {})", ms: 20000, budgetMs: 1200 });
    check("the wait never outlasts what the call has left, and says so",
      !cut.ok && /no result within 1\.2s/.test(cut.note ?? "") && /fresh call/.test(cut.note ?? ""), cut.note);
    const tooLong = firstText(await h.act("run_js", { code: "1", ms: 60000 }));
    check("ms past 45s is refused by the schema, not quietly cut", /ms/.test(tooLong) && /45000|maximum|<=/.test(tooLong), tooLong.split("\n")[0]);

    const staleText = firstText(await h.act("click", { ref: "e9999" }));
    check("stale ref rejected in the platform's own terms", staleText.includes("not among the refs currently in play") && staleText.includes("a navigation, a reload or a tab switch"), staleText.split("\n")[0]);

    const readText = firstText(await h.observe({ what: "text" }));
    check("observe what:text returns full text", readText.includes("Smoke fixture"));

    const pageText = firstText(await h.observe({ what: "page" }));
    check("observe what:page opens with a completeness receipt", pageText.startsWith("page read: whole page"));
    check("page receipt says complete on this tiny fixture", pageText.includes("complete: nothing folded"));
    check("page tree carries act-able refs", /\[e\d+\] Reveal/.test(pageText));
    check("page tree carries prose content", pageText.includes("Smoke fixture"));

    const subText = firstText(await h.observe({ what: "page", ref: refMatch![1] }));
    check("page subtree read scopes to the element", subText.includes("subtree") && subText.includes("Reveal") && !subText.includes("Search here"));

    const hoverText = firstText(await h.act("hover", { ref: refMatch![1], name: "Reveal" }));
    check("hover carries the reveal-teaching note", hoverText.includes("hovering — anything revealed"));

    const shot = await h.observe({ what: "screenshot" });
    const img = shot.content.find((c: { type: string }) => c.type === "image") as { data?: string } | undefined;
    check("observe what:screenshot returns image", !!img && (img.data?.length ?? 0) > 1000);

    const targetsText = firstText(await h.targets());
    check("targets lists a tab with stable id", /^t\d+ \[tab\]/m.test(targetsText));

    // ── Bare-span pages: coordinate acts + the pixels-are-the-way-in hint ────────
    // Real pages compose whole menus out of spans with no role, no cursor style and a
    // jQuery-style addEventListener — the collector legitimately finds nothing. The tree schema
    // must still accept x/y, the observation must say pixels are the way in, and single-digit
    // text (often THE payload) must survive the excerpt filter.
    const bare = await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>bare spans</title>'
      + '<p>This menu page is composed entirely of bare spans without roles, cursor styles or semantic tags,'
      + ' so the element collector legitimately finds nothing interactive here at all.</p>'
      + '<span id="plus" style="position:fixed;left:40px;top:8px;width:24px;height:24px;display:block">+</span>'
      + '<p id="n" style="position:fixed;left:80px;top:8px">count:0</p>'
      + '<span style="position:fixed;right:8px;top:8px">6</span>'
      + '<script>document.getElementById("plus").addEventListener("click",'
      + '()=>{document.getElementById("n").textContent="count:1"})</script>',
    )}` });
    const bareText = firstText(bare);
    check("bare-span page collects no elements", bareText.includes("(none)"));
    check("low-ref hint points at screenshot + coordinates", bareText.includes("act by x/y coordinates"));
    check("single-digit text survives the excerpt filter", /^6$/m.test(bareText));
    const xy = await h.act("click", { x: 52, y: 20 });
    const xyText = firstText(xy);
    check("a coordinate click is accepted", xy.ok, xy.note);
    check("coordinate click landed on the bare span", xyText.includes("count:1"));

    // ── Silent swallow: an action whose diff has no element line says so ─────────
    // Timer pages defeat the frozen verdict (something always changes), so a click
    // eaten by validation would render as an innocuous text diff — and models
    // re-click forever. The observation must name the no-effect explicitly.
    const timer = await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>timer page</title><button id="dead">Search</button><p id="t">tick 0</p>'
      + '<script>let i=0;setInterval(()=>{document.getElementById("t").textContent="tick "+(++i)},100)</script>',
    )}` });
    const deadRef = firstText(timer).match(/(e\d+): button "Search"/)?.[1];
    check("timer fixture observed", !!deadRef);
    await new Promise((r) => setTimeout(r, 250)); // let the timer tick so the diff is text-only, not empty
    // First click: the button gains focus — a focus-only diff gets NEUTRAL wording (a click
    // whose purpose IS moving focus must not be accused of being swallowed). The timer has also
    // ticked, so the wording names the text without making it evidence: neither "changed nothing
    // else" (false) nor pointing at the text (back into the re-click loop).
    const dead1 = firstText(await h.act("click", { ref: deadRef!, name: "Search" }));
    check("focus-only click on a ticking page is neutral, and does not deny the text",
      /moved the focus; no interactive element changed\. Page text moved too/.test(dead1)
      && !dead1.includes("changed nothing else"), dead1.slice(0, 240));
    // Second click on the already-focused button: nothing at all changes — swallowed.
    await new Promise((r) => setTimeout(r, 250));
    const dead2 = firstText(await h.act("click", { ref: deadRef!, name: "Search" }));
    check("swallowed click is named explicitly", dead2.includes("no interactive element changed after this click"), dead2.slice(0, 200));
    // Push-to-act must fire on timer pages too: the FULL verdict is churned every tick,
    // so "not changing" is judged on elements (three model-initiated observes, no act).
    let idleText = "";
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 150));
      idleText = firstText(await h.observe({}));
    }
    check("push-to-act fires despite the ticking timer", idleText.includes("observations in a row without acting"), idleText.slice(0, 200));
    // Screenshot sprees count too.
    const spree = firstText(await h.observe({ what: "screenshot" }));
    check("screenshot observations feed the push-to-act counter", spree.includes("observations in a row without acting"), spree.slice(0, 200));

    // ── Drilling into a text field hands over the value verbatim ─────────────────
    // Every summary channel trims and collapses whitespace, so a copy-exactly workflow needs
    // the raw value (a trailing space included).
    const exact = await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>exact read</title><textarea id="t">hello world </textarea>',
    )}` });
    const taRef = firstText(exact).match(/(e\d+): textbox/)?.[1];
    check("textarea observed", !!taRef);
    check("summary state flags the edge whitespace", firstText(exact).includes("value has edge whitespace"), firstText(exact).slice(0, 200));
    const exactText = firstText(await h.observe({ what: "page", ref: taRef! }));
    check("subtree read of a text field carries the verbatim value", exactText.includes('verbatim): "hello world "'), exactText.slice(-200));
    check("trailing whitespace is called out", exactText.includes("whitespace inside the quotes"));

    // ── Validation marks, truncation honesty, and the space bar ─────────────────
    const marks = await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>marks</title>'
      + '<input id="bad" class="error" value="MCW" aria-label="From">'
      + `<textarea id="long" aria-label="Long">${"x".repeat(70)}</textarea>`
      + '<input id="sp" aria-label="Spacey">',
    )}` });
    const marksText = firstText(marks);
    check("error-classed field reads as invalid", /From" \[invalid, /.test(marksText), marksText.split("\n").find((l) => l.includes("From")) ?? "");
    check("truncated value ends with an ellipsis", /filled:x{60}…/.test(marksText), marksText.split("\n").find((l) => l.includes("Long")) ?? "");
    const spRef = marksText.match(/(e\d+): textbox "Spacey"/)?.[1];
    await h.act("click", { ref: spRef! });
    await h.act("set_text", { text: "a" });
    const spText = firstText(await h.act("keys", { chord: " " }));
    check("a literal space chord presses the space bar", await h.api.value(spRef!) === "a " && !spText.includes("Unknown key"),
      spText.split("\n").find((l) => l.includes("Spacey")) ?? spText.slice(0, 160));

    // ── Generic affordances: keys count · ARIA selection state · img alt in excerpt ──
    const aff = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>generic affordances</title>'
      + '<input type="range" min="0" max="20" value="10" aria-label="Volume">'
      + '<div role="tablist"><button role="tab" aria-selected="true">Tab One</button>'
      + '<button role="tab" aria-selected="false">Tab Two</button></div>'
      + '<nav><a href="#a" class="crumb active">Page A</a> <a href="#b" class="crumb">Page B</a></nav>'
      // A utility class that merely CONTAINS the word, in a variant and an arbitrary value, as
      // real settings menus wear: a whole-string fallback would mark every item [selected].
      + '<div role="menu"><button role="menuitem" class="tap hover:bg-[var(--th-selected-bg)] hover:text-fg">Menu One</button>'
      + '<button role="menuitem" class="tap is-active">Menu Two</button></div>'
      + '<p><img alt="dairy" width="16" height="16" '
      + 'src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"> Spinach dip</p>',
    )}` }));
    check("aria-selected tab reads [selected]", /tab "Tab One" \[selected\]/.test(aff), aff.split("\n").find((l) => l.includes("Tab One")) ?? "");
    check("unselected tab carries no selected mark", !/tab "Tab Two" \[[^\]]*selected/.test(aff));
    check("ARIA-less active class marks the current item", /link "Page A" \[active\]/.test(aff), aff.split("\n").find((l) => l.includes("Page A")) ?? "");
    check("sibling without the class stays unmarked", !/link "Page B" \[[^\]]*active/.test(aff));
    check("a hover colour named --th-selected-bg is not a state",
      !/"Menu One" \[/.test(aff), aff.split("\n").find((l) => l.includes("Menu One")) ?? "");
    check("...while an unprefixed is-active still marks the item",
      /"Menu Two" \[active\]/.test(aff), aff.split("\n").find((l) => l.includes("Menu Two")) ?? "");
    check("img alt reaches the excerpt", aff.includes('img "dairy"'), aff.split("\n").find((l) => l.includes("img")) ?? "(no img line)");
    const slider = aff.match(/(e\d+): slider "Volume"/)?.[1];
    check("slider ref found", !!slider);
    await h.act("click", { ref: slider!, name: "Volume" });
    const stepped = firstText(await h.act("keys", { chord: "ArrowRight", count: 5 }));
    check("keys count=5 steps the slider 10→15", stepped.includes("value:15"), stepped.split("\n").find((l) => l.includes("value:")) ?? "(no value line)");
    const affPage = firstText(await h.observe({ what: "page" }));
    const tabLine = affPage.split("\n").find((l) => l.includes("Tab One")) ?? "";
    check("page read marks the selected tab", tabLine.includes("selected"), tabLine);

    // ── Actionability: a switched-off control must not list like a live one ─────────
    const gates = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>gates</title>'
      + '<button disabled>Submit</button>'
      + '<fieldset disabled><input aria-label="Street"></fieldset>'
      + '<div role="button" aria-disabled="true">Publish</div>'
      + '<a href="#x" class="btn is-disabled">Next</a>'
      + '<button class="disabled-overlay">Live</button>'
      + '<div role="combobox" aria-expanded="false" aria-label="City">Pick one</div>'
      + '<div role="combobox" aria-expanded="true" aria-label="Country">Open</div>',
    )}` }));
    const line = (needle: string) => gates.split("\n").find((l) => l.includes(needle)) ?? `(no line for ${needle})`;
    check("native disabled button reads [disabled]", /button "Submit" \[disabled\]/.test(gates), line("Submit"));
    check("an ancestor <fieldset disabled> disables the field too", /textbox "Street" \[disabled, empty\]/.test(gates), line("Street"));
    check("aria-disabled control reads [disabled]", /button "Publish" \[disabled\]/.test(gates), line("Publish"));
    check("class-greyed link reads [disabled]", /link "Next" \[disabled\]/.test(gates), line("Next"));
    check("a class that only STARTS with disabled marks nothing", !/"Live" \[[^\]]*disabled/.test(gates), line("Live"));
    check("collapsed combobox says so — its options are not in the DOM yet", /combobox "City" \[collapsed\]/.test(gates), line("City"));
    check("expanded combobox says so", /combobox "Country" \[expanded\]/.test(gates), line("Country"));

    // ── A control whose SUBTREE is its VALUE, not its name ──────────────────────
    // A <select>'s options and a <textarea>'s content are the value. Neither role takes
    // its name from content, so accname reads the <label> — and so must we: locate.ts
    // recovers a stale ref through getByRole({ name }), which computes the REAL accname,
    // so naming a select by its options breaks the very recovery the name order protects.
    const valued = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>valued</title>'
      + '<label>Plan <select><option>Free</option><option>Pro</option></select></label>'
      + '<label for="size">Size</label><select id="size"><option>Small</option><option>Large</option></select>'
      + '<label for="bio">Bio</label><textarea id="bio">draft text</textarea>'
      + '<select><option>Alpha</option><option>Beta</option></select>',
    )}` }));
    const vline = (needle: string) => valued.split("\n").find((l) => /^e\d+: /.test(l) && l.includes(needle)) ?? `(no line for ${needle})`;
    check("a wrapping <label> names its select", /combobox "Plan"/.test(valued), vline("Plan"));
    check("a for= <label> names its select", /combobox "Size"/.test(valued), vline("Size"));
    check("select options never become the name", !/"Free Pro"/.test(valued), vline("Free"));
    check("a for= <label> names its textarea", /"Bio" \[[^\]]*filled:draft text/.test(valued), vline("Bio"));
    check("an unlabelled select is nameless, not named by its options", !/"Alpha Beta"/.test(valued), vline("Alpha"));

    // The state has to reach the change signature, or the action that UNLOCKS a button
    // reads as "the screen did not change" — the exact wrong advice at that moment.
    // The unlocker is a div, NOT a button: clicking a real button also focuses it, and the
    // focus mark alone flips the verdict to changed — so a button here would pass whether
    // or not disabled reaches the signature, which is the one thing this pins.
    const lock = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>unlock</title>'
      + '<div role="button" onclick="document.getElementById(\'go\').disabled=false">Unlock</div>'
      + '<button id="go" disabled>Submit</button>',
    )}` }));
    check("the gated button starts out marked", /button "Submit" \[disabled\]/.test(lock),
      lock.split("\n").find((l) => l.includes("Submit")) ?? "(no Submit line)");
    const unlock = lock.match(/(e\d+): button "Unlock"/)?.[1];
    check("unlock control found", !!unlock);
    const freed = firstText(await h.act("click", { ref: unlock!, name: "Unlock" }));
    check("enabling a button is a change, not a frozen screen", !freed.includes("did NOT change"),
      freed.split("\n").slice(0, 3).join(" / "));
    const freedSubmit = (await h.api.observe()).elements.find((e) => e.name === "Submit");
    check("the freed button lists without the mark", !!freedSubmit && !freedSubmit.state?.includes("disabled"),
      JSON.stringify(freedSubmit));

    // ── The gate is refused before Playwright's 8 s actionability wait ─────────────
    // Otherwise a click by ref on either state retries for the full 8 s and throws a timeout
    // that never says disabled.
    const gated = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>gated</title>'
      + '<button disabled>Send</button>'
      + '<div role="button" aria-disabled="true">Publish</div>'
      + '<input aria-label="Locked" disabled>',
    )}` }));
    const send = gated.match(/(e\d+): button "Send"/)?.[1];
    const publish = gated.match(/(e\d+): button "Publish"/)?.[1];
    const locked = gated.match(/(e\d+): textbox "Locked"/)?.[1];
    check("gated controls found", !!send && !!publish && !!locked);
    const tGate = Date.now();
    const refusal = await h.act("click", { ref: send!, name: "Send" });
    const refused = refusal.note;
    const elapsed = Date.now() - tGate;
    check("a click on a disabled control fails instead of throwing a timeout", !refusal.ok, refused.slice(0, 90));
    check("it names the reason, which the Playwright timeout never did", /natively disabled/.test(refused), refused.slice(0, 140));
    check("refusing costs no actionability wait (was ~8000ms)", elapsed < 2000, `${elapsed}ms`);
    check("and it does NOT send the model shopping for another element",
      !refused.includes("try another element") && refused.includes("will not unlock it"), refused.slice(-120));
    const refusedAria = (await h.act("click", { ref: publish!, name: "Publish" })).note;
    // aria-disabled is a LABEL: a coordinate click still reaches the handler, so the refusal
    // must not claim the control is unreachable — only that this door is shut.
    check("aria-disabled is refused too, but named as only a label", /aria-disabled/.test(refusedAria) && /x\/y/.test(refusedAria),
      refusedAria.slice(0, 140));
    const fill = await h.act("set_text", { ref: locked!, name: "Locked", text: "hi" });
    check("set_text on a disabled field is refused as well", !fill.ok && /natively disabled/.test(fill.note), fill.note.slice(0, 110));
    // What the refusal tells you to DO depends on what the page waits on, and the page above
    // waits on no field at all (like an Undo disabled because the undo stack is empty), so
    // naming fields would send the model hunting for inputs that do not exist.
    check("with no unfilled field on the page, the cure named is a STATE, not fields",
      /gate is a STATE/.test(refused) && !/\[empty\] \/ \[invalid\]/.test(refused), refused.slice(-150));
    const form = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>gated form</title><form>'
      + '<input aria-label="Email" required>'
      + '<button disabled>Pay</button></form>',
    )}` }));
    const pay = form.match(/(e\d+): button "Pay"/)?.[1];
    check("gated form button found", !!pay);
    const refusedForm = (await h.act("click", { ref: pay!, name: "Pay" })).note;
    check("with an unsatisfied field in its form, the refusal points at the field",
      /\[empty\] \/ \[invalid\]/.test(refusedForm) && !/gate is a STATE/.test(refusedForm), refusedForm.slice(-150));

    // ── A covered target is named after 2 s, not after Playwright's whole 8 s wait ──
    // Two kinds of cover: an overlay element (a modal backdrop), and an ANCESTOR's ::after,
    // which hit-tests as the ancestor and so was dropped as "not covered" (the raw timeout).
    const covers = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>covers</title>'
      + '<style>.bar{position:relative;padding:8px}.bar::after{content:"";position:absolute;inset:0}</style>'
      + '<div class="bar"><button>Add</button></div>'
      + '<button style="margin-top:40px">Behind</button>'
      + '<div aria-label="Backdrop" style="position:fixed;left:0;right:0;top:60px;height:80px"></div>',
    )}` }));
    // A covered control can be left out of the listing; the name still reaches it.
    const add = covers.match(/(e\d+): button "Add"/)?.[1];
    check("the button under the ::after is listed", !!add);
    let tCover = Date.now();
    const byLayer = await h.act("click", { ref: add!, name: "Add" });
    let coverMs = Date.now() - tCover;
    check("a click under an ancestor's ::after fails and names that layer", !byLayer.ok && /::after layer of «div\.bar»/.test(byLayer.note), byLayer.note.slice(0, 140));
    check("it says no element is there to close", /nothing to close/.test(byLayer.note), byLayer.note.slice(0, 200));
    // ~3.3 s on an idle machine (2 s attempt + the act's observation); the old path could not
    // finish under 8 s, its click alone waited that long. The bound is that, not the idle figure.
    check("naming it does not wait out the 8 s actionability budget", coverMs < 8000, `${coverMs}ms`);
    tCover = Date.now();
    const byBackdrop = await h.act("click", { name: "Behind" });
    coverMs = Date.now() - tCover;
    check("a click under an overlay element names it", !byBackdrop.ok && /covered by «fixed bar at the top of the viewport \(Backdrop\)»/.test(byBackdrop.note), byBackdrop.note.slice(0, 140));
    check("nor does naming an overlay", coverMs < 8000, `${coverMs}ms`);
    // Under a sticky header the first click point is covered, yet Playwright scrolls it out from
    // under: the early check must not refuse a click that goes through.
    const sticky = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>sticky</title>'
      + '<header style="position:sticky;top:0;height:90px;background:#eee;z-index:1">Header</header>'
      + '<div style="height:1500px"></div><button id="b" onclick="this.textContent=\'Done\'">Press</button>'
      + '<div style="height:1500px"></div>'
      + '<script>addEventListener("load",()=>scrollTo(0,document.getElementById("b").offsetTop-20))</script>',
    )}` }));
    check("sticky-header page opened", sticky.includes("sticky"));
    const through = await h.act("click", { name: "Press" });
    const done = (await h.api.observe()).elements.some((e) => e.role === "button" && e.name === "Done");
    check("a click under a sticky header still goes through", through.ok && done, through.note ?? "");

    // ── Geometry honesty: a pure move/resize must never read as "no effect" ─────────
    const g0 = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>geometry</title>'
      + '<button style="width:80px" onclick="this.style.width=(this.offsetWidth+40)+\'px\'">Grow</button>',
    )}` }));
    const grow = g0.match(/(e\d+): button "Grow"/)?.[1];
    check("grow button found", !!grow);
    // First click: gains focus AND resizes — the focus-only wording must carry the geometry.
    const g1 = firstText(await h.act("click", { ref: grow!, name: "Grow" }));
    check("focus-move + resize reports the geometry", g1.includes("geometry changed") && g1.includes("resized"),
      g1.split("\n").filter((l) => l.startsWith("NOTE")).join(" | ") || "(no NOTE)");
    // Second click: focus and text identical (frozen signature), width grows again — the
    // frozen denial AND the repeat escalation must both yield to the measured resize.
    const g2 = firstText(await h.act("click", { ref: grow!, name: "Grow" }));
    check("frozen text + resize reports effect, not denial", g2.includes("DID take effect") && !g2.includes("did NOT change"),
      g2.split("\n").filter((l) => l.startsWith("NOTE")).join(" | ") || "(no NOTE)");

    // Ticker variant: body text churns (timer), element lines identical, geometry moves —
    // the swallowed accusation must yield to the measured resize.
    const t0 = firstText(await h.act("open_url", { url: `data:text/html,${encodeURIComponent(
      '<!doctype html><title>ticking geometry</title><p id="t">tick 0</p>'
      + '<button style="width:80px" onclick="this.style.width=(this.offsetWidth+40)+\'px\';this.blur()">Wide</button>'
      + "<script>let i=0;setInterval(()=>{document.getElementById('t').textContent='tick '+(++i)},150)</script>",
    )}` }));
    const wide = t0.match(/(e\d+): button "Wide"/)?.[1];
    check("wide button found", !!wide);
    await new Promise((r) => setTimeout(r, 350)); // guarantee ticks between observations
    const t1 = firstText(await h.act("click", { ref: wide!, name: "Wide" }));
    check("ticker page: resize outranks the swallowed accusation",
      t1.includes("the action DID take effect") && !t1.includes("likely swallowed"),
      t1.split("\n").filter((l) => l.startsWith("NOTE")).join(" | ") || "(no NOTE)");

    await profile.driver.close();
  } finally {
    chrome.cleanup();
  }

  console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
