/**
 * The macOS AX tree → element list mapping, on its own: pure functions, no helper, no stub.
 *
 * The seam with `macos-ui.ts`: "the pure mapping" vs "the driver over a stubbed helper".
 *
 * What it pins is the vocabulary the model reads: window-local rects, refs as SIGNATURES rather
 * than positions, one element per LINE with any cut marked, and a readout that keeps its ref
 * while its value churns.
 */

import { mapTree, textOf } from "../src/platform/macos/elements.ts";
import { el, HELP_AND_ID, TREE } from "./macos-stub-app.ts";
import { ambiguityNote, rankByName } from "../src/platform/tools/find-target.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const mapped = mapTree(TREE);
check("static text with content is listed as text and read into the text channel",
  mapped.elements[0]?.role === "text" && mapped.text.startsWith("56,088"));
check("rects are window-local points", mapped.rects.get("e2")?.x === 64 && mapped.rects.get("e2")?.y === 133, JSON.stringify(mapped.rects.get("e2")));
check("a button's name comes from its description", mapped.elements[1]?.name === "全部清除");
check("an AXSegment checkbox reads its 0/1 value as checked", /checked/.test(mapped.elements[5]?.state ?? "") && !/unchecked/.test(mapped.elements[5]?.state ?? ""));
check("a disabled control says so", mapped.elements[6]?.state === "disabled", mapped.elements[6]?.state);
check("refs map onto helper keys", mapped.keys.get("e3")?.key === "k6");
// An ordinary control carries no action mark: the `+…` whitelist (SECONDARY_ACTIONS) exists so
// that "this element offers more than a click" is legible, and it is only legible if it is rare.
check("an ordinary button carries no action mark — the whitelist is not noise",
  mapped.elements.every((e) => !e.state.includes("+")),
  mapped.elements.map((e) => e.state).filter(Boolean).join(" | "));
// One element = one LINE (the delta's line diff is built on it), and a cut says so, or a
// trimmed value reads as the whole value. The text channel keeps the real newlines: that is
// what the model READS.
{
  const wordy = mapTree({
    ...TREE,
    elements: [
      el({ key: "kT", role: "AXTextArea", x: 100, y: 100, w: 400, h: 200,
        value: "first line\n\nsecond line of a document that runs on well past the cap" }),
      el({ key: "kS", role: "AXStaticText", x: 100, y: 400, w: 300, h: 60, actions: [],
        value: "a label\nsplit across lines" }),
    ],
  });
  const st = wordy.elements[0]?.state ?? "";
  check("a value in the state field never breaks the line", !st.includes("\n"), JSON.stringify(st));
  check("...and its cut is marked", st.includes("…"), JSON.stringify(st));
  check("a name is collapsed too", wordy.elements[1]?.name === "a label split across lines",
    JSON.stringify(wordy.elements[1]?.name));
  check("the text channel keeps the real line breaks", wordy.text.includes("first line\n\nsecond line"),
    JSON.stringify(wordy.text.slice(0, 40)));
}
{
  // The driver's allocator, in miniature: reuse a signature's ref, mint for new signatures.
  const bySig = new Map<string, string>();
  let n = 0;
  const alloc = (sig: string) => bySig.get(sig) ?? (bySig.set(sig, `e${++n}`), bySig.get(sig)!);
  const first = mapTree(TREE, alloc);
  const withRow = mapTree({ ...TREE, elements: [el({ key: "kR", role: "AXStaticText", value: "12×34", x: 1721, y: -62, w: 86, h: 26, actions: [] }), ...TREE.elements] }, alloc);
  const seven = (m: typeof first) => m.elements.find((e) => e.name === "7")?.ref;
  check("refs are signatures, not positions: '7' keeps its ref when a row appears above it", seven(first) === "e3" && seven(withRow) === "e3" && withRow.elements[0]?.ref === "e8", `${seven(first)} → ${seven(withRow)}, new row ${withRow.elements[0]?.ref}`);
  // A readout is the same element showing something new, so its VALUE must not be in its key.
  // As a right-aligned display's value grows, `x` and `w` move while y and h hold, so the row —
  // not the horizontal geometry — identifies it; keyed on the value, every keystroke would
  // re-mint the ref and the delta report one element as removed and added.
  const ticked = mapTree({
    ...TREE,
    elements: [el({ key: "k0", role: "AXStaticText", value: "56,0889", x: 1704, y: -32, w: 118, h: 36, actions: [] }),
      ...TREE.elements.slice(1)],
  }, alloc);
  check("a readout keeps its ref when only its value (and the width it takes) changed",
    ticked.elements[0]?.ref === first.elements[0]?.ref,
    `${first.elements[0]?.ref} → ${ticked.elements[0]?.ref}`);
  check("...and the new value is what the line now reads",
    ticked.elements[0]?.name === "56,0889", ticked.elements[0]?.name);
}

