/**
 * How a TARGET argument becomes a ref: the find-by-name path, the point path, and the identity
 * check every verb runs before it acts. A handle must re-resolve itself at use (rows re-mint
 * underneath a loop), a point must never be mistaken for a ref, and a name that matches nothing
 * says what the surface DID carry. A factory because every path needs the driver, the run ledger
 * and the host's hooks.
 */

import type { ComputerUseDriver } from "../driver.ts";
import type { ToolResult } from "../types.ts";
import { coveredMiss, type FindMiss, type FindScope, type Handle, nearMiss, rankByName, tiedOthers } from "./find-target.ts";
import type { RunLedger, ApiHooks } from "./api-contract.ts";

export function createTargeting(
  driver: ComputerUseDriver,
  ledger: () => RunLedger,
  hooks: ApiHooks,
  firstLine: (r: ToolResult) => string,
) {
  const findByName = async (name: string, scope: FindScope = {}): Promise<Handle | null> => {
    return (await findWithMiss(name, scope)).h;
  };

  /** The same search, keeping what the READ knew for the journal line a miss writes, and the
   *  same knowledge as data (`why`) for `find(…, {why: true})`. */
  const findWithMiss = async (name: string, scope: FindScope = {}): Promise<{ h: Handle | null; miss: string; why: FindMiss | null }> => {
    const { elements, groups, partial, covered } = await driver.readElements();
    hooks.onRefs?.(elements.map((e) => e.ref));
    const h = rankByName(elements, name, scope, groups);
    if (h) return { h, miss: "", why: null };
    // The control IS here, under an overlay (an ad bar, a banner) — asked first: the text
    // fallback would call it "not a control" and send the model to text(), the opposite move.
    const found = coveredMiss(covered, name, scope, driver.scrollsInto)
      ?? nearMiss(elements, name, scope, await nameIsInText(name), groups);
    // A partial read cannot say "not here": the name may sit in the part it never reached.
    const miss = partial ? `${found.note} — but this read was PARTIAL (${partial}), so it may be in the part not read; find again, or narrow with within:` : found.note;
    return { h, miss, why: { ref: null, ...found, note: miss, ...(partial ? { partial } : {}) } };
  };

  /**
   * Does the surface's TEXT carry this name, when no control does? A second read, paid ONLY on a
   * miss, so the caller can tell "not here" from "here, but not a control". Anything that throws
   * answers false: this decorates a message, it never decides one.
   */
  const nameIsInText = async (name: string): Promise<boolean> => {
    const want = name.trim().toLowerCase();
    if (!want) return false;
    try {
      // The whole surface, not text()'s region: a name in a page's <header> is still "here".
      return (await driver.readTextForWait()).toLowerCase().includes(want);
    } catch {
      return false;
    }
  };

  /**
   * Why a `find(…, {why: true})` miss cannot be a target — its own note, and the ref it carries
   * when it has one — or null for anything else. Said by name: "a target must be a handle" would
   * hide that the script never checked the miss.
   */
  const missNote = (t: unknown): string | null => {
    const m = t as Partial<FindMiss> | null;
    if (!m || typeof m !== "object" || m.ref !== null || typeof m.reason !== "string") return null;
    return `the target is a find() miss (reason: ${m.reason}), not a control — ${m.note ?? ""}`
      + (m.match ? `. The control it names is ${m.match.ref}: pass that ref once you have dealt with the reason` : "");
  };

  /**
   * A POINT the model read off a screenshot — `{x, y}`, in that screenshot's own coordinates.
   *
   * The last resort, which every driver implements (both click paths branch on `hasPoint`): the
   * route for a control that AXPress and the key rung both fail to move (Electron web content).
   * {@link resolve} refuses it, so this is how a script says it. A find() handle carries no
   * coordinates, so the two shapes cannot collide.
   */
  const asPoint = (t: unknown): { x: number; y: number } | null => {
    const p = t as { x?: unknown; y?: unknown } | null;
    return p && typeof p === "object" && typeof p.x === "number" && typeof p.y === "number"
      ? { x: p.x, y: p.y }
      : null;
  };

  /**
   * A target the script named → the ref to act on, re-resolved NOW.
   *
   * A handle carries the name it was found by, so a ref re-minted underneath (a list
   * re-rendered) is found again by name. A bare ref string gets the SAME gate a tool call
   * applies: an unknown ref is refused by name — skipping it would make the script the one route
   * around the identity check.
   */
  const resolve = async (t: unknown, opts: { write?: boolean } = {}): Promise<{ ref: string; name?: string }> => {
    if (typeof t === "string") {
      hooks.onTarget?.(t);
      if (!driver.knownRef(t)) throw new Error(driver.staleRefNote(t));
      return { ref: t };
    }
    if (t == null) {
      throw new Error(`the target is ${t} — a find() that matched nothing answers null, and its line above says why`);
    }
    const missed = missNote(t);
    if (missed) throw new Error(missed);
    let h = t as Handle;
    if (typeof h.ref !== "string") {
      throw new Error("a target must be a find() handle, a ref string, or a point {x, y} read off a screenshot");
    }
    hooks.onTarget?.(h.ref);
    // Group membership may change while the DOM node (and its ref) survives. Re-check the scope
    // before using a group-bound handle, not only after a ref disappears.
    if (h.nearGroup) {
      const fresh = await findByName(h.name, h.scope);
      if (!fresh || fresh.nearGroup !== h.nearGroup) throw new Error(`"${h.name}" is no longer in group "${h.nearGroup}" — observe() before acting`);
      h = fresh;
      hooks.onTarget?.(h.ref);
    }
    // A TIE, about to be written to. In the repl find and click live in ONE script, so the
    // journal's "1 of 2" arrives after the wrong control was pressed. Enforced for writes only:
    // reads keep the guess, and naming a ref stays the way to say "I looked".
    const tied = opts.write ? tiedOthers(h) : [];
    if (tied.length) {
      const list = [{ ref: h.ref, name: h.name, role: "", id: h.id }, ...tied]
        .map((c) => `${c.ref}${c.id ? ` (${c.id})` : ""}`).join(", ");
      throw new Error(`"${h.name}" names ${tied.length + 1} controls of the same role and nothing tells them apart `
        + `(${list}) — this write would be a guess. Narrow it: find('${h.name}', {within}) or {near}, `
        + "or observe() and act by ref.");
    }
    // Known is not alive: refs accumulate, so a node re-rendered away (a form after Save, a page
    // after reload inside one run) still passes the gate, and the verb would miss by ref and then
    // look the name up among a few roles only. Ask the surface, and re-find like any gone ref.
    if (driver.knownRef(h.ref) && (!driver.refLive || await driver.refLive(h.ref))) return { ref: h.ref, name: h.name };
    const again = await findByName(h.name, h.scope ?? {});
    if (!again) throw new Error(`"${h.name}" is no longer on the surface (its ref ${h.ref} is gone)`);
    // UNAMBIGUOUS when found and ambiguous now: with the ref gone, "the same control" is a guess,
    // and the surface changed in exactly the way that makes it wrong (a new message, a second
    // dialog). A handle ambiguous from the start is left alone — the caller took the pick.
    if (h.matches === 1 && (again.matches ?? 1) > 1) {
      throw new Error(`"${h.name}" now matches ${again.matches} controls and its own ref ${h.ref} is gone, `
        + "so re-resolving it would be a guess — observe() and act by ref, or narrow it: "
        + `find('${h.name}', {role, within, visible})`);
    }
    return { ref: again.ref, name: again.name };
  };

  /**
   * `keys(chord, {focus: t})` — the keyboard's own identity check, asserted and never fixed.
   *
   * Keystrokes go to whatever holds the focus, the one target a script cannot name; anything
   * between a write and a keystroke can move it, so a script that CARES says where keys land.
   * Asserted, not acquired: taking focus can validate a field, open a popup or scroll, and doing
   * that silently hides why the focus was lost. Unknown or ambiguous focus cannot satisfy the
   * expectation: give a pending change a short chance to settle, then refuse without posting.
   */
  const requireFocus = async (t: unknown): Promise<void> => {
    const { ref, name } = await resolve(t);
    const deadline = Date.now() + 200;
    for (;;) {
      const { elements } = await driver.readElements();
      const focused = elements.filter((e) => /(^|[,\s])focused([,\s]|$)/.test(e.state));
      if (!elements.some((e) => e.ref === ref)) {
        throw new Error(`focus: ${ref} is not in the current observation — observe() and name a listed control`);
      }
      if (focused.length === 1) {
        const has = focused[0]!;
        if (has.ref === ref) return;
        throw new Error(`the keyboard focus is on ${has.ref} ${has.role}${has.name ? ` "${has.name}"` : ""}, not on `
          + `${ref}${name ? ` "${name}"` : ""} — nothing was pressed. click it, set_text it, or select_text with a caret to `
          + "focus it first, then send the key");
      }
      if (Date.now() >= deadline) {
        throw new Error(`focus could not be verified for ${ref} — this surface reports ${focused.length ? "multiple focused elements" : "no focused element"}`
          + "; nothing was pressed. Observe and explicitly focus the intended control before sending a guarded key."
          + " Omit focus only when you deliberately want to send to the surface's current focus without verification.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { findByName, findWithMiss, missNote, asPoint, resolve, requireFocus };
}
