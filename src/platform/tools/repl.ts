/**
 * `computer_repl` — the GUI as one persistent JavaScript session, plus `computer_repl_reset`.
 * What it adds to a one-shot script over the API in api.ts:
 *
 *  - **A runtime that lives as long as the session.** One `vm` context; top-level declarations
 *    persist (repl-code.ts). Caps and the journal stay PER CALL: a round-trip budget.
 *  - **Surface handles.** A handle is a target (tab, window, app) with the verbs bound to it;
 *    `h.click(…)` switches to `h` first. Work is serialized (one active target per driver), and a
 *    ref acted on through a handle other than the one that minted it is refused BEFORE dispatch:
 *    browser refs are minted per page and collide across tabs.
 *  - **The reference in the first result.** An MCP host has no system prompt, so the API docs
 *    ride the session's first result and `computer.help()`; the resident description stays short.
 *
 * `computer_repl_reset` is a separate tool because a wedged context cannot reset itself. It drops
 * only the JS bindings; refs and change signatures live on the driver and survive.
 */

import { cutText } from "../text-cut.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createContext, runInContext, type Context } from "node:vm";
import { Type } from "typebox";
import { spec, text, type ComputerUseToolSpec, type TargetInfo, type ToolResult } from "../types.ts";
import { ABANDON_DRAIN_MS, CANCEL_GRACE_MS, MAX_ACTIONS, MAX_MS, STUCK_GRACE_MS, SYNC_MAX_MS, RETURN_CAP, MAX_REF_OWNERS, trimObservation, type Render } from "./repl-budget.ts";
import { createComputerUseApi, noteOf, renderJournal, stringify, verbGate, type JournalLine, type RunLedger, type WriteRound } from "./api.ts";
import { prepareCode } from "./repl-code.ts";
import { pickSurface } from "./repl-pick.ts";
import { NO_IMPORT, onComputer, onHandle, sandboxConsole, sandboxGlobal } from "./repl-explain.ts";
import { fnName } from "./api-contract.ts";
import { apiReference, platformReference, replDescription, RESET_DESCRIPTION } from "./repl-docs.ts";
import { ComputerUseOwnership, IDLE_RELEASE_MS, OwnershipBusyError, type OwnershipProvider } from "../ownership.ts";
import type { MountedTarget, PlatformSlice, Slice, SurfaceHandle } from "./repl-state.ts";

export type { PlatformSlice } from "./repl-state.ts";

/** Journal kinds that touch nothing — a run made only of these is a look, not an action. */
const READ_KINDS = new Set(["observe", "find", "text", "value", "page", "screenshot", "diagnostics", "targets", "log", "verb", "release"]);
/** Verbs whose effect is not on the observed surface (an answer for a LATER dialog, a tab closed
 *  beside this one): a frozen screen after them is not "no effect". */
const OFF_SURFACE_KINDS = new Set(["dialog", "close_tab"]);
/** What a call its client cancelled is told, at the verb it would have started next. */
const CANCELLED_HEAD = "the client cancelled this call";
const CANCELLED = `${CANCELLED_HEAD}, so it stops before its next operation`;