// ── Action marks that every control shares are hoisted, not repeated ──────────
// A Chromium/Electron accessibility tree advertises AXShowMenu on nearly every node, a mark
// that cannot say which control to act on; native windows sit far lower. So the rule is a
// share of the CONTROLS (text never carries these marks), over a floor of 40 — below which an
// open context menu can be most of a small window, and the marks are the reason to act
// (`elements.ts` → MARK_MIN_CONTROLS carries the measurements).
{
  const many = (n: number, marked: number) => Array.from({ length: n }, (_, i) =>
    el({ key: `u${i}`, role: "AXButton", desc: `control ${i}`, y: i * 20,
      actions: i < marked ? ["AXPress", "AXShowMenu"] : ["AXPress"] }));
  const shared = mapTree({ ...TREE, elements: many(60, 57) });
  check("a mark on nearly every control is hoisted off the element lines",
    shared.elements.every((e) => !e.state.includes("+")) && shared.sharedMarks.join() === "menu",
    `sharedMarks=[${shared.sharedMarks}] states=${[...new Set(shared.elements.map((e) => e.state))].join("|") || "(empty)"}`);
  // The bar sits above the transient case on purpose: an open context menu's items ALL advertise
  // pick (~86% of the window), and that mark is the only place `ax_action pick` is discoverable.
  const mixed = mapTree({ ...TREE, elements: many(60, 51) });
  check("a mark on 85% of them is not — that is the open-menu case, where it is the reason to act",
    mixed.sharedMarks.length === 0 && mixed.elements.filter((e) => e.state.includes("+menu")).length === 51,
    `sharedMarks=[${mixed.sharedMarks}]`);
  // A tiny list can be unanimous by accident, and the header line would then cost more than the
  // marks it replaces.
  const few = mapTree({ ...TREE, elements: many(6, 6) });
  check("a short list keeps its marks even when every control shares them",
    few.sharedMarks.length === 0 && few.elements.every((e) => e.state.includes("+menu")));
  check("hoisting takes out only the shared mark, never the whole bracket",
    (() => {
      const els = many(60, 60);
      els[0] = el({ key: "u0", role: "AXIncrementor", desc: "Repeat", value: "3", actions: ["AXShowMenu", "AXIncrement"] });
      const m = mapTree({ ...TREE, elements: els });
      return m.sharedMarks.join() === "menu" && m.elements[0]?.state === "value:3,+increment";
    })());
}

