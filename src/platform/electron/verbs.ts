/**
 * The two verbs an ELECTRON app gets that a browser tab does not, as schemas.
 *
 * Here rather than in `chromium/` because both are about an app rather than a page: a file input
 * in a desktop app has no OS picker to answer, and `run_js` is the app's own DevTools console.
 */

import { Type } from "typebox";


import { RUN_JS_CODE_DESC, RUN_JS_MAX_MS, RUN_JS_MIN_MS, RUN_JS_MS_DESC } from "../chromium/run-js.ts";
import { type VerbSpec } from "../types.ts";

/**
 * upload, minus the armed form. The browser's verb can omit `ref` and answer the NEXT file
 * chooser, because a page's chooser is Chromium's and CDP intercepts it. An Electron app can
 * also call `dialog.showOpenDialog` from the main process, a native window outside CDP with
 * nothing to intercept, so the armed form would park the agent before a modal nobody can close.
 *
 * So `ref` is REQUIRED: fill a real `<input type=file>` and no chooser opens. A button wired to
 * the app's own picker has no route, and the description says so rather than letting it hang.
 */
export const UPLOAD_TO_REF_VERB: VerbSpec = {
  kind: "upload",
  schema: Type.Object({
    kind: Type.Literal("upload"),
    paths: Type.Array(Type.String(), {
      description: "Absolute path(s) of the file(s) to upload. They must already exist on this machine.",
      minItems: 1,
    }),
    ref: Type.String({
      description: "REQUIRED here: the attach control you can SEE — the paperclip/add button, or a `file` element if the list shows one. "
        + "The input behind such a button is hidden and never appears in an observation, so it is found from this ref instead. "
        + "If the button opens the app's OWN file dialog rather than a hidden input, that window is native and cannot be answered — use another route (many apps also accept a typed or pasted path).",
    }),
    name: Type.Optional(Type.String({ description: "Visible name of the element — identity check + fallback locator" })),
  }),
};

/**
 * The DevTools console as a verb — a DEBUG channel, and it says so. This driver's persona is a
 * developer debugging their own app, for whom the console is ordinary. The line it must not
 * cross lives with the implementation (chromium/run-js.ts): OPERATING the product goes through
 * the interaction verbs.
 *
 * App command bridges are NOT verbs: the console reaches them as ordinary JS, which keeps this
 * driver app-agnostic.
 */
export const RUN_JS_VERB: VerbSpec = {
  kind: "run_js",
  readOnly: true,
  schema: Type.Object({
    kind: Type.Literal("run_js"),
    code: Type.String({ description: `${RUN_JS_CODE_DESC} This is YOUR OWN app under development, so the console is `
      + "an ordinary part of debugging it — including the command bridges it exposes." }),
    ms: Type.Optional(Type.Integer({ minimum: RUN_JS_MIN_MS, maximum: RUN_JS_MAX_MS, description: RUN_JS_MS_DESC })),
  }),
};
