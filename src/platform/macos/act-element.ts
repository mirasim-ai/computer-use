/**
 * Acting on ONE element the model named by ref — the ref table, the identity check, and the
 * three things that can then be done to it (press it, run one of its own actions, set its value).
 *
 * Everything here starts from a ref and ends at ONE `press`/`setvalue` call, and touches no
 * driver window/frame state: it needs only the helper call, and the driver keeps the walk that
 * fills {@link ElementActs.keys}.
 */

import { AxRequestError } from "./ax-client.ts";
import { normName } from "./ax-shapes.ts";
import { SECONDARY_ACTIONS, axActionName } from "./elements.ts";
import { nameAgrees } from "../driver-refs.ts";
import type { ActResult } from "../types.ts";

/**
 * How long a write's read-back keeps looking, and the gap between looks. Same numbers and reason
 * as `press-rungs.ts` PRESS_SETTLE_MS (the tree catches up after the call returns), declared here
 * because importing it back would be a runtime cycle. A write that landed pays nothing.
 */
const WRITE_SETTLE_MS = 800;
const WRITE_SETTLE_STEP_MS = 60;

/** What a ref resolves to: the helper's live handle plus what the element was when observed. */
/** `enabled` is the app's own `AXEnabled`. Not a veto on the cheap rungs (the flag does lie), only
 *  on the one that costs the user their front window (`click-verb.ts`). */
export interface RefTarget { key: string; name: string; role: string; actions: string[]; enabled: boolean }

/** The driver's helper channel, passed in so nothing here holds driver state. */
export type AxCall = <T>(op: string, params?: Record<string, unknown>) => Promise<T>;

/** Did the field take the text? Exact first, then NUMERICALLY — a control whose value is a number
 *  answers in its own formatting ("10" written back as "10.000000"), and calling that a rejected
 *  write would block a submit over a field that took it. */
function sameValue(back: string, sent: string): boolean {
  if (back === sent || back.trim() === sent.trim()) return true;
  const a = Number(back), b = Number(sent);
  return back.trim() !== "" && sent.trim() !== "" && Number.isFinite(a) && Number.isFinite(b) && a === b;
}

export class ElementActs {
  /** ref → helper key, replaced wholesale by every walk (the helper re-keys its table too). */
  keys = new Map<string, RefTarget>();

  /** Public because verbs kept in their own files (`select-text-verb.ts`) act through it. */
  constructor(readonly call: AxCall) {}

  /**
   * The helper's own keys, swapped for the refs the caller holds — the rewriter the transport
   * installs (@see AxTransport.nameKeys).
   *
   * A key that belongs to nothing in the listing is SAID to be that rather than left as a number:
   * a point click can hit the window itself, which was never a listed element.
   */
  nameKeys = (msg: string): string => msg.replace(/\bk\d+\b/g, (key) => {
    for (const [ref, target] of this.keys) if (target.key === key) return ref;
    return "an element outside the listing";
  });

  /** The ref the model gave, checked against the name it gave (the same lenient {@link nameAgrees}
   *  every platform applies): a stale ref that now sits on another control is refused with the
   *  ref that DOES carry that name, never pressed. */
  resolve(ref: unknown, name: unknown): RefTarget | ActResult {
    const k = typeof ref === "string" ? this.keys.get(ref) : undefined;
    if (!k) return this.staleRef(ref);
    if (typeof name === "string" && name.trim() && k.name && !nameAgrees(k.name, name)) {
      const want = normName(name);
      const actual = [...this.keys].find(([, v]) => normName(v.name) === want)?.[0];
      return {
        ok: false,
        note: `${String(ref)} is now "${k.name}", not "${name}"${actual ? ` — "${name}" is ${actual}` : " — re-observe"}; nothing was pressed`,
      };
    }
    return k;
  }

  /** The ref standing for a helper key right now — the reverse of {@link resolve}, for reporting
   *  an element the APP named (its focus) in the vocabulary the model has. */
  refForKey(key: string): string | null {
    for (const [ref, v] of this.keys) if (v.key === key) return ref;
    return null;
  }