// ── a text row that only repeats a control's name is not a row ───────────────
// Web content lists a button AND the text node inside it, so a sidebar item would spend an
// extra row repeating its name.
{
  const dupes = mapTree({
    ...TREE,
    elements: [
      el({ key: "b0", role: "AXButton", desc: "Pin chat", y: 10 }),
      el({ key: "t0", role: "AXStaticText", value: "Pin chat", y: 10, actions: [] }),
      el({ key: "t1", role: "AXStaticText", value: "a line of its own", y: 30, actions: [] }),
    ],
  });
  const names = dupes.elements.map((e) => `${e.role}:${e.name}`);
  check("the text that only repeats a button's name is dropped",
    names.filter((n) => /Pin chat/.test(n)).length === 1 && names.includes("button:Pin chat"), names.join(" | "));
  check("...and text of its own is kept", names.includes("text:a line of its own"), names.join(" | "));
  check("...while text() keeps every string — the read channel is the complete one",
    dupes.text.includes("Pin chat") && dupes.text.includes("a line of its own"),
    JSON.stringify(dupes.text).slice(0, 80));
  // The SwiftUI label must survive: there the control has NO name of its own and borrows the
  // text's, so dropping it would leave the control unaddressable (macos-forms.ts pins the pairing).
  const labelled = mapTree({
    ...TREE,
    elements: [
      el({ key: "t2", role: "AXStaticText", value: "播放用户界面声音效果", x: 100, y: 50, w: 200, h: 20, actions: [] }),
      el({ key: "c2", role: "AXCheckBox", value: "1", x: 400, y: 50, w: 20, h: 20 }),
    ],
  });
  check("a label a nameless control borrows is never dropped",
    labelled.elements.some((e) => e.role === "text" && e.name === "播放用户界面声音效果")
    && labelled.elements.some((e) => e.role === "checkbox" && e.name === "播放用户界面声音效果"),
    labelled.elements.map((e) => `${e.role}:${e.name}`).join(" | "));
}

// ── consecutive text fragments fold into one line ─────────────────────────────
// Web content hands out fragments, not paragraphs: streaming cuts a reply into per-phrase runs
// and syntax highlighting cuts every code token into its own node (thousands of ~5-character
// nodes for one answer). One line per fragment would crowd the controls out.
{
  const frag = (n: number, text: string) => el({ key: `t${n}`, role: "AXStaticText", value: text, x: 10 + n * 40, y: 10, w: 40, h: 16, actions: [] });
  const fragments = [
    frag(1, "先给"), frag(2, "结论："), frag(3, "混合"), frag(4, "寻址"), frag(5, "：AX"), frag(6, "加坐标"),
    el({ key: "b1", role: "AXButton", desc: "Copy", x: 10, y: 40 }),
    el({ key: "t9", role: "AXStaticText", value: "然后", x: 10, y: 70, w: 40, h: 16, actions: [] }),
  ];
  const m = mapTree({ ...TREE, elements: fragments });
  const kinds = m.elements.map((e) => `${e.role}:${e.name}${e.state ? `[${e.state}]` : ""}`);
  check("a long run of fragments becomes one line that says how many it stands for",
    m.elements.length === 3 && /^text:先给结论：混合寻址：AX加坐标\[6 text runs\]$/.test(kinds[0] ?? ""), kinds.join(" | "));
  check("a control BREAKS the run — the structure stays visible",
    kinds[1] === "button:Copy" && kinds[2] === "text:然后", kinds.join(" | "));
  check("a run of one is not marked — nothing was folded",
    !/text runs/.test(kinds[2] ?? ""), kinds[2] ?? "");
  // A native window's adjacent readouts come in twos, and folding them would cost one its ref.
  const pair = mapTree({ ...TREE, elements: [frag(1, "12×34"), frag(2, "56,088")] });
  check("a SHORT run is left alone — two adjacent readouts are not fragmentation",
    pair.elements.length === 2 && !pair.elements.some((e) => /text runs/.test(e.state)),
    pair.elements.map((e) => `${e.name}[${e.state}]`).join(" | "));
  check("the folded line keeps the FIRST fragment's key, so acting on it still resolves",
    m.keys.get(m.elements[0]!.ref)?.key === "t1", JSON.stringify(m.keys.get(m.elements[0]!.ref)));
  // The text CHANNEL must not fold: it is the one read that trims nothing.
  const full = textOf({ ...TREE, elements: fragments });
  check("text() still walks every fragment — folding there would trim a window's own text",
    ["先给", "结论：", "混合", "寻址", "：AX", "加坐标", "然后"].every((piece) => full.includes(piece)),
    JSON.stringify(full));
}

