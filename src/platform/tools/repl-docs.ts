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

export const REPL_DESCRIPTION =
  // The first sentence names the surfaces in plain words: a client that finds tools by keyword
  // (Claude Code's tool search for "browser") matches on this text, not on the tool's name.
  "Run JavaScript in this session's PERSISTENT runtime to look at and act on the GUI — web pages in a browser, "
  + "Electron apps and native macOS / Windows apps, whichever this server mounts — the one tool for both. "
  + "The code is an async function body: `await` every verb, `return` a value to get it back as JSON, and "
  + "top-level const/let/function declarations SURVIVE to later calls — keep handles and collected data in "
  + "them instead of re-reading. Surfaces (tabs / windows / apps) are HANDLES and EVERY verb lives on one — "
  + "there are no top-level verbs. Bind first: computer.surface('<id or title>') names one, computer.surface() alone "
  + "takes the only surface, or the one this session opened when other tabs are open too, computer.surfaces() lists them. Then w.observe() w.find(name) "
  + "w.click(t) w.setText(t, text) w.keys(chord, n) w.scroll({…}) w.wait({…}) w.text() w.page({…}) "
  + "w.screenshot({…}) and this platform's own verbs, each switching to that surface as needed; a ref read on "
  + "one surface is refused on another. Bind ONCE — keep the handle in a top-level variable and later calls "
  + "reuse it. The first bound operation claims the target across calls; await w.release() when its task is done. "
  + "Another runtime's claim refuses input before dispatch. The first result carries the full API reference (computer.help() returns it again) — "
  + "use only what it documents. One verb at a time (one focus, one caret): a failed action or expect() throws and stops "
  + "the run; wait() instead returns false on timeout, so check it or use expect() for a required condition. "
  + "The result is the step journal plus one observation of the surface it acted on. Per call: "
  + "100 actions, 60 s. No require/import/fetch/process/timers. Before using an operation that may affect "
  + "the user's foreground, real pointer, keyboard focus or system clipboard (including automatic fallback), "
  + "explain its target and effects and obtain permission unless existing permission covers them. "
  + "Do not silently escalate a background operation; inspect computer.help() for platform-specific effects. "
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
  // The verb's own description when it has one; else the description of its distinctive field
  // (targeting fields have their own lines below, since their meaning varies by platform).
  const own = props.filter((k) => k !== "ref" && k !== "name").map((k) => s.properties?.[k]?.description).find(Boolean);
  const said = s.description ?? own ?? "";
  const sentence = /^.*?[.!?](?=\s+[A-Z(`]|$)/s.exec(said)?.[0] ?? said;
  const targeting = props.filter((key) => key === "ref" || key === "name")
    .flatMap((key) => s.properties?.[key]?.description
      ? [`    ${parameter(key)}: ${s.properties[key].description}`] : []);
  return [
    `  w.${fnName(kind)}({${props.map(parameter).join(", ")}})${sentence ? ` — ${sentence.trim()}` : ""}`,
    ...targeting,
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
function parts(driver: ComputerUseDriver) {
  const extras = driver.extraVerbs();
  const target = "a find() handle, a ref string, or a point {x, y} read off a screenshot";
  return {
    head: [
    "API reference — computer_repl (this text comes once per session; computer.help() returns it again)",
    "",
    "Everything is async — the verbs AND computer.surfaces() / computer.surface(…): await each. A verb that",
    "fails THROWS with the reason, which stops the run; the journal in the result says what ran. Refs (e12)",
    "come from observe()/find() and stay valid until the surface changes; never invent one, and never carry one in from",
    "another session — a fresh session re-mints them, so the same e12 names a different element. A target `t` is " + target + ".",
    "",
    "Bind a surface first — every verb below is a method on the handle it returns, never a name of its own:",
    "  await computer.surfaces()     → [handle] — every surface (tab / window / app) as {id, kind, title, active}; `id` is an opaque key, what the platform knows the surface by lives in `title` (macOS: \"TextEdit (com.apple.TextEdit) — Untitled\"; Windows: the window title, then the program name — \"Untitled - Notepad — Notepad\")",
    "  await computer.surface(name)  → handle — by id, by whole title, or by a piece of the title; several matches or none is a refusal that lists the candidates, never a guess",
    "  await computer.surface()      → handle — the ONE surface, when there is only one. Not \"whatever is in front\": with more than one open it refuses and lists them, so a script always says which it meant",
    "  Bind once per surface and keep the handle in a top-level declaration — it stays valid for later calls, and re-binding costs a read each time.",
    "  A browser tab marked unloaded:true is still discoverable. Using its handle restores that exact tab in the background after acquiring ownership; merely listing tabs never reloads it.",
    "",
    ],
    reads: [
    ...driver.interactionNotes(),
    "Reads (return data to your code; none of them is shown to you except through `return` or computer.log):",
    // What a read CONTAINS decides whether find() can be promised the whole surface; promising it
    // where only the viewport is walked costs the model calls (driver-base.ts `readsOffscreen`).
    driver.readsOffscreen
      ? "  w.observe({screenshot?}) → {url, title, elements:[{ref, role, name, state, rect, offscreen?}], groups?, headings?, partial?, coverage, target?} — every control, viewport and beyond; filter the array rather than asking it to narrow. `rect` {x, y, w, h} is the control's box — compare boxes to answer layout questions (which row a control sits on, whether it moved) without a screenshot. `groups` is the page's OWN labelling of those controls — [{label, members:[ref]}] over that same set, off-viewport members included — present where the author wrote one, and the only place some facts exist (a feed labels each post's button row with its counts, bookmarks included, which no control name and no page text carries). `headings` (web surfaces) is [{name, level, rect}] for the page's headings, never listed as controls — the fixed point to measure a control's box against, since a click can scroll the container under every control in a card. `partial` (a reason) says the read stopped before covering the surface, so what it did not list may still be there. screenshot:true also attaches the picture of the same screen (one call, two reads), for when you need to SEE where something is"
      : "  w.observe({screenshot?}) → {url, title, elements:[{ref, role, name, state, rect}], coverage} — every control the window SHOWS (`rect` {x, y, w, h} is its box — compare boxes to answer layout questions without a screenshot); one scrolled out of view is counted in the observation and never listed, so no ref names it until a scroll brings it in; filter the array rather than asking it to narrow. screenshot:true also attaches the picture of the same screen",
    "    coverage reports exact {offscreen, covered, capped, modal?} counts (null when unreported) even when repeated context notes are omitted. Electron target reports the CDP endpoint, windowId and, when its user agent carries them, the app's own name/version; never infer the app version from the tool or helper path.",
    "  w.find(name, {role?, within?, " + (driver.readsOffscreen ? "visible?, " : "") + "near?}) → {ref, name, matches, others, incidental?} | null — by visible name, "
      + (driver.readsOffscreen ? "whole surface" : "everything the window shows — NOT what is scrolled out of it, which this platform's read does not contain")
      + " (an exact name beats a partial one, a partial the query is most of beats one it is only a fragment of, and a control beats a text label); a handle that re-resolves itself when used, so a loop survives a re-render; `matches` says how many controls carried the name and `others` names the runners-up, so an ambiguous name is visible BEFORE you act on the pick; `incidental: true` says NOTHING here is NAMED that and the pick is only a long name that happens to contain the word — the one `matches: 1` not to trust; narrow it with role (button / textbox / …), within (a ref or handle — matches inside that element's box, e.g. one sheet or one message)"
      + (driver.readsOffscreen ? " visible (on screen only)" : "")
      + " and near (a labelled group restricts candidates to its members; otherwise prefer the control closest to the named element). Duplicate group labels or same-named controls within a group still need disambiguation",
    "  w.text()                 → the surface's full readable text",
    // Offered only where a driver can answer for one element: promising it elsewhere would send
    // the model at a name that throws, and text() is the honest answer there.
    ...(driver.readValue ? ["  w.value(t)               → ONE control's whole value as a string — a long field, a clipped label, "
      + "the text you are about to edit. The listing shows a value cut to what a line holds; this is the rest of it, for one element, "
      + "where text() re-reads the entire surface"] : []),
    ...(driver.readPage ? ["  w.page({ref?, depth?, node?}) → the content tree as text, with a completeness receipt on its first line"] : []),
    "  w.screenshot({ref?, padding?|region:{x,y,width,height}?|fullPage?, path?}) → {path, host, width, height, note, capture?} — the image is attached to this result for you to see AND written to a file the code can keep: to `path` (absolute, never overwrites an existing file, extension must match the surface's format — .jpg on web surfaces, .png on macOS and Windows) or else to a rolling temp directory; `host` names the machine the path is on; no image → {path: null, note: why}. ref is a ref string and crops to a visible element's box; padding keeps its surroundings. fullPage is web-only. On macOS and Windows, ref/region preserve native detail; region uses FULL screenshot pixels, so take a full screenshot first. Windows padding and crop bounds use physical pixels; macOS padding uses full-screenshot pixels when available, otherwise window points. capture reports the window, crop, units, pointsPerPixel, and toFullScreenshot (null without a full screenshot or when window geometry changed). Windows refuses a region based on old window geometry; take a new full screenshot. Convert crop pixel p to full screenshot coordinates with toFullScreenshot.origin + p * toFullScreenshot.scale on each axis. A crop never changes point-action coordinates; use a current mapping or act by ref.",
    // Worded by the PLATFORM: console and failed requests on a page, the accessibility helper's
    // own complaints on macOS.
    ...(driver.supportsDiagnostics ? [`  w.diagnostics({id?})     → ${driver.diagnosticsAbout.empty} — the newest 20, with the ones new since your last read marked "new"`] : []),
    "  computer.log(…)               → a line in the journal; the one member that is not on a surface",
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
    "    click / hover / keys / scroll / focus answer with what they did, as text — the same note the journal shows, e.g. which",
    "    rung a click ended on. A verb that FAILS throws instead, so a returned string always describes something that happened.",
    "  w.keys(chord, count?, {focus?})  e.g. w.keys('Enter'), w.keys('Backspace', 3), w.keys('Enter', {focus: field}) — one key or chord, never a text string. setText replaces a whole field; use the platform's paste/type verb to edit at a selection or caret.",
    "    keys go wherever the surface has the keyboard focus. Pass focus: <target> to REQUIRE it be there: if it is not,",
    "    nothing is pressed, including when focus is unknown or ambiguous. Omit focus only to send without that check. Focusing stays explicit (click / setText / selectText with a caret).",
    "  w.scroll({direction?: up|down|left|right, count?: screens (default 1), to?: top|bottom, ref?})   w.wait({} | {ms} | {text} | {text_gone} | {control} | {control_gone} | {url} | {url_gone} | {loaded}) → ok",
    "    count covers that many screens in ONE call — the note says how far it actually got, which is less once the end is reached;",
    "    count and to: are refused together, since to: already goes as far as the surface scrolls.",
    "    Browser/Electron list scrollable regions with refs. With several regions, pass ref:<region or a control inside it>; a bare scroll refuses and lists the choices. ref:'window' explicitly scrolls the page. Reaching an edge never switches to another region.",
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
    "    Every condition takes ms as its OWN polling budget (default 16s): w.wait({text:'Done', ms:3000}) gives up in three seconds,",
    "    give or take the one read already in flight when it runs out — on a heavy surface a single read is seconds, and the result says so when that happened.",
    "    wait() returns true/false; awaiting it alone does NOT stop on timeout. Use expect() for a required postcondition, or check the result: if (!await w.wait({...})) throw new Error('condition not met');",
    "    which is what a GUESS at the wording is worth — an unguarded guess that no page ever matches costs the full 16s.",
    "  w.focus() — select w as the target for this runtime; target selection is not an OS-activation guarantee (see platform interaction notes)",
    "  w.release() — release this target and its input resources for other sessions. Claims span calls until release, reset, turn end or process exit. Observe again before acting after handoff; old refs are invalidated. Separate windows can still share app/account/document state; ownership does not isolate those or a human editor.",
    "  w.expect({text, control, url, value, equals, ms}) — verify exactly ONE condition; value takes a ref/find handle and equals:string. Read-only polling, default 3000 ms, maximum 16000 ms. Returns true when verified; otherwise throws before subsequent steps. It never repeats the preceding action. Use it to verify save/submit results, not screen-change verdicts.",
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
      "    selectOption example: const choice = await w.find('Priority', {role:'combobox'}); if (!choice || choice.matches !== 1 || choice.incidental) throw new Error('Priority is missing or ambiguous'); await w.selectOption({ref:choice.ref, option:'High'});",
    ] : []),
    // The one verb that computes rather than acts answers with its result, so say so where it is listed.
    ...(extras.some((v) => v.kind === "run_js") ? ["    runJs is the exception: it returns the VALUE the code produced, whole (the journal shows a short preview); an exception thrown in the page comes back as the string \"threw: …\" instead of stopping the run."] : []),
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
    "  · a handle whose surface is gone throws: re-acquire with computer.surfaces()",
    "  · 100 actions and 60 s per call; reads, find(), waits, verification and computer.log() also spend this budget",
    "  · nothing outside this API exists: no require, import, fetch, process, timers, console",
    "",
    "Persistence: top-level const/let/var/function/class declarations live until computer_repl_reset. Keep a",
    "handle in one and reuse it; collect results in a variable across calls; return only what you need.",
    "Batch at verified task boundaries, with room for observation and recovery. A helper's nested verbs also count: a loop of 35 find/setText/expect sequences exceeds 100 actions. Split it into smaller calls.",
    "Keep a top-level checkpoint after each confirmed stage. After an uncertain save/submit, inspect or expect its result before resuming; replaying the whole batch can submit twice. A dispatched checkpoint is not proof of success. Reset or runtime restart loses checkpoints, so recover from surface facts then.",
    "Returned values are capped at 12000 characters and a cut JSON value is not parseable. Read a large result once into a top-level variable, return a small slice per call, and check the final count/identity; do not re-read or replay the task to retrieve the next slice.",
    ],
  };
}

/** The whole reference — what a session's FIRST platform is told, and what computer.help() answers. */
export function apiReference(driver: ComputerUseDriver): string {
  const p = parts(driver);
  return [...p.head, ...p.reads, ...p.actions, ...p.extras, ...p.tail].join("\n");
}

/** Only what THIS platform adds — for a session that already has the rest. */
export function platformReference(driver: ComputerUseDriver): string {
  const p = parts(driver);
  return [
    `Reaching a second platform: ${driver.platform} — everything else in the reference above still holds, `
      + "and these are the reads and verbs that are its own.",
    "",
    ...p.reads,
    ...p.extras,
  ].join("\n");
}