  staleRef(ref: unknown): ActResult {
    return { ok: false, note: `ref ${String(ref ?? "(none)")} is not in the latest observation — re-observe and act on a current ref` };
  }

  /** How a refusal names the element: its label, or its role and ref when it has none. */
  what(k: RefTarget, ref: unknown): string {
    return k.name ? `"${k.name}"` : `the unnamed ${k.role} ${String(ref)}`;
  }

  /**
   * What to do with the menu AXShowMenu opens, said on every one so the agent is never stuck with a
   * menu it cannot close.
   *
   * A menu raised on a WINDOW control (a title-bar button) is the SYSTEM's, and its tracking loop
   * reads the session's event stream, while `keys` posts to ONE pid. So Escape never reaches it
   * until the app is brought forward; then the same Escape closes it.
   */
  private static readonly MENU_TAIL = ". Escape closes it; if Escape does nothing the menu is the "
    + "system's and only hears the keyboard while the app is frontmost — activate, then Escape";

  /**
   * `ax_action` — run one action the element itself advertises.
   *
   * Two refusals, both BEFORE the call, each naming what the model can do instead: a string that is
   * no AX action, and an action this element does not offer (rather than the helper's -25206).
   *
   * The second check runs only when the element advertises SOMETHING: ungranted, every action list
   * reads as empty, and the helper must be the one to name the missing grant, as in {@link press}.
   */
  async action(ref: unknown, name: unknown, action: string): Promise<ActResult> {
    const k = this.resolve(ref, name);
    if (!("key" in k)) return k;
    const want = axActionName(action);
    if (!want) {
      return { ok: false, note: `"${action}" is not an accessibility action — `
        + `use one of ${Object.values(SECONDARY_ACTIONS).join(", ")}, or an AX name like AXShowMenu` };
    }
    const what = this.what(k, ref);
    if (k.actions.length && !k.actions.includes(want)) {
      return { ok: false, note: `${what} does not offer ${want} — it offers ${k.actions.join(", ")}. `
        + "Run one of those, or click it" };
    }
    try {
      await this.call("press", { key: k.key, action: want });
    } catch (e) {
      if (e instanceof AxRequestError && e.code === "stale_key") return this.staleRef(ref);
      if (e instanceof AxRequestError && e.code === "ax_error") {
        // NOT "it will not perform it here": Chrome's address bar answers -25204 and opens its
        // context menu anyway, sometimes after a delay. The error is about the call, not the
        // effect; `mayHaveActed` makes the tool layer re-observe.
        return { ok: false, mayHaveActed: true, note: `the app answered AXError ${e.ax ?? "?"} to ${want} on ${what} — `
          + "it advertises the action but reports it cannot run it. Some apps answer this and act anyway, "
          + "sometimes after a delay; if the observation shows nothing happened, activate the app and drive it with keys"
          + (want === "AXShowMenu" ? ElementActs.MENU_TAIL : "") };
      }
      throw e;
    }
    return { ok: true, note: `ran ${want} on ${what}${want === "AXShowMenu" ? ElementActs.MENU_TAIL : ""}` };
  }

