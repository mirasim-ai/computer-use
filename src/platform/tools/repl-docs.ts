/**
 * The words of `computer_repl`, in the two places they are paid for.
 *
 * `description` is RESIDENT (every session, before any call), so it carries only what a model
 * needs for a good first call. The reference is paid ONCE per session, in the first result, and
 * again on `computer.help()` — so the verb schemas sit in one result, not every session's prefix.
 */

import type { TSchema } from "typebox";
import type { ComputerUseDriver } from "../driver.ts";
import { fnName } from "./api.ts";
import { IDLE_RELEASE_MS } from "../ownership.ts";

/** `windowsApps`: the session mounts the `windows` platform. Windows apps are named only then:
 *  they are not part of this release (registry.ts `windowsAppsOptedIn`), and a description that
 *  promised them would send the model after a surface the session does not have. */
export const replDescription = (windowsApps: boolean): string =>
  // The first sentence names the surfaces in plain words: a client that finds tools by keyword
  // (Claude Code's tool search for "browser") matches on this text, not on the tool's name.
  "Run JavaScript in this session's PERSISTENT runtime to look at and act on the GUI — web pages in a browser, "
  + `Electron apps and native ${windowsApps ? "macOS / Windows" : "macOS"} apps, whichever this server mounts — the one tool for both. `
  + "The code is an async function body: `await` every verb, `return` a value to get it back as JSON; "
  + "top-level const/let/function declarations SURVIVE to later calls, so keep handles and collected data in them. "
  + "Every verb lives on a surface HANDLE (a tab / window / app); there are no top-level verbs. "
  + "Bind first: computer.surface('<id or title>') names one, computer.surface() alone takes the only surface "
  + "or the one this session opened, computer.surfaces() lists them. Then w.observe() w.find(name) w.click(t) "
  + "w.setText(t, text) w.keys(chord) w.scroll({…}) w.wait({…}) w.expect({…}) w.text() w.screenshot({…}) "
  + "and this platform's own verbs (web pages: w.openUrl({url}), w.page({…}), …); a ref read on one surface is refused on another. "
  + "The first bound operation claims the target across calls; await w.release() when its task is done. "
  + "The first result carries the full API reference (computer.help() returns it again) — use only what it documents. "
  + "One verb at a time: a failed action or expect() throws and stops the run; wait() returns false on timeout. "
  + "expect() what the next step needs; return what you are checking. "
  + "Per call: 100 actions, 60 s. No require/import/fetch/process/timers/console. "
  + "Before an operation that may affect the user's foreground, real pointer, keyboard focus or system clipboard "
  + "(including automatic fallback), explain its target and effects and get permission unless existing permission "
  + "covers them; never silently escalate a background operation. "
  + "Before sending a message or publishing a post, let the user confirm its content and recipients or destination, unless they already approved those exact details.";

export const RESET_DESCRIPTION =
  "Reset computer_repl's persistent JavaScript runtime: every binding — handles, variables, functions — is "
  + "discarded, and the next computer_repl call starts fresh and returns the API reference again. Nothing on the "
  + "surfaces changes: no tab, window or app is closed. This runtime's target ownership is released after any active call stops. Use it only when the runtime is "
  + "wedged or its state is wrong, never as a way to \"start over\" on the screen.";

/** Signatures and targeting rules come from the validation schema, including required keys. */
function extraSignature(kind: string, schema: TSchema): string {
  const s = schema as { properties?: Record<string, { description?: string }>; required?: string[]; description?: string };
  const props = Object.keys(s.properties ?? {}).filter((k) => k !== "kind");
  const required = new Set(s.required ?? []);
  const parameter = (key: string) => required.has(key) ? key : `${key}?`;
  // The verb's own description when it has one; else the description of its distinctive field,
  // which then is not repeated on a line of its own. Said WHOLE: a cut to the first sentence lost
  // what models then got wrong (newTab answers with a note, not a handle; drag needs an end).
  const ownKey = s.description ? undefined
    : props.filter((k) => k !== "ref" && k !== "name").find((k) => s.properties?.[k]?.description);
  const said = (s.description ?? (ownKey ? s.properties?.[ownKey]?.description : "") ?? "").trim();
  const fields = props.filter((key) => key !== ownKey)
    .flatMap((key) => s.properties?.[key]?.description
      ? [`    ${parameter(key)}: ${s.properties[key].description}`] : []);
  return [
    `  w.${fnName(kind)}({${props.map(parameter).join(", ")}})${said ? ` — ${said}` : ""}`,
    ...fields,
    ...(required.has("ref") && props.includes("name") ? ["    name does not replace the required ref."] : []),
  ].join("\n");
}