// ── The text channel carries what is OUTSIDE the window, in the app's own order ──────
// The walk splits on-screen from off-screen so the listing budgets stay priced over what the
// model is shown, which loses the document order. `seq` puts it back — otherwise a transcript's
// scrolled-out half sits after its visible half and "the latest" reads wrong.
{
  const above = el({ key: "a1", seq: 1, role: "AXStaticText", value: "ABOVE the viewport", off: true });
  const below = el({ key: "b1", seq: 99, role: "AXStaticText", value: "BELOW the viewport", off: true });
  const woven = textOf({ ...TREE, offscreenElements: [above, below] });
  check("text() carries a row the window does not show",
    woven.includes("ABOVE the viewport") && woven.includes("BELOW the viewport"), JSON.stringify(woven));
  check("…in the app's own order, not appended as a block",
    woven.indexOf("ABOVE") < woven.indexOf("56,088") && woven.indexOf("56,088") < woven.indexOf("BELOW"),
    JSON.stringify(woven));

  // A prebuilt helper too old to send `seq` must still read as a document, just not an
  // interleaved one: the off-screen rows follow.
  const noSeq = (e: typeof above) => ({ ...e, seq: undefined });
  const flat = textOf({
    ...TREE,
    elements: TREE.elements.map(noSeq),
    offscreenElements: [noSeq(above), noSeq(below)],
  });
  check("an older helper sends no order and the rows follow rather than interleave",
    flat.indexOf("56,088") < flat.indexOf("ABOVE") && flat.indexOf("ABOVE") < flat.indexOf("BELOW"),
    JSON.stringify(flat));

  check("a window with nothing outside it is untouched — the on-screen array is returned as it is",
    textOf(TREE) === textOf({ ...TREE, offscreenElements: [] }));
}

console.log(failures === 0 ? "\nmacos-elements: OK" : `\nmacos-elements: ${failures} FAILURE(S)`);
// ── The developer id and the tooltip: what is CARRIED, and what a line is allowed to show ──────
// Both are free off the same batched read (ax-tree.swift). The judgement is what they cost the
// model: an id often repeats the name (every Finder row), and so does many a tooltip.
{
  const m = mapTree({ ...TREE, elements: [...TREE.elements, ...HELP_AND_ID] });
  const search = m.elements.find((e) => e.name === "搜索");
  const close = m.elements.find((e) => e.name === "关闭窗口：其标签页保持打开");
  check("a help that opens with the control's own name keeps only what it adds",
    search?.help === "⌘K", JSON.stringify(search?.help));
  check("the id is carried on the element whether or not a line will show it — find is what it is for",
    search?.id === "SearchButton", search?.id);
  check("a help that repeats the name in other punctuation is dropped, not printed as news",
    !close?.help, JSON.stringify(close?.help));
  check("an id equal to the name is still CARRIED; dropping it is the renderer's call, not the mapping's",
    close?.id === "关闭窗口：其标签页保持打开", close?.id);
  // On a localised interface a name search can land on the wrong control (`find('Formula Bar')`
  // answers the Expand Formula Bar button); the id is the handle that cannot be confused.
  const byId = rankByName(m.elements, "SearchButton");
  check("find matches a developer id exactly, and answers the control that carries it",
    byId?.name === "搜索" && byId?.matches === 1, `${byId?.name} matches=${byId?.matches}`);
  // The PICK is still the button (shortest partial wins), so what matters is that the caller
  // can SEE what it picked, not a bare ref.
  const clash = rankByName(
    [{ ref: "e71", name: "展开编辑栏", role: "button", id: "ExpandButton", rect: { x: 0, y: 0, w: 1, h: 1 } },
     { ref: "e72", name: "编辑栏. A,1", role: "textbox", id: "XLFormulaEditor", rect: { x: 0, y: 0, w: 1, h: 1 } }],
    "编辑栏");
  const note = clash ? ambiguityNote(clash) : "";
  check("an ambiguous find names every candidate and its id, so the wrong pick is visible at once",
    /e71 ⟨id: ExpandButton⟩/.test(note) && /e72 "编辑栏\. A,1" ⟨id: XLFormulaEditor⟩/.test(note), note);
  check("…and points at the id as the way out, because it is exact and not translated",
    /name one of their ids/.test(note));
  const plain = rankByName(
    [{ ref: "e1", name: "删除文件", role: "button", rect: { x: 0, y: 0, w: 1, h: 1 } },
     { ref: "e2", name: "删除全部记录", role: "button", rect: { x: 0, y: 0, w: 1, h: 1 } }],
    "删除");
  const plainNote = plain ? ambiguityNote(plain) : "";
  check("where no candidate has an id, the note names them and does NOT advise a handle the surface never offered",
    /1 of 2/.test(plainNote) && /e2 "删除全部记录"/.test(plainNote) && !/name one of their ids/.test(plainNote), plainNote);

  const bySubstring = rankByName(m.elements, "earchButt");
  const substringName = bySubstring?.name ?? "(null)";
  check("…and never by substring: a fragment of a developer id is not something anyone meant to ask for",
    substringName !== "搜索", substringName);
}