  async press(ref: unknown, name: unknown, times: number): Promise<ActResult> {
    const k = this.resolve(ref, name);
    if (!("key" in k)) return k;
    const what = this.what(k, ref);
    // AXPress is not the only action that stands in for a click: an Open dialog's source-list
    // CELLS offer only AXOpen. The helper's `press` takes an action name for that.
    //
    // The call goes out even when NOTHING here can stand in for a click, and that ordering is
    // load-bearing: ungranted, every element's actions read as none, so refusing first would say
    // "no clickable action" to what is really "Accessibility was never granted". The helper
    // answers that one; only an ax_error is ours to explain.
    // A text field has no press; what a click does to one is FOCUS it. AXConfirm (which such
    // fields do offer) is Enter, not a click.
    if (!k.actions.includes("AXPress") && (k.role === "textbox" || k.role === "combobox") && !k.actions.includes("AXOpen")) {
      const focused = await this.focus(ref, name);
      return focused.ok
        ? { ok: true, note: `a ${k.role} has no press, so the click focused it — set_text, type or keys go there now` }
        : focused;
    }
    const act = k.actions.includes("AXPress")
      ? "AXPress"
      : ["AXOpen", "AXPick"].find((a) => k.actions.includes(a));
    try {
      for (let i = 0; i < times; i++) {
        await this.call("press", { key: k.key, ...(act && act !== "AXPress" ? { action: act } : {}) });
      }
    } catch (e) {
      if (e instanceof AxRequestError && e.code === "stale_key") return this.staleRef(ref);
      if (e instanceof AxRequestError && e.code === "ax_error") {
        // Saying "AXPress" for something else that was tried is how a refusal starts lying.
        const because = !act
          ? `it has no action that can stand in for a click — ${k.actions.length ? `it offers only ${k.actions.join(", ")}` : "it advertises none at all"}. Act on a listed control that has one, or activate the app and drive it with keys`
          : act === "AXPress"
            ? "it may need real focus: try activate, then keys"
            : `the element advertises ${act} but the app reports it cannot run it; if nothing changed below, activate the app and drive it with keys`;
        // Same reading as in `action` above: the call reached the app, so the error is about the
        // call and the effect is the observation's to report.
        return { ok: false, mayHaveActed: true, note: `the app answered AXError ${e.ax ?? "?"} to ${act ?? "AXPress"} on ${what} — ${because}` };
      }
      throw e;
    }
    return act && act !== "AXPress"
      ? { ok: true, note: `this element has no AXPress, so its ${act} ran instead — the app's own ${act === "AXOpen" ? "open" : "selection"}, which may do more than a click would` }
      : { ok: true };
  }


  /** Give one element keyboard focus, so what follows (a paste, a keystroke) lands in it and not
   *  in whatever the app happened to have focused. */
  async focus(ref: unknown, name: unknown): Promise<ActResult> {
    const k = this.resolve(ref, name);
    if (!("key" in k)) return k;
    try {
      await this.call("focus", { key: k.key });
    } catch (e) {
      if (e instanceof AxRequestError && e.code === "stale_key") return this.staleRef(ref);
      if (e instanceof AxRequestError && e.code === "ax_error") {
        return { ok: false, note: `${this.what(k, ref)} will not take focus (AXError ${e.ax ?? "?"}) — `
          + "click it first, or act on the control that does hold focus" };
      }
      throw e;
    }
    return { ok: true };
  }