export function createReplTools(
  mounted: PlatformSlice[],
  opts: { docsDelivered?: boolean; ownership?: OwnershipProvider; idleReleaseMs?: number;
    /** TEST SEAMS ONLY: a call's wall clock and how far past it a call may go before it is ended. */
    maxMs?: number; stuckGraceMs?: number; cancelGraceMs?: number } = {},
): ComputerUseToolSpec[] {
  if (!mounted.length) throw new Error("createReplTools needs at least one platform");
  const maxMs = opts.maxMs ?? MAX_MS;
  const stuckGraceMs = opts.stuckGraceMs ?? STUCK_GRACE_MS;
  const cancelGraceMs = opts.cancelGraceMs ?? CANCEL_GRACE_MS;
  /** Windows apps are named in the tool's own text only where they are mounted (repl-docs.ts). */
  const windowsApps = mounted.some((m) => m.driver.platform === "windows");
  // ── Session state ─────────────────────────────────────────────────────────
  let sandbox: Context | null = null;
  const ownership = opts.ownership ?? new ComputerUseOwnership();
  const leaseGroups = new WeakMap<SurfaceHandle, string>();
  /** Every resource key of a handle's last claim, so a re-claim can tell a NARROWER claim on the
   *  same target (an app that opened a window) from a different target. @see claim */
  const leaseKeys = new WeakMap<SurfaceHandle, Set<string>>();
  let ownershipRefusal: string | null = null;
  let resetPending = false;
  let callFinished = Promise.resolve();
  let callRunning = false;
  /** Armed when a call ends: an idle runtime lets go of its claims (@see IDLE_RELEASE_MS). */
  let idleTimer: NodeJS.Timeout | null = null;
  /** The idle release in progress — a call that starts meanwhile waits for it, so the release
   *  cannot delete a claim that call has just taken. */
  let idleReleasing: Promise<void> | null = null;
  const idleReleaseMs = opts.idleReleaseMs ?? IDLE_RELEASE_MS;
  let requestedHelp: string | null = null;
  let lastBound: SurfaceHandle | null = null;
  /** Which slice the last bind landed on — the one the end-of-run observation reads. */
  let landed: Slice;
  /** Has the platform-independent half of the reference been delivered (once per session)? */
  let coreSent = !!opts.docsDelivered;
  /** The host restarted this runtime (idle child reaped and respawned) for a caller that already
   *  read the reference: say so in one line instead of resending ~9K characters. */
  let respawnNoteDue = !!opts.docsDelivered;
  /** The ledger of the call in progress; null between calls, so a verb left un-awaited by a
   *  previous call is refused rather than charged to a stranger. */
  let current: RunLedger | null = null;
  /**
   * Which call the code calling a verb was started by, and which call is running. They differ for
   * code that outlived its call: a call ended from outside leaves its code suspended on whatever
   * it awaited, and when that settles the code goes on, in the middle of a later call. Its verbs
   * must not act there, nor be charged to that call (@see verbGate).
   */
  const calls = new AsyncLocalStorage<object>();
  let running: object | null = null;
  /** Set once the call in progress hit a cap and said so: the code was told to stop. A verb
   *  called after that is not answered at all, and that ends the call (@see verbGate). */
  let capped: string | null = null;
  /** End the call in progress from outside; `end` is null between calls. @see execute */
  const outside: { end: ((why: string) => void) | null } = { end: null };
  const ledger = (): RunLedger => {
    if (!current) throw new Error("no computer_repl call is in progress — every verb must be awaited inside the call that started it");
    return current;
  };
  /** Which surface minted each ref (see the header): refused when used through another handle. */
  const refOwner = new Map<string, string>();
  const handles = new Map<string, SurfaceHandle>();
  /** Which platform a handle belongs to, and its driver-side id. Kept OUT of the handle: every own
   *  property of a script-held object is API. */
  const owner = new WeakMap<SurfaceHandle, { slice: Slice; inner: string }>();
  // A browser disconnect must not release a native operation that is still draining.
  for (const { driver } of mounted) driver.onDisconnect(async () => {
    for (const h of handles.values()) {
      if (owner.get(h)?.slice.driver !== driver) continue;
      const group = leaseGroups.get(h);
      if (group) await ownership.release(group);
      leaseGroups.delete(h);
      for (const [ref, id] of refOwner) if (id === h.id) refOwner.delete(ref);
    }
  });
  /** Several platforms mounted ⇒ surface ids carry a `<platform>/` prefix, since drivers mint ids
   *  independently and may collide. One platform ⇒ ids are the driver's own. */
  const prefixed = mounted.length > 1;
  /** The handle a verb is running through right now (where a ref's owner is read from); null
   *  between calls. */
  let acting: SurfaceHandle | null = null;
  /** The platform the CALL in progress is about (`computer_repl.platform`), or null for all
   *  mounted. A run then lists and binds only that platform's surfaces and never wakes another
   *  (listing the browser would start Chrome for a call about a macOS app). */
  let scoped: Slice | null = null;
  /** The surface the CALL in progress was given by its host (`computer_repl.target`), bound before
   *  the code ran — what `computer.surface()` with no argument means in that call. Null in a call
   *  that names none. */
  let hostBound: SurfaceHandle | null = null;

  const rememberRefs = (refs: string[]) => {
    const owner = acting?.id;
    if (!owner) return;
    for (const r of refs) { refOwner.delete(r); refOwner.set(r, owner); }
    for (const r of refOwner.keys()) { if (refOwner.size <= MAX_REF_OWNERS) break; refOwner.delete(r); }
  };
  const checkOwner = (ref: string) => {
    if (!acting) return;
    const owner = refOwner.get(ref);
    if (owner && owner !== acting.id) {
      throw new Error(`ref ${ref} was read on surface ${owner}, not on ${acting.id} (${acting.title}) — act on it through `
        + `computer.surface('${owner}'), or observe ${acting.id} and use one of its refs`);
    }
  };

  const gate = verbGate((note) => current?.push("verb", "", false, note), () => {
    if (calls.getStore() !== running) return true;
    if (capped === null) return false;
    // Told once already; code that carries on is not told again (it would spin on the refusals).
    outside.end?.(capped);
    return true;
  });
  const slices: Slice[] = mounted.map((m) => ({
    ...m,
    id: m.driver.platform,
    api: createComputerUseApi(m.driver, ledger, {
      onRefs: rememberRefs, onTarget: checkOwner,
      beforeAction: async (kind, args) => {
        if (!acting) throw new Error("An action needs a bound surface.");
        const group = leaseGroups.get(acting);
        if (!group) throw new Error("The target was released; observe it before acting again.");
        try { await ownership.claim(group, await m.driver.actionResources(kind, args)); }
        catch (e) {
          if (e instanceof OwnershipBusyError) ownershipRefusal = e.message;
          throw e;
        }
      },
    }),
    docsDue: !opts.docsDelivered,
    lastMiss: null,
  }));
  landed = slices[0]!;
  // The observation names surfaces by the driver's own ids; under a prefix those name nothing.
  if (prefixed) for (const sl of slices) sl.driver.surfaceIdPrefix = `${sl.id}/`;
  /** The first platform's API — the home of `log`, which touches no surface and so belongs to
   *  no platform, and the name set the "verbs are not top-level" rewording checks. */
  const raw = slices[0]!.api;

  /** Every surface of every mounted platform, each tagged with its platform. With several
   *  mounted, an unreachable one is reported and skipped so it cannot hide the others; with ONE
   *  mounted its failure is raised. */
  const allTargets = async (): Promise<MountedTarget[]> => {
    const out: MountedTarget[] = [];
    const listed = scoped ? [scoped] : slices;
    for (const slice of listed) {
      let ts: TargetInfo[];
      try {
        ts = await slice.driver.listTargets();
      } catch (e) {
        if (listed.length === 1) throw e;
        // Said when it CHANGES, not on every listing: a dead port fails the same way every call.
        const why = e instanceof Error ? e.message : String(e);
        if (slice.lastMiss !== why) current?.push("targets", slice.id, false, `${slice.id} is not reachable: ${why}`);
        slice.lastMiss = why;
        continue;
      }
      slice.lastMiss = null;
      for (const t of ts) out.push({ ...t, id: prefixed ? `${slice.id}/${t.id}` : t.id, slice, inner: t.id });
    }
    return out;
  };

  /** A handle whose surface is gone — thrown by {@link bind}, and caught only by `wait` (below). */
  class SurfaceGone extends Error {}

  /** Make `h` the active target if it is not already; a gone target is a named refusal. */
  const bind = async (h: SurfaceHandle): Promise<void> => {
    const own = owner.get(h)!;
    // The end-of-run observation reads whatever the run last bound.
    landed = own.slice;
    lastBound = h;
    if (await own.slice.driver.isActiveTarget(own.inner)) {
      await claim(h, true);
      return;
    }
    ledger().charge("focus");
    const res = await own.slice.driver.focusTarget(own.inner);
    // What the bind DID beats the cached title (which may still say "not running; binding it
    // starts it").
    ledger().push("focus", h.id, res.ok, noteOf(res) || `→ ${h.title}`);
    if (!res.ok) {
      handles.delete(h.id);
      // Not "closed": a tab another extension cut off is still open, and the driver's NOTE says so.
      throw new SurfaceGone(`surface ${h.id} (${h.title}) is gone from this session — closed, replaced or out of reach; `
        + "when that is known, a NOTE in this result or the one before it names which (it is said once, when the loss is seen). "
        + "Call computer.surfaces() and re-acquire what you need.");
    }
    await claim(h, false);
  };

  /** `stayed`: the driver was already on this target, so what it last observed (the previous
   *  call's closing observation) is of THIS surface. */
  const claim = async (h: SurfaceHandle, stayed: boolean): Promise<void> => {
    const { slice, inner } = owner.get(h)!;
    const driver = slice.driver;
    let resources = await driver.ownershipResources();
    const previous = leaseGroups.get(h);
    if ((!previous || previous !== resources[0]?.key) && !(await driver.isActiveTarget(inner))) {
      const rebound = await driver.focusTarget(inner);
      if (!rebound.ok) throw new SurfaceGone(`Surface ${h.id} disappeared while binding; list surfaces and re-acquire it.`);
      ledger().push("focus", h.id, true, noteOf(rebound) || `→ ${h.title}`);
      resources = await driver.ownershipResources();
      if (!(await driver.isActiveTarget(inner))) throw new Error("The target kept changing while binding; observe before continuing.");
    }
    const group = resources[0]?.key;
    if (!group) throw new Error("The driver did not identify a resource to claim.");
    // A handle that names an APP (macOS: a bundle id or a bare pid) claims the app while it has no
    // window, then the window it opens (exclusive) under the same app (shared). Both claims carry
    // the app's key, so the move is the same target and the lease moves with it; a claim that
    // shares no key with the last one (the app quit and came back under a new pid) is another.
    const moved = !!previous && previous !== group;
    if (moved && !resources.some((r) => leaseKeys.get(h)?.has(r.key))) {
      // The handle is spent: it must not be offered as "Still bound" in the same result.
      handles.delete(h.id);
      leaseGroups.delete(h);
      leaseKeys.delete(h);
      await ownership.release(previous);
      throw new Error("This handle now resolves to a different target. List surfaces and bind the intended one again.");
    }
    try { await ownership.claim(group, resources); }
    catch (e) {
      if (e instanceof OwnershipBusyError) ownershipRefusal = e.message;
      throw e;
    }
    if (moved) await ownership.release(previous);
    leaseGroups.set(h, group);
    leaseKeys.set(h, new Set(resources.map((r) => r.key)));
    // A first claim on a surface the driver just switched to starts from nothing. One it was
    // already on keeps the refs that surface handed out: a model that read them in the previous
    // call's closing observation (`computer.surfaces()`, say) and then binds the handle acts on
    // exactly those, and dispatch still checks each one against the live surface.
    if (!previous && !stayed) driver.invalidateObservation();
    await driver.prepareTarget();
  };

  /** The verbs that can start a surface from nothing (browser: a fresh tab). */
  const OPENERS = new Set(["openUrl", "newTab"]);

  /** True when `h` names no surface the session still has and its platform opens one from nothing:
   *  the handle's tab was closed by this session, or it is the stand-in from {@link emptyHandle}. */
  const opensFromNothing = async (h: SurfaceHandle): Promise<boolean> => {
    const { slice, inner } = owner.get(h)!;
    if (!(await slice.driver.heldNothing())) return false;
    if (!inner) return true;
    return !(await slice.driver.listTargets()).some((t) => t.id === inner);
  };

  /** After an opener started a fresh surface for `h`: point the handle at it (new id, title, lease),
   *  so the script keeps using the handle it holds and "Still bound" names the new tab. */
  const adopt = async (h: SurfaceHandle): Promise<void> => {
    const own = owner.get(h)!;
    const now = (await own.slice.driver.listTargets()).find((t) => t.active);
    if (!now) throw new Error("the tab was opened, but none is active afterwards — computer.surfaces() lists what is open");
    const previous = leaseGroups.get(h);
    if (previous) await ownership.release(previous);
    leaseGroups.delete(h);
    leaseKeys.delete(h);
    for (const [ref, id] of refOwner) if (id === h.id) refOwner.delete(ref);
    if (handles.get(h.id) === h) handles.delete(h.id);
    const id = prefixed ? `${own.slice.id}/${now.id}` : now.id;
    Object.assign(h, { id, kind: now.kind, title: now.title, active: true, own: now.own, mine: now.mine });
    owner.set(h, { slice: own.slice, inner: now.id });
    handles.set(id, h);
    landed = own.slice;
    lastBound = h;
    // `stayed`: the opener's own observation is of this tab, so its refs stay good.
    await claim(h, true);
  };

  /** What computer.surface() with no argument hands back when the session holds no surface of its
   *  own and its platform can open one: a stand-in whose openUrl / newTab opens it ({@link adopt}).
   *  Null when the session has a surface of its own, or nothing can be opened from nothing. */
  const emptyHandle = async (): Promise<SurfaceHandle | null> => {
    const ts = await allTargets();
    if (ts.some((t) => t.mine)) return null;
    for (const slice of scoped ? [scoped] : slices) {
      const why = await slice.driver.heldNothing();
      // "not-yet" beside tabs the session could bind (the user's, on the extension bridge) keeps
      // the old answer: bind one of them by name, or the refusal lists them.
      if (why === "closed" || (why === "not-yet" && !ts.length)) {
        return handleFor({ id: prefixed ? `${slice.id}/new` : "new", kind: "tab",
          title: "no tab open — openUrl({url}) or newTab({url}) on this handle opens one", active: false,
          own: true, mine: true, slice, inner: "" });
      }
    }
    return null;
  };

  /** The handle for a target: cached by id so `===` holds across calls, title refreshed. */
  const handleFor = (t: MountedTarget): SurfaceHandle => {
    const have = handles.get(t.id);
    // `own` is refreshed too: a tab dragged into the mirasim group becomes the session's mid-run.
    if (have) { have.title = t.title; have.kind = t.kind; have.active = t.active; have.own = t.own; have.mine = t.mine; have.unloaded = t.unloaded; return have; }
    // `own` rides the handle so a script deciding what to close can tell its surfaces from the
    // user's without asking the driver again.
    const h = { id: t.id, kind: t.kind, title: t.title, active: t.active, ...(t.own === undefined ? {} : { own: t.own }), ...(t.mine === undefined ? {} : { mine: t.mine }), ...(t.unloaded ? { unloaded: true } : {}) } as SurfaceHandle;
    owner.set(h, { slice: t.slice, inner: t.inner });
    const bound: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(t.slice.api)) {
      if (typeof fn !== "function" || name === "log" || name === "focus" || name === "targets") continue;
      bound[name] = async (...a: unknown[]) => {
        acting = h;
        try {
          // A session that closed its last tab (or holds none yet) opens a fresh one with openUrl /
          // newTab — on the handle it already has, or on the one computer.surface() hands back
          // then. Binding first would refuse: the handle's tab is gone and there is nothing to bind.
          if (OPENERS.has(name) && await opensFromNothing(h)) {
            // The pre-action lease check wants a group; a tab not opened yet has nothing to claim,
            // so the stand-in holds an empty one until adopt() claims the tab it opened.
            if (!leaseGroups.has(h)) leaseGroups.set(h, `opening:${h.id}`);
            const out = await (fn as (...x: unknown[]) => Promise<unknown>)(...a);
            await adopt(h);
            return out;
          }
          if (!owner.get(h)!.inner) {
            throw new Error(`${h.id} holds no tab yet — openUrl({url}) or newTab({url}) on it opens one; nothing else can act until then`);
          }
          try {
            await bind(h);
          } catch (e) {
            // A wait right after the action that CLOSED this surface (a panel's Cancel) is waiting
            // for what happened, so it answers instead of stopping the run. Every other verb still
            // refuses: acting on a gone window must never slide onto whatever the app shows instead.
            // It answers as a wait does, true or false, so `if (!await w.wait(…))` reads it right:
            // what was waiting to GO is gone with the surface; nothing else can appear on it.
            if (name === "wait" && e instanceof SurfaceGone) {
              const o = (a[0] && typeof a[0] === "object" ? a[0] : {}) as Record<string, unknown>;
              const gone = ["text_gone", "control_gone", "url_gone"].some((k) => typeof o[k] === "string");
              current?.push("wait", h.id, gone, `${h.id} is gone — closed or replaced, so `
                + (gone ? "what was waited on to go went with it" : "nothing can appear on it any more")
                + "; computer.surfaces() lists what remains");
              return gone;
            }
            if (e instanceof SurfaceGone && await owner.get(h)!.slice.driver.heldNothing()) {
              throw new SurfaceGone(`${e.message} This session holds no tab now: openUrl({url}) or newTab({url}) on this handle opens a fresh one.`);
            }
            throw e;
          }
          return await (fn as (...x: unknown[]) => Promise<unknown>)(...a);
        } finally { acting = null; }
      };
    }
    // Explicit `h.focus()` — bring the surface forward without acting on it.
    bound.focus = async () => { acting = h; try { await bind(h); } finally { acting = null; } };
    bound.release = async () => {
      ledger().charge("release");
      const group = leaseGroups.get(h);
      await t.slice.driver.releaseInputResources();
      if (group) await ownership.release(group);
      leaseGroups.delete(h);
      t.slice.driver.invalidateObservation();
      for (const [ref, id] of refOwner) if (id === h.id) refOwner.delete(ref);
      ledger().push("release", h.id, true, "ownership released; observe again before continuing");
      return "Ownership released. Other sessions may now use this target; observe before continuing.";
    };
    Object.assign(h, gate(bound));
    handles.set(t.id, h);
    return h;
  };

  /** {@link pickSurface} over this runtime's platforms: which surface the script named. */
  const pick = (ts: MountedTarget[], want: unknown): MountedTarget => pickSurface(ts, want,
    // A filtered list cannot explain its own gaps — @see ComputerUseDriver.explainMiss
    (q) => [...new Set(slices.map((sl) => sl.driver.explainMiss(q)).filter(Boolean))].join("\n"));

  /**
   * The host's `target` rides EVERY call and usually names an app. When that app has several
   * windows and no single primary (Finder's transient rename window), {@link pick} refuses; if this
   * session is already on one of the matches, staying there is no guess and the run proceeds.
   */
  const resolveHostTarget = async (want: string): Promise<MountedTarget> => {
    try {
      return await resolve(want);
    } catch (e) {
      const lower = want.toLowerCase();
      const here = (await allTargets()).filter((t) => t.active && (t.id === want || t.title.toLowerCase().includes(lower)));
      if (here.length === 1) return here[0]!;
      throw e;
    }
  };

  /**
   * {@link pick}, plus the one name a listing cannot carry: a surface only its platform can
   * resolve from the name itself (a macOS app that is installed but neither running nor cleared —
   * ComputerUseDriver.unlistedTarget). Asked only when nothing listed matched, and only with a name.
   */
  const resolve = async (want: unknown): Promise<MountedTarget> => {
    const ts = await allTargets();
    const q = want === undefined ? "" : String(want).trim();
    if (q && !ts.some((t) => t.id === q || t.title.toLowerCase().includes(q.toLowerCase()))) {
      for (const slice of scoped ? [scoped] : slices) {
        const t = await slice.driver.unlistedTarget(q);
        if (t) return { ...t, id: prefixed ? `${slice.id}/${t.id}` : t.id, slice, inner: t.id };
      }
    }
    return pick(ts, want);
  };

  const computer = gate({
    surfaces: async () => {
      ledger().charge("targets");
      const ts = await allTargets();
      ledger().push("targets", "", true, `${ts.length} surfaces`);
      return ts.map(handleFor);
    },
    // No argument in a call whose host named the surface: that surface, already bound. The caller
    // said which one this call is about, so it is not a guess among the open ones, and refusing
    // here ("10 surfaces are open — name one") costs a round trip to repeat what the call carried.
    surface: async (want?: unknown) => (want === undefined && hostBound && handles.get(hostBound.id) === hostBound ? hostBound : null)
      ?? (want === undefined ? await emptyHandle() : null) ?? handleFor(await resolve(want)),
    // Touches no surface, which is why it is the one member that never belonged on a handle.
    log: raw.log,
    help: () => requestedHelp = slices.map((sl) => apiReference(sl.driver, windowsApps)).join("\n\n"),
  });

  /**
   * The one error worth rewording: a top-level verb call gets `click is not defined`, which reads
   * as GONE rather than "lives on a surface handle". Only this driver's verb names are reworded,
   * so a genuine typo still reads as one.
   */
  const verbNames = new Set(Object.keys(raw));
  /** The verbs a handle of `slice` carries (handleFor), and the schemas of its platform verbs. */
  const verbsOf = (slice: Slice): string[] => [...Object.keys(slice.api)
    .filter((k) => typeof slice.api[k] === "function" && !["log", "focus", "targets"].includes(k)), "focus", "release"];
  const schemasOf = (slice: Slice) => new Map(slice.driver.extraVerbs().map((v) => [fnName(v.kind), v.schema]));
  /**
   * `w.goto is not a function`: a verb name the script brought from another library. Reworded
   * only when the receiver is a surface handle or `computer` itself, read off the runtime's
   * globals: a script's own object missing a method is the script's business.
   */
  const notAFunction = (msg: string): string | null => {
    const m = /^TypeError: ([A-Za-z_$][\w$]*)\.([\w$]+) is not a function$/.exec(msg);
    if (!m || !sandbox || !Object.prototype.hasOwnProperty.call(sandbox, m[1]!)) return null;
    const [, receiver, name] = m as unknown as [string, string, string];
    const held = (sandbox as Record<string, unknown>)[receiver];
    if (held === computer) {
      return `${msg} — ${onComputer(name, Object.keys(computer).filter((k) => typeof (computer as Record<string, unknown>)[k] === "function"),
        verbsOf(landed), schemasOf(landed))}`;
    }
    const own = held && typeof held === "object" ? owner.get(held as SurfaceHandle) : undefined;
    if (!own) return null;
    const h = held as SurfaceHandle;
    // A read the platform does not have is still a member (it refuses when called): not offered.
    const missing = new Set([...(own.slice.driver.readPage ? [] : ["page"]), ...(own.slice.driver.readValue ? [] : ["value"])]);
    const members = Object.keys(h).filter((k) => typeof h[k] === "function" && !missing.has(k));
    const props = Object.keys(h).filter((k) => typeof h[k] !== "function");
    return `${msg} — ${onHandle(receiver, name, members, props, schemasOf(own.slice))}`;
  };
  /** Why the runtime the call in progress runs in is fresh, when this runtime knows: a reset it
   *  was asked for, or the previous call ended from outside. Null otherwise (a first call, or a
   *  host that respawned the process: then nobody here knows). */
  let freshBecause: "reset" | "ended" | null = null;
  const explain = (msg: string, fresh: boolean, because: "reset" | "ended" | null): string => {
    const invented = notAFunction(msg);
    if (invented) return invented;
    if (/^TypeError: A dynamic import callback was not specified\.?$/.test(msg)) return NO_IMPORT;
    const m = /^(?:ReferenceError: )?(\w+) is not defined$/.exec(msg);
    if (!m) return msg;
    const host = sandboxGlobal(m[1]!);
    if (host) return `${msg} — ${host}`;
    if (verbNames.has(m[1]!)) {
      return `${msg} — verbs live on a surface handle, not on the top level: `
        + `const w = await computer.surface('<id or title>'); await w.${m[1]}(…). `
        + "computer.surface() with no argument binds the surface this call's host named, else the only surface, or the one this session opened among several; computer.surfaces() lists them.";
    }
    // Any other undefined name is usually a handle the code expected to hold: nothing binds one
    // implicitly, and a restarted runtime has lost earlier bindings.
    return `${msg} — `
      + (fresh && because === "reset"
        ? "computer_repl_reset discarded every binding from earlier calls, so this call started a FRESH runtime (no surface was touched). "
        : fresh && because === "ended"
        ? "the previous call was ended from outside, which discards every binding, so this call started a FRESH runtime. "
        : fresh
        ? "this call started a FRESH runtime, so nothing declared in an earlier call survives (the server was restarted, or its host reaped it while idle). "
        : "no call on this runtime declared it at the top level, and nothing is predefined but computer, URL and URLSearchParams. ")
      + "If it is a surface handle, bind it: const w = await computer.surface('<id or title>').";
  };

  // `createContext` starts from a bare V8 global: no require / process / fetch / setTimeout, and
  // no top-level verbs (every verb is reached through a surface handle). URL and URLSearchParams
  // are not V8's, and scripts reach for them to check a page's address (`new URL(u).search`):
  // they only parse strings, so they are handed in.
  // `console` is V8's own in a fresh context, and writes where nobody reads: each method refuses
  // instead, naming computer.log.
  const freshSandbox = () => createContext({ computer, console: sandboxConsole(), URL, URLSearchParams });
  /** Top-level names in the runtime that hold a surface handle, as `name → id «title»`. A handle
   *  is recognised by identity (`owner`), never by shape: a script's own `{ id, title }` is not one. */
  const boundHandles = (ctx: object): string[] =>
    Object.entries(ctx).flatMap(([name, value]) =>
      // A handle dropped from `handles` is gone or spent (bind, claim): not one to keep using.
      value && typeof value === "object" && owner.has(value as SurfaceHandle) && handles.get((value as SurfaceHandle).id) === value
        ? [`${name} → ${(value as SurfaceHandle).id} «${(value as SurfaceHandle).title}»`]
        : []);

  const repl = spec({
    name: "computer_repl",
    description: replDescription(windowsApps),
    parameters: Type.Object({
      code: Type.String({
        description: "JavaScript, run as the body of an async function in the persistent runtime. `await` every verb; "
          // Models copy this example into EVERY call, so it shows bind-once and a later call that
          // just uses `w` apart; otherwise calls keep re-binding an intact handle.
          + "`return` what you want back. Bind once — first call: `const w = await computer.surface();` — "
          // A URL in the task reads as something to bind; models passed it to surface() and missed.
          + "binding opens nothing (a browser page is opened with `await w.openUrl({url})` once bound), "
          + "then later calls use `w` directly: `for (const e of (await w.observe()).elements.filter(e => e.role === 'checkbox')) await w.click(e.ref);`",
      }),
      purpose: Type.Optional(Type.String({ maxLength: 500,
        description: "Briefly describe the intended task when requesting app access. Shown to the user as the agent's stated purpose; it does not narrow the app permission. Do not include secrets.",
      })),
      interaction: Type.Optional(Type.Union([Type.Literal("background"), Type.Literal("desktop")], {
        description: "Native apps default to background — macOS: driver mouse/activation/clipboard routes are blocked, including fallback"
          + (windowsApps ? "; Windows: limited UIA setText/click/scroll by ref, with automatic focus and real-input fallback disabled; unsupported routes are refused. " : ". ")
          + "Use desktop only after explaining effects and obtaining permission covering this call. This option is not user consent.",
      })),
      platform: Type.Optional(Type.String({
        description: "For a HOST that mounts several platforms in one session: the platform this call is about "
          + `("browser", "electron", "macos"${windowsApps ? ', "windows"' : ""}). computer.surfaces() and computer.surface() then see only its surfaces, and the `
          + "observation is of it; the other platforms stay mounted and untouched.",
      })),
      target: Type.Optional(Type.String({
        description: "Bind this surface before the code runs — the same string computer.surface() takes (an id, a whole "
          + "title, or a piece of one). For a HOST that decides which surface a call is about: the code can still "
          + "bind whatever it likes; this settles where a run that binds nothing lands, and what computer.surface() "
          + "with no argument returns in this call.",
      })),
      observation: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("brief"), Type.Literal("none")], {
        description: "How much of the end-of-run observation to render. \"full\" (default) is the element list and the text "
          + "excerpt; \"brief\" keeps the head (title, targets, verdict) and drops the listing; \"none\" leaves only the action "
          + "journal. The observation is always TAKEN either way — the change verdict and the stale-ref bookkeeping are "
          + "unaffected — and a NOTE line always survives, so a swallowed click is never hidden by this. Reach for it when "
          + "the window holds content you do not want in the transcript, or when your own `return` value is the answer.",
      })),
    }),
    async execute(params, call) {
      ownershipRefusal = null;
      requestedHelp = null;
      hostBound = null;
      const src = String((params as { code?: unknown }).code ?? "");
      if (!src.trim()) return text("computer_repl needs code to run.", { error: "bad_args" });
      const platform = String((params as { platform?: unknown }).platform ?? "").trim();
      scoped = platform ? slices.find((sl) => sl.id === platform) ?? null : null;
      if (platform && !scoped) {
        return text(`platform ${JSON.stringify(platform)} is not mounted in this session (mounted: ${slices.map((sl) => sl.id).join(", ")}).`, { error: "bad_args" });
      }
      if (scoped) landed = scoped;
      const purpose = (params as { purpose?: unknown }).purpose;
      for (const sl of slices) {
        sl.driver.interactionMode = (params as { interaction?: unknown }).interaction === "desktop" ? "desktop" : "background";
        sl.driver.consentPurpose = typeof purpose === "string" ? purpose.trim().slice(0, 500) || null : null;
        sl.driver.permissionRefusal = null;
      }
      const show = (params as { observation?: unknown }).observation;
      const render: Render = show === "brief" || show === "none" ? show : "full";

      const journal: JournalLine[] = [];
      const images: ToolResult["content"] = [];
      const started = Date.now();
      // The time cap excludes time spent waiting on the USER (a consent prompt).
      const waited = () => slices.reduce((ms, sl) => ms + sl.driver.waitedOnUserMs
        + (sl.driver.awaitingUserSince === null ? 0 : Date.now() - sl.driver.awaitingUserSince), 0);
      /** How long the call has run, the time a question stood open to the user left out. */
      const active = () => Date.now() - started - (waited() - waitedBefore);
      /** Say it once: code that catches a cap and calls on is not answered again (@see verbGate). */
      const stop = (why: string): never => { capped = why; throw new Error(why); };
      const waitedBefore = waited();
      let actions = 0;
      let acted: string | null = null; // the last verb the run dispatched, or null for a pure look
      let refused = false; // a verb was attempted and failed — the run was not a look either
      let stepStart: number | null = null; // the open step's first charge (a verb can charge twice)
      const round: WriteRound = { fields: 0, verified: 0, ended: null };
      /** Set when the client cancels this call (@see onCancel below). */
      let cancelled = false;
      current = {
        round,
        charge(kind) {
          stepStart ??= Date.now();
          if (resetPending) stop("The runtime was reset; this run stops before its next operation.");
          if (cancelled) stop(CANCELLED);
          if (++actions > MAX_ACTIONS) stop(`step cap reached (${MAX_ACTIONS} actions) at ${kind} — split the work across calls, or narrow the loop`);
          if (active() > maxMs) stop(`time cap reached (${maxMs / 1000}s) at ${kind} — the surface may be slower than the code assumes`);
        },
        push(kind, target, ok, note, read, outcome) {
          if (!read && ok && !READ_KINDS.has(kind) && !OFF_SURFACE_KINDS.has(kind)) acted = kind;
          if (!read && !ok && !READ_KINDS.has(kind)) refused = true;
          const ms = stepStart === null ? undefined : Date.now() - stepStart;
          stepStart = null;
          journal.push({ i: journal.length + 1, kind, target, ok, note, ...(outcome ? { outcome } : {}), ...(ms !== undefined ? { ms } : {}) });
        },
        attach(part) { images.push(part); },
        remainingMs: () => maxMs - active(),
      };
      const fresh = !sandbox;
      sandbox ??= freshSandbox();
      // Said about this call only: the one after it is not fresh, or is fresh for another reason.
      const because = freshBecause;
      freshBecause = null;
      const callId = {};

      let returned: unknown;
      let failure: string | null = null;
      // ── Ending the call from outside ──────────────────────────────────────────────────────
      // The caps above are read when a verb STARTS. Nothing there ends a verb that does not come
      // back, or code waiting on a promise nothing settles, and until this call ends every later
      // one queues behind it, a turn cannot end and the server cannot shut down. So the call is
      // also watched from here, and can be told to end: by the watchdog, by code that calls on
      // past a cap, by the host ending the turn (computer_repl_reset `abandonAfterMs`), by the
      // client cancelling a call that then does not come back.
      running = callId;
      capped = null;
      const ended: { why: string | null } = { why: null };
      let endNow!: () => void;
      const endedFromOutside = new Promise<void>((resolve) => { endNow = resolve; });
      const ENDED = Symbol("ended");
      outside.end = (why) => { if (ended.why === null) { ended.why = why; endNow(); } };
      const watchdog = setInterval(() => {
        if (active() <= maxMs + stuckGraceMs) return;
        const verb = gate.running();
        const at = `${Math.round(active() / 1000)}s into the call`;
        outside.end?.(verb
          ? `${verb} had not come back ${at}, so the call was ended and the connection to the surface dropped — nothing else `
            + `stops a verb the surface never answers. What ${verb} did is unknown: bind the surface again and observe before repeating anything`
          : `the code was still waiting ${at} on something that is not a verb (a promise nothing settles), so the call was ended`);
      }, Math.max(50, Math.min(1000, Math.round(stuckGraceMs / 4))));
      watchdog.unref?.();
      // ── The client cancelled the call ─────────────────────────────────────────────────────
      // Nobody reads its answer any more, and until it ends the next call queues behind it: a
      // 30 s wait the user stopped held their next message for the rest of those 30 s. It is not
      // cut off at once, though. A verb already out is given `cancelGraceMs` to finish, and the
      // code is stopped at its next verb: that way the runtime, its bindings and the connection
      // all survive. Only a call still out after that is ended from outside.
      let cancelTimer: NodeJS.Timeout | undefined;
      const onCancel = () => {
        cancelled = true;
        cancelTimer = setTimeout(() => outside.end?.(`${CANCELLED_HEAD}, and ${gate.running() ?? "the code"} had not come back `
          + `${Math.round(cancelGraceMs / 100) / 10}s later, so the call was ended`
          + (gate.running() ? " and the connection to the surface dropped. What that verb did is unknown: bind the surface again and observe before repeating anything" : "")),
        cancelGraceMs);
        cancelTimer.unref?.();
      };
      const signal = call?.signal;
      if (signal?.aborted) onCancel();
      else signal?.addEventListener("abort", onCancel, { once: true });
      const body = calls.run(callId, async () => {
        let out: unknown, error: unknown, failed = false, left: unknown, leftFailed = false;
        try {
          // A host's `target` is bound through the same pick and `bind` the code would use, so a run
          // that binds nothing lands where the CALLER meant.
          const want = String((params as { target?: unknown }).target ?? "").trim();
          if (want) {
            const named = handleFor(await resolveHostTarget(want));
            await bind(named);
            hostBound = named;
          }
          out = await runInContext(prepareCode(src), sandbox!, { filename: "computer_repl", timeout: SYNC_MAX_MS });
        } catch (e) { error = e; failed = true; }
        // A verb the code did not await finishes inside its own call. Its failure is said, but
        // takes neither the code's own failure nor what the code returned.
        try { await gate.drain(); }
        catch (e) { left = e; leftFailed = true; }
        if (failed) throw error;
        return { out, left, leftFailed };
      });
      body.catch(() => {});
      try {
        const done = await Promise.race([body, endedFromOutside.then((): never => { throw ENDED; })]);
        returned = done.out;
        if (done.leftFailed) failure = explain(done.left instanceof Error ? done.left.message : String(done.left), fresh, because);
      } catch (e) {
        if (e === ENDED) failure = ended.why;
        else {
          if ((e as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
            e = new Error(`the code ran for ${SYNC_MAX_MS / 1000}s without awaiting anything and was stopped — `
              + "a loop that never awaits blocks the whole runtime; await a verb (or w.wait) inside it");
          }
          failure = explain(e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : String(e), fresh, because);
        }
      } finally {
        clearInterval(watchdog);
        clearTimeout(cancelTimer);
        signal?.removeEventListener("abort", onCancel);
        outside.end = null;
        // From here on this call's code is nobody's: a verb it calls is never answered.
        running = null;
        if (ended.why !== null) {
          if (gate.running()) {
            // A verb is still out. What it waits on is its surface's connection, so that goes:
            // the tidy close asks the surface things, which is how the verb got stuck.
            await Promise.all(slices.map((sl) => sl.driver.abandon().catch(() => {})));
            await Promise.race([gate.drain().catch(() => {}), new Promise((r) => setTimeout(r, ABANDON_DRAIN_MS))]);
            gate.forget();
          }
          // The code is suspended wherever it was, its bindings half made: the next call starts over.
          sandbox = null;
          freshBecause ??= "ended";
          lastBound = null;
          handles.clear();
          refOwner.clear();
        }
        current = null;
      }

      const runMs = Date.now() - started;
      const elapsed = (runMs / 1000).toFixed(1);
      // Where the call's time went, step by step, for the COMPUTER_USE_MCP_LOG file only: `details`
      // never reaches the model (entries/mcp.ts), so this costs it no context. `observeMs` is the
      // closing observation, the settle re-check included.
      const timing = (observeMs?: number) => ({
        runMs, ...(observeMs !== undefined ? { observeMs } : {}),
        steps: journal.map((l) => ({ kind: l.kind, target: l.target, ok: l.ok, ...(l.outcome ? { outcome: l.outcome } : {}),
          ...(l.ms !== undefined ? { ms: l.ms } : {}), note: l.note.slice(0, 160) })),
      });
      const head = failure
        ? `Run STOPPED after ${journal.length} steps (${elapsed}s): ${failure}`
        : `Run completed ${journal.length} steps in ${elapsed}s.`;
      const lines = [head, ...renderJournal(journal)];
      // An argument the tool does not take is dropped, and the code runs without it: say so, or
      // a `url` passed beside the code reads as a page that was opened.
      const ignored = Object.keys((params ?? {}) as object).filter((k) => !REPL_ARGS.has(k));
      if (ignored.length) {
        lines.push(`NOTE: computer_repl ignored the argument${ignored.length > 1 ? "s" : ""} ${ignored.join(", ")} — it reads only `
          + `${[...REPL_ARGS].join(", ")}; the code ran without ${ignored.length > 1 ? "them" : "it"}.`
          + (ignored.includes("url") ? " A page is opened in the code: await w.openUrl({url: \"…\"})." : ""));
      }
      /** A result that is the ledger alone, with no observation under it: `tail` goes after the
       *  ledger's lines without counting as one, `attach` after the text. */
      const ledgerOnly = (attach: ToolResult["content"], tail = "", extra: Record<string, unknown> = {}): ToolResult => {
        const r = text(`${lines.join("\n")}${tail}`, { verdict: "unknown", ledgerLines: lines.length, timing: timing(),
          ...(failure ? { error: "run_stopped" } : {}), ...extra });
        r.content.push(...attach);
        return r;
      };
      // A call ended from outside is not observed: its surface is the one that stopped answering
      // (or was just let go of), and its runtime is gone, so there is nothing still bound to name.
      if (ended.why !== null) {
        lines.push("The next call starts a fresh runtime: nothing declared so far survives, and every surface is bound again from computer.surface().");
        return ledgerOnly(images, "", { error: "run_stopped", ended: true });
      }
      // A throw ends the call before `return`; say here what survives a stop.
      if (failure && journal.length > 0) {
        lines.push("Nothing was returned: the throw ended the call before `return`. What survives a stop — "
          + "top-level bindings (read them in your next call) and anything already passed to log() (in the journal above).");
      }
      // After a stop the next call tends to re-bind; name the handles that still hold.
      if (failure) {
        // A handle's title is the one it had when bound; the page has usually moved on since
        // (a click, a navigation), and the line would name the tab by a title it no longer has.
        for (const t of await allTargets().catch((): MountedTarget[] => [])) {
          const h = handles.get(t.id);
          if (h) h.title = t.title;
        }
        const held = sandbox ? boundHandles(sandbox) : [];
        if (held.length) lines.push(`Still bound: ${held.join(", ")} — use ${held.length === 1 ? "it" : "them"} directly in the next call.`);
      }
      if (returned !== undefined) {
        const body = stringify(returned);
        lines.push(`Returned: ${body.length > RETURN_CAP && returned !== requestedHelp
          ? `${cutText(body, RETURN_CAP)}… (cut at ${RETURN_CAP} of ${body.length} chars — return a slice, a count or a filtered list instead of the whole thing)`
          : body}`);
      }
      // Nobody reads a cancelled call's answer, so nothing owed to the reader is spent on it.
      const unread = cancelled || !!signal?.aborted;
      // The reference is owed once per PLATFORM, delivered when the session first reaches it.
      const docs = unread ? [] : slices.filter((sl) => sl.docsDue && (sl === landed || slices.length === 1))
        .map((sl) => {
          sl.docsDue = false;
          // The FIRST platform carries the whole reference; a later one only its own part.
          const whole = !coreSent;
          coreSent = true;
          const body = whole ? apiReference(sl.driver, windowsApps) : platformReference(sl.driver, windowsApps);
          return { type: "text" as const, text: `\n${body}`, pinned: true as const };
        });
      if (respawnNoteDue && !unread) {
        respawnNoteDue = false;
        docs.push({ type: "text" as const, text: "\nThis computer_repl runtime was restarted (idle), so top-level bindings and refs "
          + "from before are gone; the API reference you already have still applies — computer.help() returns it again.", pinned: true as const });
      }
      // The one observation, of the active surface, diffed against before the run. A run that
      // only READ carries no `afterAction`: a frozen screen after a look is not "no effect".
      // `ledgerLines` = leading lines that are the ledger (kept when trimmed, repl-budget.ts).
      // An acting run is one ROUND to the driver (writes + read-backs), so a frozen verdict after
      // a verified write does not accuse it; the last verb names the observation.
      if (acted) landed.driver.noteWriteRound(round);
      // A run whose only verb was refused did not look either, nor did one that stopped before
      // dispatching anything (a TypeError, a bad option): no look wording under the refusal, and
      // it does not count toward "observations in a row without acting".
      else if (refused || failure) landed.driver.noteContentRead();
      const after = acted ? { afterAction: acted } : {};
      const permissionRefusal = slices.find(sl => sl.driver.permissionRefusal)?.driver.permissionRefusal;
      if (requestedHelp && journal.length === 0) return ledgerOnly(docs);
      // Reading the surface for an answer nobody reads only keeps the next call waiting.
      if (unread) {
        lines.push("Observation skipped: the client cancelled this call.");
        return ledgerOnly(images, "", { cancelled: true });
      }
      if (permissionRefusal || ownershipRefusal) {
        // Binding can be denied before an app becomes active. Observing afterwards would
        // either ask again, read the previous app, or misreport "no app was named".
        const refusal = permissionRefusal || ownershipRefusal!;
        if (!failure?.includes(refusal)) lines.push(`Observation skipped: ${refusal}`);
        return ledgerOnly([...images, ...docs], "", permissionRefusal ? { permissionRefused: true } : { ownershipRefused: true });
      }
      try {
        // The run left the driver on ANOTHER surface while the handle it last bound is still good:
        // a tab newTab or a click opened, or one surface(id) named. Nothing was lost, and saying
        // "released, closed or replaced … bind again" sent models re-binding an intact handle.
        // The observation is not taken of either tab: switching back to read would move the
        // session again, and reading the new one would hand out refs no bound handle owns.
        if (!resetPending && lastBound && leaseGroups.has(lastBound) && handles.get(lastBound.id) === lastBound
            && !(await landed.driver.isActiveTarget(owner.get(lastBound)!.inner))) {
          const listed = await allTargets().catch((): MountedTarget[] => []);
          const mine = listed.find((t) => t.id === lastBound!.id);
          const now = listed.find((t) => t.active && t.slice === landed);
          if (mine && now) {
            const note = landed.driver.takeNoteForResult();
            return ledgerOnly([...images, ...docs], `${note ? `\nNOTE: ${note}.` : ""}\nObservation skipped: the session is now on `
              + `${now.id} «${now.title}», which this run opened or named; the handle for ${mine.id} «${mine.title}» is still bound `
              + `and its next verb works there. computer.surface('${now.id}') binds ${now.id}, and observe() on either reads it.`);
          }
        }
        if (resetPending || (lastBound && (!leaseGroups.has(lastBound)
            || !(await landed.driver.isActiveTarget(owner.get(lastBound)!.inner))))) {
          const note = landed.driver.takeNoteForResult();
          return ledgerOnly([...images, ...docs], `${note ? `\nNOTE: ${note}.` : ""}\nObservation skipped: the bound target was `
            + "released, closed or replaced. List surfaces and bind the intended target before continuing.");
        }
        const observeStarted = Date.now();
        const obs = await landed.driver.observeElements({ prefix: lines.join("\n"), ...after });
        obs.details.ledgerLines = lines.length;
        obs.details.timing = timing(Date.now() - observeStarted);
        trimObservation(obs, render);
        obs.content.push(...images, ...docs);
        // Flag a stopped run so a host reading only `isError` branches right; the journal and
        // observation are still the result.
        if (failure) obs.details.error = "run_stopped";
        return obs;
      } catch (e) {
        if ((e as { surfaceGone?: boolean }).surfaceGone) throw e;
        // The run usually stopped for the same reason the re-read fails: say it once.
        const why = (e as Error).message;
        const again = failure && failure.includes(why) ? "for the same reason" : `${why} — observe again before the next action`;
        return ledgerOnly([...images, ...docs], `\n(re-observation failed: ${again}.)`);
      }
    },
  });
  /** The arguments computer_repl reads; any other is reported as ignored (@see execute). */
  const REPL_ARGS = new Set(Object.keys((repl.parameters as { properties?: Record<string, unknown> }).properties ?? {}));
  // What was granted for one call alone (ComputerUseDriver.endCall) ends with it, however the call ends.
  const runCall = repl.execute.bind(repl);
  const disarmIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };
  /** Everything a reset gives up: held input first, then every claim. A driver that cannot
   *  bring its input up (its helper is gone, a grant was withdrawn) no longer keeps the claims:
   *  the session is over either way, and a claim held by a reset runtime made every other
   *  session's bind of that window "in use" until this process exited. */
  const releaseForReset = async (): Promise<void> => {
    for (const sl of slices) await sl.driver.releaseInputResources().catch(() => {});
    await ownership.releaseAll();
  };
  /** Claims only: handles, bindings and refs stay, and the next bind claims its target again
   *  (`claim` runs on every bind) or is refused because another runtime took it meanwhile. */
  const releaseIdle = () => {
    idleTimer = null;
    if (callRunning) return;
    idleReleasing = (async () => {
      try {
        // A pointer still held down must come up first; one that cannot keeps every claim.
        for (const sl of slices) await sl.driver.releaseInputResources();
        await ownership.releaseAll();
        // After the claims, never instead of them: a tab bound for the task goes back to its
        // owner while nothing drives it, and the next bind takes it again.
        for (const sl of slices) await sl.driver.releaseIdle().catch(() => {});
      } catch { /* kept, as if no time had passed */ }
    })().finally(() => { idleReleasing = null; });
  };
  repl.execute = async (params, call) => {
    disarmIdle();
    if (idleReleasing) await idleReleasing;
    callRunning = true;
    let finish!: () => void;
    callFinished = new Promise<void>(resolve => { finish = resolve; });
    try {
      return await runCall(params, call);
    } finally {
      try {
        if (resetPending) {
          await releaseForReset();
          resetPending = false;
        }
        scoped = null;
        for (const sl of slices) {
          sl.driver.endCall();
          sl.driver.consentPurpose = null;
          sl.driver.permissionRefusal = null;
        }
      } finally {
        callRunning = false;
        finish();
        disarmIdle();
        idleTimer = setTimeout(releaseIdle, idleReleaseMs);
        idleTimer.unref?.();
      }
    }
  };

  const reset = spec({
    name: "computer_repl_reset",
    description: RESET_DESCRIPTION,
    parameters: Type.Object({}),
    async execute(params) {
      const draining = callFinished;
      disarmIdle();
      // A host that cannot wait for a call to finish (a turn ending, the server shutting down)
      // says how long it will: past that the call is ended from here (@see execute).
      const abandonAfterMs = (params as { abandonAfterMs?: unknown } | undefined)?.abandonAfterMs;
      const abandon = callRunning && typeof abandonAfterMs === "number"
        ? setTimeout(() => outside.end?.("the host ended the turn while this call was still running, so the call was ended"), abandonAfterMs)
        : undefined;
      if (callRunning) resetPending = true;
      else await releaseForReset();
      sandbox = null;
      freshBecause = "reset";
      lastBound = null;
      handles.clear();
      refOwner.clear();
      for (const sl of slices) sl.docsDue = true;
      coreSent = false;
      respawnNoteDue = false;
      if ((params as { waitForIdle?: boolean } | undefined)?.waitForIdle) await draining;
      clearTimeout(abandon);
      return text("The JavaScript runtime was reset: every binding is gone. The next computer_repl call starts fresh and "
        + "returns the API reference. No surface was touched — tabs, windows and apps are as they were.", { reset: true });
    },
  });

  return [repl, reset];
}
