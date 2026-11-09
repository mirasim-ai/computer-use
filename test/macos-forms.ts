/**
 * Forms on macOS, hermetically — `node scripts/test.mjs macos-forms`.
 *
 * Pinned against the stubbed helper: a click on a text field focuses it; set_text on a field
 * that commits on Enter says so; a bare caret is allowed; a nameless toggle takes the label beside
 * it; `type` sends keystrokes; a chord bound to a disabled item on a FRONTMOST app is posted
 * anyway; a menu listing is a read.
 */

import { createHarness } from "./harness.ts";
import { TYPE_AFTER_KEY_MS, typeVerb } from "../src/platform/macos/type-verb.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { findCall, ONE_APP, stubTransport } from "./macos-fixtures.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";

async function main() {
  const stub = stubTransport();
  const driver = new MacosDriver({ transport: stub.transport, ...ONE_APP });
  const h = createHarness(driver);
  stub.formRow = true;
  const listing = firstText(await h.observe({}));

  // ── A nameless control is named by the label on its row ────────────────────────────────
  const named = listing.split("\n").find((l) => /checkbox "启动时播放声音"/.test(l));
  check("a nameless checkbox takes the label to its left on its row as its name", !!named && /checked/.test(named), named);
  const nameless = listing.split("\n").filter((l) => /^e\d+: checkbox \[/.test(l));
  check("a nameless checkbox on a row with no label stays nameless — the label above is not its", nameless.length === 1, nameless.join(" | "));
  const search = listing.split("\n").find((l) => /^e\d+: textbox \[empty,\+confirm/.test(l));
  const searchRef = search?.match(/(e\d+)/)?.[1] ?? "";
  const labelledRef = named?.match(/(e\d+)/)?.[1] ?? "";

  // ── A click on a text field focuses it; AXConfirm is not a click ──────────────────────
  stub.calls.length = 0;
  const clicked = firstText(await h.act("click", { ref: searchRef }));
  check("a click on a field with no AXPress focuses it and runs no AXConfirm",
    !!findCall(stub.calls, "focus") && !findCall(stub.calls, "press") && /focused it/.test(clicked), clicked.split("\n")[0]);
  check("…and posts no mouse event for it", !findCall(stub.calls, "mouse"));

  // ── set_text on a field that commits on Enter says so ─────────────────────────────────
  stub.calls.length = 0;
  const set = await h.act("set_text", { ref: searchRef, text: "鼠标" });
  check("set_text on a field offering AXConfirm sets the value and says Enter commits it",
    set.ok && !!findCall(stub.calls, "setvalue") && /commits on Enter/.test(set.note ?? "") && /type\(\{text\}\)/.test(set.note ?? ""), set.note);
  check("…and takes the keyboard focus for the field it just filled, so keys('Enter') lands there",
    !!findCall(stub.calls, "focus") && /holds the keyboard focus/.test(set.note ?? ""), set.note);
  const plain = await h.act("set_text", { ref: "e5", text: "12+30" });
  check("set_text on a field without AXConfirm is verified as before", plain.ok && !/commits on Enter/.test(plain.note ?? ""), plain.note);

  // ── A field that will NOT take focus says where the keys would go instead ─────────────
  // Otherwise the write lands and Enter goes to a button elsewhere in the window
  // (act-element.ts setValue).
  stub.focusRefused = true;
  const unfocused = await h.act("set_text", { ref: searchRef, text: "鼠标" });
  check("set_text whose field refuses focus still succeeds and warns that keys go elsewhere",
    unfocused.ok && /would NOT take the keyboard focus/.test(unfocused.note ?? "") && /select_text with a caret/.test(unfocused.note ?? ""), unfocused.note);
  stub.focusRefused = false;

  // ── A field that refuses AXSetValue answers with the `type` route, it does not throw ──
  // A throw escaping setValue would end the whole computer_repl run: the caller loses
  // every step after it AND its return value, for the ordinary SwiftUI field.
  stub.setValueRefused = true;
  const refused = await h.act("set_text", { ref: searchRef, text: "鼠标" });
  check("set_text on a field that refuses AXSetValue fails as a result, naming the ref and the type route",
    !refused.ok && refused.note.includes(searchRef) && /AXSetValue/.test(refused.note)
      && /type\(\{text\}\)/.test(refused.note), refused.note);
  stub.setValueRefused = false;

  // ── A write the app accepts and discards is NOT verified ─────────────────────────────
  // QuickTime's timeline slider answers success and keeps its value. `verified` is a read-back
  // verdict the tool layer gates a submit on, so it is never asserted without reading back.
  stub.writeDiscarded = true;
  const discarded = await h.act("set_text", { ref: "e5", text: "12+30" });
  check("set_text the app accepts and discards reports verified:false, not success",
    discarded.ok && /WARNING/.test(discarded.note ?? "") && /not what you sent/.test(discarded.note ?? "")
      && /type\(\{text\}\)/.test(discarded.note ?? ""), discarded.note);
  stub.writeDiscarded = true;
  check("…and explicit setTextBestEffort() answers false for it",
    (await h.api.setTextBestEffort("e5", "12+30")) === false);
  stub.writeDiscarded = false;
  const kept = await h.act("set_text", { ref: "e5", text: "12+30" });
  check("…while a write the app keeps still reads back clean", kept.ok && !/WARNING/.test(kept.note ?? ""), kept.note);
  check("…and answers true", (await h.api.setText("e5", "12+30")) === true);

  // ── A caret value the schema does not have is REFUSED, not reinterpreted ──────────────
  // Unrefused, `caret:'end'` falls through to the caret branch and places it at the START.
  const badCaret = await h.act("select_text", { ref: searchRef, caret: "end" });
  check("select_text with a caret value outside the schema is refused and lists the three it takes",
    !badCaret.ok && /invalid arguments for selectText/.test(badCaret.note) && /select, before, after/.test(badCaret.note), badCaret.note);

  // ── A bare caret places the caret at the start or end, empty field included ───────────
  stub.calls.length = 0;
  const caret = firstText(await h.act("select_text", { ref: searchRef, caret: "after" }));
  const range = findCall(stub.calls, "selectrange");
  check("select_text with caret alone places it at the end of an empty field", range?.params.start === 0 && range?.params.length === 0 && /caret placed at the end/.test(caret), caret.split("\n")[0]);
  const noCaret = firstText(await h.act("select_text", { ref: searchRef }));
  check("select_text with neither text nor caret is refused and names the caret option", /caret:'before'/.test(noCaret), noCaret.split("\n")[0]);

  // ── type: keystrokes at the app's focus ───────────────────────────────────────────────
  stub.calls.length = 0;
  const typed = firstText(await h.act("type", { text: "鼠标" }));
  const typeCall = findCall(stub.calls, "backgroundtype");
  check("type posts the text through guarded background delivery", typeCall?.params.pid === 49403 && typeCall?.params.text === "鼠标" && /posted 2 characters/.test(typed), typed.split("\n")[0]);
  const empty = firstText(await h.act("type", { text: "" }));
  check("type without text is refused", /type needs text/.test(empty), empty.split("\n")[0]);

  // A key posted just before a type is still moving the focus: Excel's name box commits on Enter
  // and swallows the first character posted into that gap (type-verb.ts TYPE_AFTER_KEY_MS). Called
  // directly: the harness's own observation cycle already outlasts the gap.
  {
    const posted: Array<{ op: string }> = [];
    const call = (async (op: string) => { posted.push({ op }); return {} as never; }) as never;
    const t0 = Date.now();
    const waitedRes = await typeVerb(call, 1, "Excel", "ZZ", Date.now());
    const waitedMs = Date.now() - t0;
    check("a type right after a key waits for the focus to land before posting anything",
      waitedMs >= TYPE_AFTER_KEY_MS - 20 && posted[0]?.op === "type"
        && posted.filter((c) => c.op === "type").length === 1
        && /finish moving the focus/.test(waitedRes.note ?? ""),
      `${waitedMs} ms · ${(waitedRes.note ?? "").slice(-60)}`);
    // Missing pre-input evidence cannot be reconstructed from the focus after typing.
    check("a type that cannot read its field back says so instead of reporting only a count",
      waitedRes.verified === undefined && /unverified — the target field, original text or selection could not be read before input/.test(waitedRes.note ?? ""),
      (waitedRes.note ?? "").slice(-90));
    {
      const receipt = { typedKey: "k1", typedValue: "已有内容", typedRange: { start: 4, length: 0 } };
      const same = (async (op: string) => (op === "type"
        ? receipt : op === "textvalue" ? { value: "已有内容ZZ" } : {})) as never;
      const ok = await typeVerb(same, 1, "Excel", "ZZ");
      check("a field that reads back exactly the expected edit is reported as matched",
        ok.verified === true && /matched — the same field reads back exactly/.test(ok.note ?? ""), (ok.note ?? "").slice(-70));
      // ChatGPT's empty composer reads its placeholder as its value (caret at 0): the typed text
      // alone afterwards is the edit asked for, not "content differs" (which stops the run).
      const placeholder = { typedKey: "k2", typedValue: "Work with Codex\n", typedRange: { start: 0, length: 0 } };
      const fromEmpty = (async (op: string) => (op === "type"
        ? placeholder : op === "textvalue" ? { value: "ZZ" } : {})) as never;
      const empty = await typeVerb(fromEmpty, 1, "ChatGPT", "ZZ");
      check("a field whose empty value read as its placeholder, then reads back the typed text alone, is matched",
        empty.verified === true && /placeholder/.test(empty.note ?? ""), (empty.note ?? "").slice(-90));
      const kept = (async (op: string) => (op === "type"
        ? placeholder : op === "textvalue" ? { value: "ZZWork with Codex\n" } : {})) as never;
      const both = await typeVerb(kept, 1, "ChatGPT", "ZZ");
      check("…but text read before input that is still there is not taken for a placeholder",
        both.verified === true && !/placeholder/.test(both.note ?? ""), (both.note ?? "").slice(-60));
      const other = (async (op: string) => (op === "type"
        ? receipt : op === "textvalue" ? { value: "something else" } : {})) as never;
      const bad = await typeVerb(other, 1, "Excel", "ZZ");
      // Not a failure: a field may reformat what it takes. It must still not read as confirmed.
      check("a field whose value differs from the expected edit reports that fact, and still succeeds",
        bad.ok === true && bad.verified === false && /content differs — the same field/.test(bad.note ?? ""), (bad.note ?? "").slice(-80));
    }
    const t1 = Date.now();
    const plain = await typeVerb(call, 1, "Excel", "ZZ", Date.now() - TYPE_AFTER_KEY_MS * 2);
    check("a type with no key just before it pays nothing and says nothing about waiting",
      Date.now() - t1 < 50 && !/finish moving the focus/.test(plain.note ?? ""), `${Date.now() - t1} ms`);
  }

  // ── Polling with wait() is not "the same action twice" ───────────────────────────────
  // `wait` acts on nothing, and its whole job is to be called while the screen has not moved
  // yet, so it must not earn "You already tried this exact action".
  await h.act("wait", { ms: 1 });
  const polled = firstText(await h.act("wait", { ms: 1 }));
  check("two waits in a row do not earn the repeat-action escalation", !/already tried this exact action/.test(polled),
    polled.split("\n").find((l) => /NOTE/.test(l)) ?? "(no note)");
  check("…and a frozen screen after a wait is not called a dead action either",
    /not a dead action/.test(polled) && !/likely had no effect/.test(polled),
    polled.split("\n").find((l) => /NOTE/.test(l)) ?? "(no note)");
  // …while two identical ACTIONS still do: the escalation itself is not what is being removed.
  await h.act("keys", { chord: "Escape" });
  const again = firstText(await h.act("keys", { chord: "Escape" }));
  check("two identical keys on a frozen screen still do", /already tried this exact action/.test(again),
    again.split("\n").find((l) => /NOTE/.test(l)) ?? "(no note)");

  // ── A menu listing is a read: listing twice is not "the same action" ──────────────────
  await h.act("menu", {});
  const twice = firstText(await h.act("menu", {}));
  check("listing the menu twice does not earn the repeat-action note", !/already tried/.test(twice) && !/did NOT change/.test(twice), twice.split("\n").slice(0, 2).join(" · "));

  // ── The listing prints the REAL chord, modifiers and all ─────────────────────────────
  // QuickTime's New Movie / New Audio / New Screen Recording are ⌥⌘N / ⇧⌘N / ⌃⌘N; printing all three as (⌘N)
  // would have a model press a chord that matches no item.
  stub.frontmost = true;
  const menuLines = String(await (h.api as any).menu({})).split("\n");
  const saveAs = menuLines.find((l) => l.includes("存储为…")) ?? "";
  const save = menuLines.find((l) => /保存…/.test(l)) ?? "";
  check("a shortcut with a modifier prints it — ⇧⌘S, not ⌘S", /\(⇧⌘S\)/.test(saveAs), saveAs);
  check("…and a bare ⌘ shortcut is unchanged", /\(⌘S\)/.test(save) && !/⇧/.test(save), save);
  // The two forms have to meet: what the listing prints is what comes back in keys().
  stub.calls.length = 0;
  await h.act("keys", { chord: "⇧⌘S" });
  check("a chord copied out of that listing runs the same item", !!findCall(stub.calls, "press"), JSON.stringify(stub.calls.map((c) => c.op)));

  // ── The held count must agree with the posture in the same sentence ───────────────────
  stub.panelUp = true;
  const front = String(await (h.api as any).menu({}));
  check("with the app frontmost, the held items are named as the app's own gate, not as activation",
    /already frontmost/.test(front) && !/run after activate/.test(front), front.split("\n").filter((l) => /more/.test(l)).join(" "));
  stub.frontmost = false;
  const back = String(await (h.api as any).menu({}));
  check("…and in the background activation is still the way out",
    /need the app's window to be key/.test(back), back.split("\n").filter((l) => /more/.test(l)).join(" "));
  stub.panelUp = false;

  // ── A chord bound to an item disabled WITH the app frontmost is posted anyway ──────────
  await h.act("activate", {});
  stub.frontmost = true; // the stub's activate does not flip it; the real app comes forward
  stub.panelUp = true;
  stub.calls.length = 0;
  const chord = firstText(await h.act("keys", { chord: "cmd+shift+s" }));
  const key = findCall(stub.calls, "key");
  check("a chord whose menu item stays disabled with the app frontmost is posted to the app, and the note says frontmost, not background",
    key?.params.chord === "cmd+shift+s" && /disabled even with 计算器 frontmost/.test(chord) && !/in the background/.test(chord), chord.split("\n")[0]);
  stub.panelUp = false;
  stub.frontmost = false;
  const behind = firstText(await h.act("keys", { chord: "cmd+shift+s" }));
  check("without a panel, the background chord uses guarded delivery", /in the background/.test(behind) && !!findCall(stub.calls, "backgroundkey"), behind.split("\n")[0]);

  // ── find: the control beats the label that named it ──────────────────────────────────
  const found = await h.api.find("启动时播放声音");
  check("find() on a label's text hands back the checkbox it names, not the text element", found?.ref === labelledRef, JSON.stringify(found));

  // ── Keys go to the process that holds the focus: a remote Save panel's, not the app's ─
  stub.focusOn = "k12";
  stub.remotePanel = true;
  stub.calls.length = 0;
  await h.act("keys", { chord: "Escape" });
  check("a plain key is posted to the focused element's owning process when that is not the app", findCall(stub.calls, "key")?.params.pid === 9999, JSON.stringify(findCall(stub.calls, "key")?.params));
  stub.calls.length = 0;
  await h.act("type", { text: "/tmp" });
  check("type likewise", findCall(stub.calls, "type")?.params.pid === 9999, JSON.stringify(findCall(stub.calls, "type")?.params));
  stub.frontmost = true;
  stub.panelUp = true;
  stub.calls.length = 0;
  const routed = firstText(await h.act("keys", { chord: "cmd+shift+s" }));
  check("with a panel holding the focus, a ⌘-chord goes straight to the panel's process, not through the app's menu",
    findCall(stub.calls, "key")?.params.pid === 9999 && !findCall(stub.calls, "press") && /posted to the Open\/Save panel/.test(routed), routed.split("\n")[0]);
  stub.panelUp = false;
  stub.frontmost = false;
  stub.calls.length = 0;
  const panelBehind = firstText(await h.act("keys", { chord: "cmd+shift+g" }));
  check("…and with the app in the background it is refused with the real reason, nothing posted",
    !findCall(stub.calls, "key") && /only with the app frontmost/.test(panelBehind), panelBehind.split("\n")[0]);
  stub.remotePanel = false;
  stub.focusOn = "none";
  stub.calls.length = 0;
  await h.act("keys", { chord: "Escape" });
  check("with the background app itself holding focus the key uses guarded delivery", findCall(stub.calls, "backgroundkey")?.params.pid === 49403);

  // ── The labelled checkbox is clickable by its inferred name ───────────────────────────
  stub.calls.length = 0;
  const toggled = await h.act("click", { ref: labelledRef, name: "启动时播放声音" });
  check("the inferred name passes the click's identity check", toggled.ok && !!findCall(stub.calls, "press"), toggled.note);

  await driver.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall macos forms checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
