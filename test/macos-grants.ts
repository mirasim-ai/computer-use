/** Hermetic macOS GRANT coverage — no helper process, no app. Every cell is about a MISSING OS
 * permission, seen from both the read and the act channels, and stands up its own canned
 * transport. What the driver does with a tree it CAN read is in macos-ui.ts.
 *
 * The rule these pin: computer-use only says what is missing and where to go — deciding and prompting are
 * the host's. An ungranted act must not misdiagnose itself as a stale ref, and a helper
 * too old to answer `capabilities` must cost the note, never the listing.
 */

import { createHarness } from "./harness.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import type { ToolResult } from "../src/platform/types.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";
/** A read a missing grant refuses is the ANSWER, which is how `computer_repl` renders it; the harness
 *  lets the error propagate, so the suite folds it back into text. */
const orReason = (p: Promise<ToolResult>): Promise<ToolResult> =>
  p.catch((e: Error & { surfaceUnreadable?: boolean }) => {
    if (!e.surfaceUnreadable) throw e;
    return { content: [{ type: "text", text: e.message }], details: { error: "surface_unreadable" } };
  });

async function main() {
  // ── A missing grant: computer-use only says what is missing and where to go; deciding is the host's ──
  {
    const perm = stubTransport();
    const permH = createHarness(new MacosDriver({ transport: perm.transport, ...ONE_APP }));

    perm.trusted = false;
    const denied = firstText(await orReason(permH.observe({})));
    check("a missing Accessibility grant denies the 'no controls' reading before giving the way out",
      /NOT an app without controls/.test(denied) && /Privacy & Security → Accessibility/.test(denied) && /its own permissions page/.test(denied),
      denied.split("\n")[0]);
    check("...and offers pixels as the way through, because that grant is still there",
      /screenshot\(\) may still answer/.test(denied), denied.slice(-90));

    // The state the grant leaves behind: every read failed, so no ref was ever handed out.
    // "Re-observe and use a current ref" is a dead end there — the read is what is broken —
    // and blaming a navigation buries the one message that says how to fix it.
    const noRefs = firstText(await permH.act("click", { ref: "e1" }));
    check("a ref sent before any successful read says THAT, not that it went stale",
      /has not been read yet, so it has never handed out a ref/.test(noRefs)
      && !/Re-observe/.test(noRefs), noRefs.split(".")[0]);
    check("...and repeats the reason the read failed instead of inventing one",
      /Privacy & Security → Accessibility/.test(noRefs), noRefs.slice(0, 140));

    // Both gone (a brand-new install): pixels are no longer a way around, and saying they are
    // spends the model's next step on a second wall.
    perm.screenGranted = false;
    await permH.targets(); // establishes what the helper says about BOTH grants
    const bothGone = firstText(await orReason(permH.observe({})));
    check("with both grants gone the answer stops offering a screenshot as the way through",
      /Screen Recording is missing as well/.test(bothGone) && !/may still answer/.test(bothGone), bothGone.slice(-90));
    perm.screenGranted = true;

    // The one path that SUCCEEDS without a grant, which is why it is the one that has to say so.
    // Apps still list (NSWorkspace); their windows do not (axWindows is AX-gated), so every row
    // degrades to "no windows" — the note exists to stop that reading as an empty desktop.
    const listed = firstText(await permH.targets());
    check("the targets listing shows apps without the grant, and explains why every one shows no windows",
      /49403 \[app\]/.test(listed) && !/\[window\]/.test(listed)
      && /every one of them lists as "no windows"/.test(listed) && /its own permissions page/.test(listed),
      listed.split("\n").slice(0, 2).join(" | "));

    // Pixels are their own grant: the tree is unaffected and the refusal has to point back at it.
    perm.trusted = true;
    perm.screenGranted = false;
    const noPixels = firstText(await orReason(permH.observe({ what: "screenshot" })));
    check("a missing Screen Recording grant points back at the tree instead of reading as a broken app",
      /Screen Recording is not granted/.test(noPixels) && /observe\(\)/.test(noPixels) && /control tree is unaffected/.test(noPixels),
      noPixels.split("\n")[0]);

    // A grant seen GRANTED is cached; a missing one is re-asked, because that is the state the
    // user may be fixing right now.
    perm.calls.length = 0;
    await permH.targets();
    await permH.targets();
    check("a missing grant is re-probed on every listing while a granted one is not",
      perm.calls.filter((c) => c.op === "capabilities").length === 2, JSON.stringify(perm.calls.map((c) => c.op)));
  }

  // ── The same grant, seen from the READ and the ACT channels ──
  //
  // The act refusals have their own wording: unguarded, an ungranted act answers with the WRONG
  // DIAGNOSIS (a stale ref, an app that ignored the press) or, for the three CGEvent posts, with
  // SUCCESS — the post is discarded silently.
  {
    const act = stubTransport();
    const actH = createHarness(new MacosDriver({ transport: act.transport, ...ONE_APP }));

    // One granted observation first: the refs below are real, so what the act refusals answer is
    // about the GRANT and not about a ref the model invented (that case is `staleRefNote`'s, which
    // repeats this same refusal as the read failure it remembers).
    await actH.observe({});
    act.trusted = false;

    const read = firstText(await orReason(actH.observe({ what: "text" })));
    check("readText refuses through the same named tree refusal as the element list",
      /Accessibility is not granted, so the control tree cannot be read/.test(read) && /its own permissions page/.test(read),
      read.split("\n")[0]);

    const actWording = (t: string) =>
      /nothing can be pressed, typed or scrolled/.test(t) && /did NOT fail because the app ignored it or because the ref was stale/.test(t)
      && /Privacy & Security → Accessibility/.test(t) && !/screenshot\(\) may still answer/.test(t);
    // The negative half matters as much: those phrasings ARE the misdiagnoses to rule out.
    const misdiagnosis = /is not in the latest observation|not among the refs currently in play|does not support that|refused AXPress/;

    // A ref that IS in the observation, pressed after the grant went: the helper answers
    // `not_trusted` (element(forKey:) guards before the key table), never `stale_key`.
    // The verb's own refusal is `note`; the text under it is the observation the harness reads
    // anyway, which fails with the READ wording and would blur what the ACT said.
    const pressed = await actH.act("click", { ref: "e1" });
    check("a press without the grant says the grant, not that the ref went stale or the app refused",
      !pressed.ok && actWording(pressed.note) && !misdiagnosis.test(pressed.note), pressed.note.split("\n")[0]);

    const typed = await actH.act("set_text", { ref: "e1", text: "5" });
    check("...and so does a write through accessibility", !typed.ok && actWording(typed.note), typed.note.split("\n")[0]);

    // The three CGEvent posts. `requirePostEvents` (CGPreflightPostEventAccess) is what turns each
    // of these from a silent no-op reported as success into a refusal.
    for (const [what, kind, args] of [
      ["keys", "keys", { chord: "5" }],
      ["a type into the focused control", "set_text", { text: "5" }],
      ["a point click, which hit-tests first", "click", { x: 20, y: 20 }],
    ] as const) {
      const r = await actH.act(kind, { ...args });
      check(`${what} refuses instead of reporting an action that never happened`,
        !r.ok && actWording(r.note), r.note.split("\n")[0]);
    }

    // launch_app is the one verb that WORKS ungranted (`open -b`). Its readiness probe is an AX
    // call, so "wait 2 s and observe" would wait for something that never arrives.
    const fresh = stubTransport();
    fresh.trusted = false;
    fresh.launchReady = false;
    const freshH = createHarness(new MacosDriver({ transport: fresh.transport, ...ONE_APP }));
    const launched = firstText(await freshH.act("launch_app", { bundle: "com.apple.Notes" }));
    check("launch_app still launches without the grant, and says nothing can be read instead of 'wait 2 s'",
      /is running \(pid 888\)/.test(launched) && /Accessibility is not granted/.test(launched) && !/wait \{seconds:2\}/.test(launched),
      launched.split("\n").find((l) => /NOTE/.test(l)) ?? launched.split("\n")[0]);
  }

  // A helper too old to know the op must cost the note, never the listing (COMPUTER_USE_MACOS_AX_BIN).
  {
    const old = stubTransport();
    old.oldHelper = true;
    const oldH = createHarness(new MacosDriver({ transport: old.transport, ...ONE_APP }));
    const listed = firstText(await oldH.targets());
    check("a helper that does not know `capabilities` still lists targets, silently",
      /49403:62106/.test(listed) && !/not granted/.test(listed), listed.split("\n")[0]);
  }

  console.log(`\nmacos-grants: ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