/**
 * The reference in five parts, because two of them vary by PLATFORM and the rest do not.
 *
 * A session may mount several platforms (`COMPUTER_USE_PLATFORMS=macos,browser`): the head, the
 * universal actions, the verdict and the rules are said ONCE per session, and a second platform
 * is told only what is its own — what it can READ and the verbs it adds.
 */
function parts(driver: ComputerUseDriver, windowsApps: boolean) {
  const extras = driver.extraVerbs();
  const nativeApps = windowsApps ? "macOS and Windows" : "macOS";
  const target = "a find() handle or a ref string (click and hover also take a point {x, y} read off a screenshot)";
  return {
    head: [
    "API reference — computer_repl (this text comes once per session; computer.help() returns it again)",
    "",
    // Example first: models copy what they see before they read the rules under it, and every
    // first-call misuse on record is a line here written wrongly (surface() given a URL, openUrl
    // given a string, newTab's answer used as a handle).
    "Start from these — each line is a working call; the rules for every verb follow below:",
    "  const w = await computer.surface();                       // bind once (an id or title, never a URL); later calls reuse w",
    ...(extras.some((v) => v.kind === "open_url") ? [
      "  await w.openUrl({url: 'https://example.com'}); await w.wait({});   // open a page in the bound tab, let it settle",
    ] : []),
    "  return (await w.observe()).elements.filter(e => e.role === 'button').map(e => e.name);   // not sure of a name? look first",
    "  await w.click(await w.find('Save', {role: 'button'}));",
    "  await w.setText(await w.find('Email', {role: 'textbox'}), 'ann@example.com');   // replaces the whole field",
    "  await w.keys('Enter');                                     // one key or chord, never text",
    "  await w.expect({text: 'Saved'});                           // only what the NEXT step needs; throws if it never shows",
    "  return {total: await w.value(await w.find('Total'))};      // what you are checking: return it and judge the result",
    ...(extras.some((v) => v.kind === "new_tab") ? [
      "  await w.newTab({url: 'https://example.com/b'});            // answers with a NOTE naming the new tab's id — not a handle",
      "  const w2 = await computer.surface('<id from that note>');  // w stays on its own tab",
    ] : []),
    "",
    "Everything is async — the verbs AND computer.surfaces() / computer.surface(…): await each. A verb that",
    "fails THROWS with the reason, which stops the run; the journal in the result says what ran. Refs (e12)",
    "come from observe()/find() and stay valid until the surface changes; never invent one, and never carry one in from",
    "another session — a fresh session re-mints them, so the same e12 names a different element. A target `t` is " + target + ".",
    "",
    "Bind a surface first — every verb below is a method on the handle it returns, never a name of its own:",
    "  await computer.surfaces()     → [handle] — every surface (tab / window / app) as {id, kind, title, active}; `id` is an opaque key, what the platform knows the surface by lives in `title` (macOS: \"TextEdit (com.apple.TextEdit) — Untitled\"" + (windowsApps ? "; Windows: the window title, then the program name — \"Untitled - Notepad — Notepad\"" : "") + ")",
    "  await computer.surface(name)  → handle — by id, by whole title, or by a piece of the title; several matches or none is a refusal that lists the candidates, never a guess. With several platforms mounted an id carries its platform (browser/t2); the bare id (t2) also binds when only one platform has it",
    "  await computer.surface()      → handle — the surface this call was given by its host (the call's own target / app argument), else the ONE surface when there is only one, else the tab this session opened or claimed (the one it is on, when it has several). A session that has opened nothing yet gets a handle whose openUrl({url}) / newTab({url}) opens its first tab. Not \"whatever is in front\": with several open and none of them this session's own, it refuses and lists them, so a script always says which it meant",
    "  Bind once per surface and keep the handle in a top-level declaration — it stays valid for later calls, and re-binding costs a read each time.",
    "  computer.lastRun()            → {secondsAgo, cancelled, journal:[line]} | null — what the call BEFORE this one did, in its own journal. Ask it first after a call that timed out or never answered you: its steps may have been made, and making them again can submit twice. A call your client cancelled is also told to you by the next result, once, without asking.",
    ...(driver.platform === "browser" ? ["  A browser tab marked unloaded:true is still discoverable. Using its handle restores that exact tab in the background after acquiring ownership; merely listing tabs never reloads it."] : []),
    "",
    ],
    reads: [
    ...driver.interactionNotes(),
    "Reads (return data to your code; you see it only through `return` or computer.log — except a screenshot, whose image is attached to the result):",
    "  w.observe({screenshot?}) → {url, title, elements:[{ref, role, name, state, rect, offscreen?}], groups?, headings?, partial?, coverage, target?} — every control, viewport and beyond; filter the array rather than asking it to narrow. `rect` {x, y, w, h} is the control's box — compare boxes to answer layout questions (which row a control sits on, whether it moved) without a screenshot. `groups` is the page's OWN labelling of those controls — [{label, members:[ref]}] over that same set, off-viewport members included — present where the author wrote one, and the only place some facts exist (a feed labels each post's button row with its counts, bookmarks included, which no control name and no page text carries). `headings` (web surfaces) is [{name, level, rect}] for the page's headings, never listed as controls — the fixed point to measure a control's box against, since a click can scroll the container under every control in a card. `partial` (a reason) says the read stopped before covering the surface, so what it did not list may still be there. screenshot:true also attaches the picture of the same screen (one call, two reads), for when you need to SEE where something is",
    "    coverage reports exact {offscreen, covered, capped, modal?} counts (null when unreported) even when repeated context notes are omitted. Electron target reports the CDP endpoint, windowId and, when its user agent carries them, the app's own name/version; never infer the app version from the tool or helper path.",
    "  w.find(name, {role?, within?, visible?, near?, why?}) → {ref, name, matches, others, incidental?} | null — by visible name, "
      + "whole surface"
      + " (an exact name beats a partial one, a partial the query is most of beats one it is only a fragment of, and a control beats a text label); a handle that re-resolves itself when used, so a loop survives a re-render; `matches` says how many controls carried the name and `others` names the runners-up, so an ambiguous name is visible BEFORE you act on the pick — and a write (click, setText, a platform verb's ref) on a pick whose runner-up has the same role and name is refused as a guess, so narrow it first; `incidental: true` says NOTHING here is NAMED that and the pick is only a long name that happens to contain the word — the one `matches: 1` not to trust; narrow it with role (button / textbox / …), within (a ref or handle — matches inside that element's box, e.g. one sheet or one message)"
      + " visible (on screen only)"
      + " and near (a labelled group restricts candidates to its members; otherwise prefer the control closest to what it names — another control by name, ref or handle"
      + (driver.locateAnchor ? ", a heading, a labelled region, or any text the page shows, so near:'Revenue by day' picks that card's Share" : "")
      + "). Duplicate group labels or same-named controls within a group still need disambiguation",
    // `why` is opt-in so every `if (!el)` already written keeps meaning "no match". Each reason
    // is offered only where this platform can answer it (find-target.ts `MissReason`).
    "    why: true — a miss answers {ref: null, reason, note, match?, by?, partial?} instead of null, so code can pick the way out in the SAME run (test `el.ref`, not `el`); a match answers the same handle as without it. "
      + "reason: " + [
        ...(driver.readsCovered ? ["'covered' (a control carries the name, under an overlay: `match` is that control — scroll({into: match.ref}) takes it — and `by` {name, ref?} is the cover, with a ref only when the cover is itself a listed control; dismiss it (Escape, its close control) or scroll it clear, then find again)"] : []),
        "'offscreen' (only with visible:true: `match` is the control, not on screen)",
        "'filtered' (role / within / a near group excluded the control in `match`)",
        "'text' (no control carries it, the readable text does — read it, nothing to act on)",
        "'absent' (nothing carries it: wait for it, or fail)",
      ].join(", ")
      + (driver.readsCovered ? "" : ". This platform's read never reports what an overlay covers, so a covered control reads as 'absent'")
      + ". `note` is the journal's line; `partial` (a reason) says the read stopped early, so even 'absent' is not proof. "
      + "e.g. let m = await w.find('Menu', {role: 'button', why: true}); if (!m.ref && m.reason === 'covered') { await w.keys('Escape'); await w.wait({}); m = await w.find('Menu', {role: 'button', why: true}); } await w.click(m); — a miss passed to a verb is refused with its own note, so no check is written around it.",
    "  w.text()                 → the surface's readable text (on a web page: its main content, with a note saying what header / navigation / footer text was left out — wait({text}) still searches all of it)",
    // Offered only where a driver can answer for one element: promising it elsewhere would send
    // the model at a name that throws, and text() is the honest answer there.
    ...(driver.readValue ? ["  w.value(t)               → ONE control's whole value as a string — a long field, a clipped label, "
      + "the text you are about to edit. The listing shows a value cut to what a line holds; this is the rest of it, for one element, "
      + "where text() re-reads the whole surface"] : []),
    ...(driver.readPage ? ["  w.page({ref?, depth?, node?}) → the content tree as text, with a completeness receipt on its first line"] : []),
    "  w.screenshot({ref?, padding?|region:{x,y,width,height}?|fullPage?, path?}) → {path, host, width, height, note, capture?} — the image is attached to this result for you to see AND written to a file the code can keep: to `path` (absolute, never overwrites an existing file, extension must match the surface's format — .jpg on web surfaces, .png on " + nativeApps + ") or else to a rolling temp directory; `host` names the machine the path is on; no image → {path: null, note: why}. ref is a ref string and crops to a visible element's box; padding keeps its surroundings. fullPage is web-only. On " + nativeApps + ", ref/region preserve native detail; region uses FULL screenshot pixels, so take a full screenshot first. " + (windowsApps ? "Windows padding and crop bounds use physical pixels; " : "") + "macOS padding uses full-screenshot pixels when available, otherwise window points. capture reports the window, crop, units, pointsPerPixel, and toFullScreenshot (null without a full screenshot or when window geometry changed). " + (windowsApps ? "Windows refuses a region based on old window geometry; take a new full screenshot. " : "") + "Convert crop pixel p to full screenshot coordinates with toFullScreenshot.origin + p * toFullScreenshot.scale on each axis. A crop never changes point-action coordinates; use a current mapping or act by ref.",
    // Worded by the PLATFORM: console and failed requests on a page, the accessibility helper's
    // own complaints on macOS.
    ...(driver.supportsDiagnostics ? [`  w.diagnostics({id?})     → ${driver.diagnosticsAbout.empty} — the newest 20, with the ones new since your last read marked "new"`] : []),
    "  computer.log(…)               → a line in the journal; like help() and lastRun() it is on `computer`, not on a surface",
    "",
    ],
    actions: [
    "Actions (every one is w.verb(…) on a bound handle, which switches to that surface first):",
    "  w.click(t, {button?, count?})   w.hover(t)",
    "  w.setText(t, text) — replace the target field's ENTIRE value, even after selectText; never a selection/caret edit. Returns true when read-back matches; throws WriteVerificationError on mismatch, stopping the run unless caught.",
    "  w.setTextBestEffort(t, text) — the same whole-field replacement, returning true/false without throwing on mismatch. Both return undefined when read-back is unavailable; that is not verification.",
    "    click and hover also take a POINT — w.click({x, y}) — in the coordinates of the last screenshot, for a control you",
    "    can see and cannot name. It checks no identity (no stale-ref gate, no name, no surface check) and so acts on",
    "    whatever is at that spot NOW: take observe({screenshot: true}) and read the coordinates off that picture.",
    "    click / hover / keys / scroll answer with what they did, as text — the same note the journal shows, e.g. which",
    "    rung a click ended on. A verb that FAILS throws instead, so a returned string always describes something that happened.",
    "  w.keys(chord, count?, {focus?})  e.g. w.keys('Enter'), w.keys('Backspace', 3), w.keys('Enter', {focus: field}) — one key or chord, never a text string (text is refused: setText replaces a field, the platform's paste/type verb inserts at the caret); count is at most 20, and a larger one is refused before anything is pressed. setText replaces a whole field; use the platform's paste/type verb to edit at a selection or caret.",
    "    keys go wherever the surface has the keyboard focus. Pass focus: <target> to REQUIRE it be there: if it is not,",
    "    nothing is pressed, including when focus is unknown or ambiguous. Omit focus only to send without that check. Focusing stays explicit (click / setText / selectText with a caret).",
    "  w.scroll({direction?: up|down|left|right, count?: screens (default 1), to?: top|bottom, ref?})   w.wait({} | {ms} | {text} | {text_gone} | {control} | {control_gone} | {url} | {url_gone} | {loaded}) → ok",
    "    count covers that many screens in ONE call — the note says how far it actually got, which is less once the end is reached;",
    "    count and to: are refused together, since to: already goes as far as the surface scrolls.",
    "    Browser/Electron list scrollable regions with refs. With several regions, pass ref:<region or a control inside it — a ref or a find() handle>; a bare scroll refuses and lists the choices. ref:'window' explicitly scrolls the page. Reaching an edge never switches to another region.",
    ...(driver.platform === "macos" ? ["    macOS: name an element inside the list or pane to scroll — scroll({direction, ref}) turns that area's own page through accessibility, with the app in the background and the pointer untouched. With no ref the scroll aims at the window's centre, which in a sidebar-and-pane window is the other pane; where no accessibility scrolling area is found only the mouse wheel is left, and a background call refuses it. A list that builds its rows as they scroll in lists the rows past the window with no name: page it, then find."] : []),
    ...(driver.scrollsInto ? ["    w.scroll({into: t}) instead brings ONE control (a ref or a find() handle) to the middle of the viewport and says whether anything still covers it. It takes a covered control's ref too — the way out from under a sticky header or a bottom strip that a screen of scrolling overshoots."] : []),
    "    a wait polls until the condition holds or it times out, and says which: {text…} searches the readable text,",
    "    {control…} the CONTROLS by name (\"until the Stop button is gone\" — the honest way to wait out a long answer),",
    "    {url}/{url_gone} where the surface IS (substring, so a query string needs no spelling out), and {loaded:true} that",
    "    the DOCUMENT finished. Reach for it before reporting that a page has nothing on it: a document that never finishes",
    "    reads as an empty page and no content condition can tell you which it was. It is NOT rendered — a single-page app",
    "    reaches loaded with nothing drawn yet (measured), so follow it with the CONTENT wait, which is w.wait({}):",
    "    it polls until the readable text stops changing, so it is the one \"the page is ready\" condition that needs no word",
    "    from the page and no knowledge of the site. Use it after a navigation, a tab switch inside a page, or a search — a",
    "    single-page app mounts its rows well after {loaded}, and an observation taken before that reads as an empty page.",
    "    Also after a click that REDRAWS content (a chart, a list) and before you screenshot or read it: the control's own state",
    "    updates at once, the content a beat later, so a read straight after the click can pair the new button with the old view.",
    "    Every condition takes ms as its OWN polling budget: w.wait({text:'Done', ms:3000}) gives up in three seconds,",
    "    give or take the one read already in flight when it runs out — on a heavy surface a single read is seconds, and the result says so when that happened.",
    "    wait() returns true/false; awaiting it alone does NOT stop on timeout. When the NEXT step needs the condition use expect(), which stops the run;",
    "    for a condition expect() does not take (text_gone, control_gone, url_gone) check the wait — if (!await w.wait({control_gone:'Saving…'})) throw new Error('still saving') — and when you only want to know, return it.",
    "    Without ms, something APPEARING ({text}, {control}, {url}) is given 8s and everything else ({…_gone}, {loaded}, {}) 16s. Pass ms both ways: a long one",
    "    for what is known to be slow — w.wait({text:'Calculated in', ms:20000}) for a report that computes — and a short one for a GUESS at the wording,",
    "    since a guess no page ever matches costs its whole budget.",
    "    A wait that gave up on a control or on text APPEARING says, in its journal line, which control names or lines of text come closest.",
    "    w.wait({ms}) with no condition is a plain pause of that long. An option wait does not read is refused, not ignored (timeout → ms; selector → control or text).",
    "    control_gone on a name no listed control carries waits for a status line of that name in the text to go — a progress bar, a spinner,",
    "    a 'Loading…' line is often not a listed control.",
    "  w.focus() — select w as the target for this runtime (returns nothing); target selection is not an OS-activation guarantee (see platform interaction notes)",
    `  w.release() — release this target and its input resources for other sessions. Claims span calls until release, reset, turn end, process exit or ${IDLE_RELEASE_MS / 60_000} minutes with no call (the next call takes the target back unless another session has it by then). Observe again before acting after handoff; old refs are invalidated. Separate windows can still share app/account/document state; ownership does not isolate those or a human editor.`,
    "  w.expect({text, control, url, value, equals, ms}) — verify exactly ONE condition; value takes a ref/find handle and equals:string. Read-only polling, default 3000 ms, maximum 16000 ms. Returns true when verified; otherwise throws before subsequent steps, and the reason says what was there instead — the value the field holds, the closest control names, the closest lines of text, the address — so the next call can act on it without observing first. It never repeats the preceding action. Use it for what the NEXT step depends on (the save went through, the list is back), not for the outcome you are checking: return that (see \"Verify by returning\" below).",
    "  w.setText(t, text, {ifValue:previousValue}) — optional precondition: refuse before writing if the field changed or cannot be read. This is a checked precondition, not an atomic transaction with a human or another app.",
    "Action journal evidence: [verified] confirms the stated value/condition; [dispatched] only confirms delivery; [blocked] means no dispatch; [uncertain] may already have acted. Never replay an uncertain send/submit/delete; inspect its actual result first.",
    ],
    extras: [
    ...(extras.length ? [
      "  This platform's verbs — each returns what it did as text (the journal keeps only its first line, so a listing is read from the return value):",
      "    In these signatures, ? marks an optional property; every unmarked property is required. Omit the ? in JavaScript calls.",
      ...extras.map((v) => extraSignature(v.kind, v.schema)),
    ] : []),
    ...(extras.some((v) => v.kind === "select_option") ? [
      "    selectOption example: await w.selectOption({ref: await w.find('Priority', {role:'combobox'}), option:'High'}); — ref takes the find() handle itself: a miss is refused with find's own reason and a same-name tie with its candidates, so no check is written around it.",
    ] : []),
    // The one verb that computes rather than acts answers with its result, so say so where it is listed.
    ...(extras.some((v) => v.kind === "run_js") ? ["    runJs is the exception: it returns the VALUE the code produced, whole (the journal shows a short preview); an exception thrown in the page comes back as the string \"threw: …\" instead of stopping the run. It waits 10s for that value; runJs({code, ms}) waits up to 45s for code meant to run longer, within the call's 60s."] : []),
    ...(extras.some((v) => v.kind === "download") ? ["    download also returns a VALUE: const watch = await w.download(); await w.click(await w.find('Download')); const result = await w.download({id:watch.id}); return result; result.downloads carries the actual path, filename, host and state. Read/upload only complete receipts. Query the same ID after a timeout; several candidates mean ambiguous, never the newest file. Re-arming this tab ends its previous collection; stop:true explicitly ends collection without canceling any download. On this session's own tabs a page's save dialog (showSaveFilePicker) never opens: its file arrives as a download marked source \"save-picker\"."] : []),
    ],
    tail: [
    "  w.act(kind, {…}) — any verb by its wire name, arguments forwarded whole; returns its text like the platform verbs",
    "",
    "Observation changes use + for added controls, - for removed controls, and ~ for a surviving ref whose state or label changed. Scope and grouping explanations repeat only when their context changes; observe() still returns the complete available data.",
    "The changed/frozen verdict compares this run's end with the previous run's end: a run whose last action puts the",
    "surface back where it started reads as unchanged — return your own intermediate observe() results when you need proof.",
    "",
    "Rules that are enforced, not advised:",
    "  · one verb in flight — a second one before the first resolves is refused by name (one focus, one caret)",
    "  · a ref read on surface A is refused on surface B — act on it through A's handle",
    "  · a handle whose surface is gone throws: re-acquire with computer.surfaces() — except wait(), which answers false (true for a …_gone condition, since what it waited on went too) and journals that the surface is gone",
    "  · a target another session holds refuses every verb on it, reads included (\"in use by another runtime\"): use another target or wait for its release",
    "  · 100 actions and 60 s per call; reads, find(), waits, verification and computer.log() also spend this budget",
    "  · JavaScript's own built-ins (JSON, Math, Date, Promise, Intl…) plus URL and URLSearchParams, and nothing else: no require, import, fetch, process, timers (setTimeout), console — computer.log writes a journal line",
    "",
    "Persistence: top-level const/let/var/function/class declarations live until computer_repl_reset, or until a host reaps a runtime",
    "left idle (the next result says so and carries this reference again). Keep a handle in one and reuse it; collect results in a",
    "variable across calls; return only what you need. A handle that is suddenly not defined needs computer.surface() again.",
    "Batch at verified task boundaries, with room for observation and recovery. A helper's nested verbs also count: a loop of 35 find/setText/expect sequences exceeds 100 actions. Split it into smaller calls.",
    "",
    "Writing the code — what costs a round trip most often:",
    "Go on in the same call. When the NEXT stage needs a condition to hold — the save went through, the list is back — state it with",
    "expect() and do the next stage in the same code; a failed expect stops the run and says what was there instead:",
    "  await w.click(await w.find('Save', {role: 'button'}));",
    "  await w.expect({text: 'Saved'});                          // the next stage needs the save…",
    "  await w.expect({url: '/tasks'});                          // …and the list it returns to",
    "  await w.click(await w.find('New task', {role: 'button'})); // next stage, same call",
    "  expect() takes no …_gone condition; there, check the wait: if (!await w.wait({control_gone: 'Saving…'})) throw new Error('still saving').",
    "  A find() that matched nothing needs no check of its own: the verb it is passed to refuses the null, and its journal line says why.",
    "Verify by returning, not by asserting. What you want to SEE — the outcome the task asked you to check, a value to report — is not a",
    "condition for the code to judge. Read it, return it, and judge it from the result:",
    "  await w.setText(await w.find('Quantity'), '3');",
    "  await w.click(await w.find('Update', {role: 'button'}));",
    "  await w.wait({});",
    "  return {total: await w.value(await w.find('Total')), url: (await w.observe()).url, list: (await w.text()).slice(0, 400)};",
    "  Do not compare such values in code and throw (if (total !== '$30.00') throw new Error(…)): a comparison that fails ends the call",
    "  before `return`, so the values are gone and the script is written again — and these checks fail often, on a guess at wording, a",
    "  count or a format. In a QA task the unexpected value IS the finding. The observation that ends every result already shows the",
    "  surface after the last action: do not expect() again what it will show.",
    "Look before you guess. A name you have not seen on this surface is a guess, and a guess that misses stops the run after the steps",
    "before it have acted: take the names from observe() (or find(name, {why: true}), which says why it missed) before writing a",
    "sequence of finds. near: names something the surface really shows — read text() first; a heading you expect is not an anchor.",
    "Keep find() handles across calls, not refs: a handle finds its control again after a re-render; a ref from before a navigation or",
    "a reload is refused.",
    "Return what you need, not whole reads: return await w.observe() repeats the observation the result already ends with and runs",
    "into the 12000-character cap; filter elements, or slice text(), first.",
    "Branch on the page only for a KNOWN detour with no side effect — a layer to close, a control still to come, a toggle named by its",
    "state — and let find's why say which way out applies:",
    "  let m = await w.find('Menu', {role: 'button', why: true});",
    "  if (m.reason === 'covered') { await w.keys('Escape'); await w.wait({}); }   // m.by names the cover",
    "  else if (m.reason === 'absent') await w.wait({control: 'Menu'});",
    "  if (!m.ref) m = await w.find('Menu', {role: 'button', why: true});",
    "  await w.click(m);                                         // a miss still there is refused with its note",
    "  const toggle = await w.find('Light mode', {role: 'button'}) ?? await w.find('Dark mode', {role: 'button'});",
    "  await w.wait({text_gone: 'Loading'});                     // a load needs no branch: returns at once when nothing is loading",
    "  What why cannot settle: 'filtered' and 'text' mean your query is wrong, not the page" + (driver.readsCovered ? "" : "; here a covered control reads as 'absent'") + ". Fix the query or look.",
    "Where code must not choose:",
    "  · a confirm, delete, submit, send or payment: no branch leads into one, and no try/catch steps past one that failed or came back",
    "    [uncertain] — stop, read its result, and act on what you see;",
    ...(extras.some((v) => v.kind === "dialog") ? [
      "  · a confirm dialog: dialog({answer: 'accept'}) armed before the click accepts text you never read. Click without arming — the",
      "    confirm is dismissed and the result's NOTE line quotes it — read it, and only if it says what you meant to do, arm accept and click again;",
    ] : []),
    "  · an unexpected sign-in page: the session was lost, maybe by the change under test, maybe as the bug itself. Stop and look instead of",
    "    signing in from code — unless the task or the user gave the account and said a sign-in may come up again;",
    "  · an option that is not there: when a select lacks the option you expected, read the options and report it; do not quietly pick",
    "    another — in a QA task that is the finding.",
    "Keep a top-level checkpoint after each confirmed stage. After an uncertain save/submit, inspect or expect its result before resuming; replaying the whole batch can submit twice. A dispatched checkpoint is not proof of success. Reset or runtime restart loses checkpoints, so recover from surface facts then.",
    "Returned values are capped at 12000 characters and a cut JSON value is not parseable. Read a large result once into a top-level variable, return a small slice per call, and check the final count/identity; do not re-read or replay the task to retrieve the next slice.",
    ],
  };
}

/** The whole reference — what a session's FIRST platform is told, and what computer.help() answers. */
/** `windowsApps`: the session mounts the `windows` platform — what is said of Windows apps is
 *  said only then (@see replDescription). A Windows driver's own reference always says it. */
export function apiReference(driver: ComputerUseDriver, windowsApps = driver.platform === "windows"): string {
  const p = parts(driver, windowsApps);
  return [...p.head, ...p.reads, ...p.actions, ...p.extras, ...p.tail].join("\n");
}

/** Only what THIS platform adds — for a session that already has the rest. */
export function platformReference(driver: ComputerUseDriver, windowsApps = driver.platform === "windows"): string {
  const p = parts(driver, windowsApps);
  return [
    `Reaching a second platform: ${driver.platform} — everything else in the reference above still holds, `
      + "and these are the reads and verbs that are its own.",
    "",
    ...p.reads,
    ...p.extras,
  ].join("\n");
}
