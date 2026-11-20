/**
 * An Electron app's JS dialogs — `node scripts/test.mjs electron-dialogs`. Hermetic: a stub
 * dialog and a stub helper, no app and no desktop.
 *
 *   · every dialog is answered and said: the default (alert accepted, confirm dismissed) or the
 *     answer `dialog` armed;
 *   · an armed answer covers the NEXT action's dialog only: dropped, and said, when another action
 *     starts or the call ends, and not used by a dialog that comes before its action starts;
 *   · on Windows the app's own box is closed by its button for the answer given, and the note says
 *     how that went: closed, still there, or (no helper able to) that it may still be there.
 */

import { ElectronDialogs } from "../src/platform/electron/js-dialogs.ts";
import { UiaRequestError, type UiaTransport } from "../src/platform/windows/uia-client.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** What a page's dialog got, and the stand-in Playwright hands the listener. */
function dialog(type: string, message: string) {
  const got: { answer?: "accept" | "dismiss"; text?: string } = {};
  const d = {
    type: () => type,
    message: () => message,
    accept: async (text?: string) => { got.answer = "accept"; got.text = text; },
    dismiss: async () => { got.answer = "dismiss"; },
  };
  return { d: d as never, got };
}

type Reply = Record<string, unknown> | UiaRequestError;
/** A helper that answers `jsdialog` with `reply`, and the requests it was sent. */
function helper(reply: () => Reply) {
  const sent: Record<string, unknown>[] = [];
  let started = 0;
  const transport: UiaTransport = {
    async request(op, params = {}) {
      sent.push({ op, ...params });
      const r = reply();
      if (r instanceof UiaRequestError) throw r;
      return r;
    },
    async close() {},
  };
  return { sent, starts: () => started, make: () => { started++; return transport; } };
}

function setup(opts: { reply?: () => Reply; platform?: NodeJS.Platform; local?: boolean; pid?: number | null } = {}) {
  const h = helper(opts.reply ?? (() => ({ found: true, closed: true, ownerEnabled: true })));
  const dialogs = new ElectronDialogs({
    appPid: async () => (opts.pid === undefined ? 4242 : opts.pid),
    local: () => opts.local ?? true,
    helper: h.make,
    platform: opts.platform ?? "win32",
  });
  /** One action that raises `raise` (or nothing), as the driver runs it. */
  const act = async (kind: string, raise?: { d: never }) => {
    dialogs.actionStarts(kind);
    if (raise) dialogs.onDialog(raise.d);
    await dialogs.settled();
    return dialogs.takeNote() ?? "";
  };
  return { dialogs, h, act };
}

