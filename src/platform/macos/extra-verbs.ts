/**
 * The verbs the macOS platform ADDS to the universal set — the schemas the model reads, and
 * nothing else. The wording is load-bearing (each description is what a model decides on), so
 * treat an edit here as a change to behaviour, not to documentation.
 */

import { Type } from "typebox";

import { SELECT_TEXT_VERB } from "./select-text-verb.ts";
import { SECONDARY_ACTIONS } from "./elements.ts";
import { DRAG_VERB } from "./mouse.ts";
import { TYPE_VERB } from "./type-verb.ts";
import type { VerbSpec } from "../types.ts";

export const MACOS_VERBS: VerbSpec[] = [
  {
    kind: "activate",
    schema: Type.Object({
      kind: Type.Literal("activate"),
    }, { description: "Bring the app's windows to the foreground and redirect the user's keyboard focus; explain this effect and obtain permission before calling." }),
  },
  {
    kind: "launch_app",
    schema: Type.Object({
      kind: Type.Literal("launch_app"),
      bundle: Type.String({ description: "Bundle id to launch and switch to, e.g. com.apple.TextEdit (never a display name — names are localised)" }),
    }, { description: "Switch this session to another app, launching it if it is not running. The app this session was given needs no such call — it is launched on first use — so this is for moving to a DIFFERENT app, and for making a document app that has every window closed open one again." }),
  },
  {
    kind: "menu",
    schema: Type.Object({
      kind: Type.Literal("menu"),
      path: Type.Optional(Type.String({ description: "Menu command to run, exactly as the listing shows it — menus are in the system language (Fichier › Nouveau on a French Mac), so list first (menu({})) rather than guessing an English name. › > / all separate; the last segment alone also works. Omit to list the commands runnable right now." })),
    }),
  },
  DRAG_VERB,
  TYPE_VERB,
  // The POINTER as three acts instead of one. `click` stays the verb for pressing a thing; these
  // are for a surface that wants a hand — an app that draws its own controls and watches the
  // pointer, a slider held while it moves, a popup that only accepts a press it saw arrive.
  {
    kind: "pointer_move",
    schema: Type.Object({
      kind: Type.Literal("pointer_move"),
      x: Type.Number({ description: "Where to move, in the coordinates of the last screenshot" }),
      y: Type.Number(),
      steps: Type.Optional(Type.Number({ description: "How many motion events the path is cut into (default 12, max 60). More steps is a slower, more human approach; an app that polls input per frame needs several" })),
    }, { description: "Move the user's real pointer along a path and leave it there; explain the pointer takeover and obtain permission first. While a button is held the path is posted as a drag." }),
  },
  {
    kind: "pointer_state",
    readOnly: true,
    schema: Type.Object({
      kind: Type.Literal("pointer_state"),
    }, { description: "Where the pointer is and what it is holding — the one READ of the three. Worth asking mid-drag (a press, then moves: nothing else says where the release will land) and after a click, whose rung decides whether the cursor came along. `grabbed` says the user's physical mouse is disconnected from the cursor right now, which only a held button does." }),
  },
  {
    kind: "pointer_press",
    schema: Type.Object({
      kind: Type.Literal("pointer_press"),
      button: Type.Optional(Type.String({ description: "left (default), right, middle" })),
    }, { description: "Hold a real mouse button, potentially changing foreground focus and temporarily disconnecting the physical mouse; explain these effects and obtain permission first. Always release in finally, including on failure." }),
  },
  {
    kind: "pointer_release",
    schema: Type.Object({
      kind: Type.Literal("pointer_release"),
      button: Type.Optional(Type.String({ description: "left (default), right, middle" })),
    }, { description: "Release an authorized mouse hold, including cleanup in background mode; without a held button this posts no input. Use pointerState to inspect pointer state." }),
  },
  // The element's OWN actions, beyond the click. A control advertises what it can do and
  // this runs one of them: the popup's menu, a menu item's pick, the stepper's increment.
  // Nothing is synthesised — an action the element does not advertise is refused, which is
  // the same reach boundary every verb here lives inside.
  {
    kind: "ax_action",
    schema: Type.Object({
      kind: Type.Literal("ax_action"),
      ref: Type.String({ description: "Element ref from the latest observe() (e.g. e12)" }),
      name: Type.Optional(Type.String({ description: "Visible name of the element — identity check + fallback locator" })),
      action: Type.String({
        description: `The action to run, as the element's [+…] mark names it: ${Object.values(SECONDARY_ACTIONS).join(", ")}`
          + " (the AX spelling, e.g. AXShowMenu, works too). An element only accepts actions it advertises — but"
          + " advertising one is no promise it does anything: read the observation after the act, not the mark.",
      }),
    }, { description: "Run one accessibility action the element itself offers — expand a popup's menu, pick an item in it, step a stepper. For a plain click use click; to dismiss a sheet, click its own button." }),
  },
  SELECT_TEXT_VERB, // schema beside its implementation, in select-text-verb.ts
  // Its own schema rather than the browser's, and the difference is not decoration: on a
  // page a paste is a synthetic event delivered to an element and the user's clipboard is
  // never touched, while here it is a COMMAND that follows the app's own focus and it does
  // go through their clipboard. `ref` is an EXPECTATION to be checked, never a destination
  // (measured).
  {
    kind: "paste",
    schema: Type.Object({
      kind: Type.Literal("paste"),
      text: Type.String({ description: "The content as plain text (Markdown goes here too)" }),
      html: Type.Optional(Type.String({ description: "The same content as HTML, for apps that accept rich text" })),
      ref: Type.Optional(Type.String({ description: "The element you EXPECT to have focus. Not a destination — the paste follows the app's focus — but a mismatch is refused instead of landing somewhere else. Pass it whenever you know where you want the text." })),
    }, { description: "Paste at the app's actual focus with the app frontmost, temporarily replacing the system clipboard and attempting to restore it afterwards; explain these effects and obtain permission first. Pass ref to verify focus before the clipboard is changed." }),
  },
];