// ── a readout carries its value, and a plain text does not repeat itself ──
// Calculator's display is AXDescription "edit field" with AXValue 77: the label is the name, so the
// number must reach the element line — `mouse.ts` judges a press by those lines, and a repeated
// digit would otherwise read as "nothing happened" and be redone by the mouse.
{
  // The driver's allocator again, so the two reads below share one ref table.
  const bySig = new Map<string, string>();
  let minted = 0;
  const alloc = (sig: string) => bySig.get(sig) ?? (bySig.set(sig, `e${++minted}`), bySig.get(sig)!);
  const readout = mapTree({
    ...TREE,
    elements: [
      el({ key: "d0", role: "AXStaticText", desc: "编辑字段", value: "77", x: 100, y: 10, w: 90, h: 36, actions: [] }),
      el({ key: "d1", role: "AXStaticText", value: "a line with no label of its own", x: 100, y: 60, w: 200, h: 20, actions: [] }),
    ],
  }, alloc);
  const [display, plain] = readout.elements;
  check("a labelled readout puts its value on the line", display?.name === "编辑字段" && display?.state === "value:77",
    `${display?.name} [${display?.state}]`);
  check("a text whose name IS its value does not print it twice",
    plain?.name === "a line with no label of its own" && plain?.state === "", `[${plain?.state}]`);

  // The judge compares role|name|state per element (mouse.ts `signature`), so two reads one
  // digit apart must differ.
  const sig = (t: typeof readout) => t.elements.map((e) => `${e.role}|${e.name}|${e.state}`).join("\n");
  const after = mapTree({
    ...TREE,
    elements: [
      el({ key: "d0", role: "AXStaticText", desc: "编辑字段", value: "777", x: 100, y: 10, w: 90, h: 36, actions: [] }),
      el({ key: "d1", role: "AXStaticText", value: "a line with no label of its own", x: 100, y: 60, w: 200, h: 20, actions: [] }),
    ],
  }, alloc);
  check("…so a press that changes only the readout is visible to the click judge", sig(readout) !== sig(after));
  // The ref keys on the ROW, never on the value, so the display does not re-mint itself.
  check("…and the readout keeps its ref while its value churns",
    readout.elements[0]?.ref === after.elements[0]?.ref, `${readout.elements[0]?.ref} → ${after.elements[0]?.ref}`);
}

process.exit(failures === 0 ? 0 : 1);