  /**
   * `set_text` with a ref: AXSetValue replaces the field's content outright — this platform has
   * no fill-style partial write, and saying so stops the model expecting a caret.
   *
   * The field is then given the keyboard FOCUS: the write does not move it, and `keys` goes
   * wherever the app has it (a following Enter would hit some other control). The note says which
   * way it went, so the model knows before pressing Enter if the field refused focus.
   */
  async setValue(ref: unknown, name: unknown, text: string): Promise<ActResult> {
    const k = this.resolve(ref, name);
    if (!("key" in k)) return k;
    try {
      await this.call("setvalue", { key: k.key, text });
    } catch (e) {
      if (e instanceof AxRequestError && e.code === "stale_key") return this.staleRef(ref);
      // A field that refuses AXSetValue is the ordinary SwiftUI case, and the route around it is
      // `type`; returned, not thrown, since a throw ends the whole run. As in `press`, the error is
      // about the call.
      if (e instanceof AxRequestError && e.code === "ax_error") {
        return { ok: false, mayHaveActed: true,
          note: `the app answered AXError ${e.ax ?? "?"} to AXSetValue on ${this.what(k, ref)} — it takes typed input only. `
            + "Focus it (click it, or select_text with a caret), then type({text})." };
      }
      throw e;
    }
    const focused = await this.tookFocus(k.key);
    const where = focused
      ? " The field now holds the keyboard focus, so keys and type go here."
      : ` ${this.what(k, ref)} would NOT take the keyboard focus, so keys and type go to whatever the app has focused — `
        + "click the field, or select_text with a caret, before pressing a key.";
    // A field that offers AXConfirm commits on Enter, and until then the value is the app's to keep
    // or drop (Finder's name cell reads the new name back and renames nothing), so the read-back is
    // no verification here and the note says what commits it.
    if (k.actions.includes("AXConfirm")) {
      // A PATH written into a NAME field is not followed: typed, a Save panel's name field treats
      // "~/…" as Go To Folder, but AXSetValue bypasses that and the panel silently saves a file named
      // "~:some-folder:file.rtf" in the folder it shows. The panel's own Go To Folder field
      // (`#PathTextField`) is exempt.
      if (/^[~/]/.test(text) && text.includes("/") && k.name !== "#PathTextField") {
        return { ok: true, note: `WARNING: ${this.what(k, ref)} is a NAME field and "${text}" is a path — a Save panel does not `
          + "follow a path written this way: it saves a file named with the slashes turned into colons, in the folder it is "
          + "showing now. Put only the file name here, and choose the folder first (the panel's location popup or sidebar by "
          + `ref, or ⌘⇧G Go To Folder with the app frontmost). This field commits on Enter.${where}` };
      }
      return { ok: true, note: "value set through accessibility (replaces the field's content). This field commits on Enter — "
        + "keys('Enter') commits it, Escape discards it. If the value does not stick (a file being renamed), the field takes "
        + `text only while editing: Enter to start editing, then type({text}), then Enter.${where}` };
    }
    // The READ-BACK is not optional: `verified` is a verdict (the field holds the sent text), and
    // the tool layer blocks a queued submit on an explicit false. Apps do accept a write and drop
    // it (a QuickTime timeline slider). A value that cannot be read leaves `verified` UNSET (no
    // opinion, as on the browser side), never false.
    //
    // It POLLS: a write into web content lands asynchronously, and a read taken at once returns the
    // value from before it, which would wrongly block the submit.
    //
    // An EMPTY write is exempt: a field that shows a placeholder when empty can never read back as
    // "", so there is no verdict to give.
    const back = text === "" ? null : await this.readBackUntil(k.key, text);
    if (back === null) return { ok: true, note: `value set through accessibility (replaces the field's content).${where}` };
    if (!sameValue(back, text)) {
      const cut = (v: string) => (v.length > 60 ? `${v.slice(0, 60)}…` : v);
      return { ok: true, verified: false,
        note: `WARNING: ${this.what(k, ref)} ${back ? `reads «${cut(back)}»` : "is still empty"} after the write, not what you sent — `
          + "the app accepted AXSetValue and discarded it. A control that takes typed input only (a slider, a search field "
          + `that filters as you type) needs type({text}) after a click.${where}` };
    }
    return { ok: true, verified: true, note: `value set through accessibility (replaces the field's content).${where}` };
  }

  /** One element's value as the app reports it now — best effort, for the write above: a refusal
   *  or an unreadable value is "no opinion" (null), never a verdict. */
  private async readBack(key: string): Promise<string | null> {
    try {
      const v = (await this.call<{ value?: string }>("value", { key })).value;
      return v === undefined || v === null ? null : String(v);
    } catch {
      return null;
    }
  }

  /** {@link readBack} until the field holds `want` or the deadline passes, and the LAST value
   *  either way. */
  private async readBackUntil(key: string, want: string): Promise<string | null> {
    const deadline = Date.now() + WRITE_SETTLE_MS;
    for (;;) {
      const back = await this.readBack(key);
      if (back === null || sameValue(back, want) || Date.now() >= deadline) return back;
      await new Promise((r) => setTimeout(r, WRITE_SETTLE_STEP_MS));
    }
  }

  /** Best-effort AXFocused on one key: a refusal is an ANSWER here (the note says the keyboard
   *  is elsewhere), never a reason to fail a write that landed. */
  async tookFocus(key: string): Promise<boolean> {
    try {
      await this.call("focus", { key });
      return true;
    } catch {
      return false;
    }
  }
}
