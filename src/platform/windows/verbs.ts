/**
 * The verbs the Windows platform ADDS to the universal set — the schemas the model reads, and
 * nothing else. Kept apart from `driver.ts`, the same seam as macos/extra-verbs.ts. Each
 * description is what a model decides on, so an edit here is a change to behaviour, not to
 * documentation.
 */

import { Type } from "typebox";

import type { VerbSpec } from "../types.ts";

export const WINDOWS_VERBS: VerbSpec[] = [
  {
    kind: "activate",
    schema: Type.Object({ kind: Type.Literal("activate") }, {
      description: "Bring the bound window to the front (restoring it if minimized) and give it the user's keyboard; explain this and obtain permission first. "
        + "Also how to take the window back after the user has taken over.",
    }),
  },
  {
    kind: "type",
    schema: Type.Object({
      kind: Type.Literal("type"),
      text: Type.String({ description: "Text to type with real keystrokes into whatever holds the window's keyboard focus" }),
    }, { description: "Type text as real key events into the focused control. When its original text and selection are readable, wait for the expected result in that same field; a mismatch stops the call without retyping. Brings the window to the front." }),
  },
  {
    kind: "uia_action",
    schema: Type.Object({
      kind: Type.Literal("uia_action"),
      ref: Type.String({ description: "Element ref from the latest observe() (e.g. e12)" }),
      action: Type.Union(["expand", "collapse", "select", "toggle", "invoke"].map((a) => Type.Literal(a)), {
        description: "expand/collapse a tree node, combo box or menu; select an item; toggle a checkbox; invoke (an item's invoke OPENS it, like a double-click)",
      }),
    }, { description: "Run one UI Automation action the control itself offers, exactly as named — for what a click does not do: a click SELECTS a tree node ([collapsed]), expand shows its children. Refused when the control does not offer it. Desktop mode brings the window to the front; background mode runs it without doing so on Chromium, Electron and XAML controls." }),
  },
  {
    kind: "list_apps",
    readOnly: true,
    schema: Type.Object({
      kind: Type.Literal("list_apps"),
      query: Type.Optional(Type.String({ description: "Only entries whose name or id contains this (any case), e.g. '记事本' or 'paint'" })),
    }, { description: "The apps launchApp can start: the Start menu's entries as {name, id} — names are in the system language (计算器 on a Chinese Windows), so look them up here rather than guessing. A read; starts nothing." }),
  },
  {
    kind: "launch_app",
    schema: Type.Object({
      kind: Type.Literal("launch_app"),
      app: Type.String({ description: "A Start-menu name or id from listApps() ('记事本', 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'), or a program name the Run box takes ('notepad', 'mspaint')" }),
    }, { description: "Start an app and bind its new window as this session's target (an app not cleared yet asks the user, like binding it). Opens a window in front of the user: explain and obtain permission first (interaction:'desktop'). A single-instance app may answer by bringing its existing window forward — or, like Windows 11 Notepad, open a tab in the user's own window; that window is then the target." }),
  },
  {
    kind: "menu",
    schema: Type.Object({
      kind: Type.Literal("menu"),
      path: Type.Optional(Type.String({ description: "Menu command to run, as the listing shows it — names are in the system language (文件 › 另存为 on a Chinese Windows), so list first (menu({})) rather than guessing. › > / all separate; the last segment alone also works when unique; a path ending at a submenu lists its items. Omit to list the window's menu commands." })),
    }, { description: "List the window's menu-bar commands, or run one by its path. A classic Win32 menu bar runs the command directly, opening nothing; other menu bars are opened level by level and the item pressed, the way a person does. Running one brings the window to the front: explain and obtain permission first. Listing is a read; in background mode it opens no menu." }),
  },
  {
    kind: "select_text",
    schema: Type.Object({
      kind: Type.Literal("select_text"),
      ref: Type.String({ description: "The text field or document to select inside (from the latest observe())" }),
      text: Type.Optional(Type.String({ description: "The exact text to select (copy it verbatim from what you read); omit it to put the caret at the start / end of the field with caret alone" })),
      near: Type.Optional(Type.String({ description: "Nearby text that tells one occurrence from another; the match closest to it wins" })),
      caret: Type.Optional(Type.Union([Type.Literal("select"), Type.Literal("before"), Type.Literal("after")], {
        description: "select (default) leaves it selected — type, keys or paste then replace it; before / after put the caret there instead",
      })),
    }, { description: "Select part of a field's text, or put the caret in it, and give the field the keyboard focus — so type, keys or paste edit exactly that; set_text always replaces the whole field. The selection is read back from the field. Brings the window to the front." }),
  },
  {
    kind: "paste",
    schema: Type.Object({
      kind: Type.Literal("paste"),
      text: Type.String({ description: "The content as plain text" }),
      html: Type.Optional(Type.String({ description: "The same content as an HTML fragment, for apps that take rich text (Word, Outlook, web editors)" })),
      ref: Type.Optional(Type.String({ description: "The element you EXPECT to have the keyboard focus. Not a destination — the paste goes to the focus — but a mismatch is refused before the clipboard is touched. Pass it whenever you know where the text should go." })),
    }, { description: "Paste with Ctrl+V at the window's keyboard focus: brings the window to the front, puts the content on the user's clipboard (kept out of clipboard history and cloud sync) and puts their clipboard back afterwards, unless they copied something meanwhile. Explain these effects and obtain permission first. For long text and rich text; it is read back from the focused field when it can be." }),
  },
  {
    kind: "drag",
    schema: Type.Object({
      kind: Type.Literal("drag"),
      ref: Type.Optional(Type.String({ description: "Element to drag — REQUIRED unless x/y are given" })),
      x: Type.Optional(Type.Number({ description: "Drag start x in the latest screenshot (instead of ref)" })),
      y: Type.Optional(Type.Number({ description: "Drag start y" })),
      toRef: Type.Optional(Type.String({ description: "Element to drop onto — REQUIRED unless toX/toY are given" })),
      toX: Type.Optional(Type.Number({ description: "Destination x in the latest screenshot (instead of toRef)" })),
      toY: Type.Optional(Type.Number({ description: "Destination y" })),
      steps: Type.Optional(Type.Number({ description: "Motion events along the path (default 20, 2–60); more is slower and smoother, for apps that sample the pointer per frame" })),
    }, { description: "Drag with the user's real pointer: press the left button at the start, move to the destination, release — a file onto a folder, a slider thumb, a line in a drawing app. Brings the window to the front and moves the pointer; explain and obtain permission first. Needs a start (ref or x/y) AND a destination (toRef or toX/toY). Stops and releases if the user touches the mouse." }),
  },
];