async function main() {
  // ── Answering ───────────────────────────────────────────────────────────────────────────
  {
    const { h, act } = setup();
    const c = dialog("confirm", "Delete record #42?");
    const note = await act("click", c);
    check("a confirm nobody armed for is dismissed", c.got.answer === "dismiss");
    check("…and the result says so, quoting it", /a JS dialog appeared: «Delete record #42\?» — it was auto-dismissed/.test(note), note);
    check("…its box is closed with Cancel, by the app's pid and the message",
      h.sent.length === 1 && h.sent[0]!.op === "jsdialog" && h.sent[0]!.pid === 4242 && h.sent[0]!.message === "Delete record #42?" && h.sent[0]!.button === "cancel",
      JSON.stringify(h.sent[0]));
    check("…and the result says the box went too", /the app's own box for it was closed too/.test(note), note);
    const a = dialog("alert", "Saved");
    const alertNote = await act("click", a);
    check("an alert is accepted and its box closed with OK", a.got.answer === "accept" && h.sent[1]?.button === "ok" && /auto-accepted/.test(alertNote));
    check("one helper serves every dialog of the connection", h.starts() === 1, String(h.starts()));
  }
  {
    const { dialogs, h, act } = setup();
    const receipt = dialogs.arm({ accept: true });
    check("arming says what WILL happen, and for how long", /raised by your NEXT action will be accepted/.test(receipt) && /dropped/.test(receipt), receipt);
    const c = dialog("confirm", "Delete record #42?");
    const note = await act("click", c);
    check("the armed answer is used by the next action's dialog", c.got.answer === "accept" && /accepted as you asked/.test(note), note);
    check("…and the box is closed with OK, matching it", h.sent[0]?.button === "ok");
    const again = dialog("confirm", "Delete record #43?");
    await act("click", again);
    check("one dialog, one answer: the next one gets the default", again.got.answer === "dismiss");
  }
  {
    const { dialogs, h, act } = setup();
    dialogs.arm({ accept: false });
    const a = dialog("alert", "Saved");
    await act("click", a);
    check("an alert dismissed as asked still closes its box with OK, its only button", a.got.answer === "dismiss" && h.sent[0]?.button === "ok");
  }

  // ── An armed answer lives for one action (M1) ──────────────────────────────────────────
  {
    const { dialogs, act } = setup();
    dialogs.arm({ accept: true });
    const first = await act("click");
    check("an action that raised no dialog says nothing yet", first === "", first);
    const c = dialog("confirm", "Delete record #42?");
    const note = await act("click", c);
    check("the next action's dialog does not get it", c.got.answer === "dismiss");
    check("…and its result says the answer was dropped, and why", /the dialog answer you armed \(accept\) was not used and was dropped before this click/.test(note), note);
  }
  {
    const { dialogs, act } = setup();
    dialogs.arm({ accept: true });
    dialogs.callEnds();
    const c = dialog("confirm", "Delete record #42?");
    const note = await act("click", c);
    check("an answer never carries into the next call", c.got.answer === "dismiss");
    check("…and the next result says it was dropped when its call ended", /dropped when the call that armed it ended/.test(note), note);
  }
  {
    const { dialogs, act } = setup();
    dialogs.arm({ accept: true });
    const early = dialog("confirm", "Leave this page?");
    dialogs.onDialog(early.d); // a timer's dialog, before the action it was armed for
    await dialogs.settled();
    dialogs.takeNote();
    check("a dialog before the armed action starts gets the default", early.got.answer === "dismiss");
    const c = dialog("confirm", "Delete record #42?");
    await act("click", c);
    check("…and the armed answer is still there for its action", c.got.answer === "accept");
  }
  {
    const { dialogs, act } = setup();
    dialogs.arm({ accept: true });
    dialogs.actionStarts("click");
    const late = dialog("confirm", "Delete record #42?");
    dialogs.onDialog(late.d); // after the action returned, before another one started
    await dialogs.settled();
    check("a dialog the action raises after it returned still gets its answer", late.got.answer === "accept");
    const note = await act("click");
    check("…and nothing is dropped after", !/dropped/.test(note), note);
  }

  // ── The box ─────────────────────────────────────────────────────────────────────────────
  {
    const { act } = setup({ reply: () => ({ found: true, closed: false }) });
    const note = await act("click", dialog("confirm", "x?"));
    check("a box that would not close is reported, with what to do", /still on screen/.test(note) && /tell the user/.test(note), note);
  }
  {
    const { act } = setup({ reply: () => ({ found: false, closed: false }) });
    const note = await act("click", dialog("confirm", "x?"));
    check("no box coming up adds nothing", /auto-dismissed; if the flow needs a confirm, it did not happen$/.test(note), note);
  }
  {
    const { h, act } = setup({ reply: () => new UiaRequestError("unknown_op", "unknown op 'jsdialog'") });
    const first = await act("click", dialog("confirm", "x?"));
    const second = await act("click", dialog("confirm", "y?"));
    check("a helper without the op: the box may still be there", /may still show its own box/.test(first), first);
    check("…and it is not asked again", h.sent.length === 1 && /may still show/.test(second), String(h.sent.length));
  }
  for (const [label, o] of [
    ["not on Windows", { platform: "darwin" as const }],
    ["a debugging port on another machine", { local: false }],
    ["an app that will not say its pid", { pid: null }],
  ] as const) {
    const { h, act } = setup(o);
    const note = await act("click", dialog("confirm", "x?"));
    check(`${label}: no helper, and the note says the box may remain`, h.starts() === 0 && /may still show its own box/.test(note), note);
  }
  {
    const { h, act } = setup();
    const note = await act("click", dialog("beforeunload", ""));
    check("beforeunload is accepted silently, with no box to close", note === "" && h.sent.length === 0, note);
  }

  console.log(`\nelectron-dialogs: ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
