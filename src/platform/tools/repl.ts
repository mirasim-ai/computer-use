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

import { createContext, runInContext, type Context } from "node:vm";
import { Type } from "typebox";
import { spec, text, type ComputerUseToolSpec, type TargetInfo, type ToolResult } from "../types.ts";
import { MAX_ACTIONS, MAX_MS, SYNC_MAX_MS, RETURN_CAP, MAX_REF_OWNERS, trimObservation, type Render } from "./repl-budget.ts";
import { createComputerUseApi, noteOf, renderJournal, stringify, verbGate, type JournalLine, type RunLedger, type WriteRound } from "./api.ts";
import { prepareCode } from "./repl-code.ts";
import { apiReference, platformReference, REPL_DESCRIPTION, RESET_DESCRIPTION } from "./repl-docs.ts";
import { ComputerUseOwnership, OwnershipBusyError, type OwnershipProvider } from "../ownership.ts";
import type { MountedTarget, PlatformSlice, Slice, SurfaceHandle } from "./repl-state.ts";

export type { PlatformSlice } from "./repl-state.ts";

/** Journal kinds that touch nothing — a run made only of these is a look, not an action. */
const READ_KINDS = new Set(["observe", "find", "text", "value", "page", "screenshot", "diagnostics", "targets", "log", "verb", "release"]);
/** Verbs whose effect is not on the observed surface (an answer for a LATER dialog, a tab closed
 *  beside this one): a frozen screen after them is not "no effect". */
const OFF_SURFACE_KINDS = new Set(["dialog", "close_tab"]);

export function createReplTools(mounted: PlatformSlice[], opts: { docsDelivered?: boolean; ownership?: OwnershipProvider } = {}): ComputerUseToolSpec[] {
  if (!mounted.length) throw new Error("createReplTools needs at least one platform");
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

  const gate = verbGate((note) => current?.push("verb", "", false, note));
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
          try {
            await bind(h);
          } catch (e) {
            // A wait right after the action that CLOSED this surface (a panel's Cancel) is waiting
            // for what happened, so it answers instead of stopping the run. Every other verb still
            // refuses: acting on a gone window must never slide onto whatever the app shows instead.
            if (name === "wait" && e instanceof SurfaceGone) {
              return `${h.id} is gone — closed or replaced, so there is nothing left on it to wait for. `
                + "computer.surfaces() lists what remains";
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

  /**
   * Which surface the script named, or a refusal that lists the candidates — never a guess.
   *
   * Tried in order: the opaque `id`, the whole title, a piece of the title. The title carries the
   * human names (macOS: "TextEdit (com.apple.TextEdit) — Untitled"), hence ONE entry point and no
   * per-platform app()/tab(). NO ARGUMENT is not "the one in front of the user": it binds the only
   * surface, else the one THIS runtime opened or claimed (TargetInfo.mine) — the one it is on when
   * it has several. Tabs an earlier session left in a shared browser, and the user's, are never
   * the default; with no surface of its own among several the call is refused.
   */
  const pick = (ts: MountedTarget[], want: unknown): MountedTarget => {
    // This session's own surfaces first and marked, so they stand out among the user's tabs and
    // the ones an earlier session left behind.
    const mark = (t: TargetInfo) => t.mine ? "  (yours — opened by this session)"
      : t.own && t.mine === false ? "  (left open by an earlier session)" : "";
    const rank = (t: TargetInfo) => (t.mine ? 0 : t.own ? 1 : 2);
    const lines = (rows: TargetInfo[]) => [...rows].sort((a, b) => rank(a) - rank(b))
      .map((t) => `  ${t.id}  ${t.title}${mark(t)}`).join("\n");
    if (!ts.length) throw new Error("this driver has no surface right now");
    if (want === undefined) {
      if (ts.length === 1) return ts[0]!;
      const mine = ts.filter((t) => t.mine);
      const here = mine.filter((t) => t.active);
      if (here.length === 1) return here[0]!;
      if (mine.length === 1) return mine[0]!;
      throw new Error(`${ts.length} surfaces are open — name one, computer.surface('<id or title>'):\n${lines(ts)}`);
    }
    const q = String(want).trim();
    const byId = ts.filter((t) => t.id === q);
    if (byId.length === 1) return byId[0]!;
    const lower = q.toLowerCase();
    const exact = ts.filter((t) => t.title.toLowerCase() === lower);
    const hits = exact.length ? exact : ts.filter((t) => t.title.toLowerCase().includes(lower));
    if (hits.length === 1) return hits[0]!;
    // An APP with two windows is not an ambiguous NAME: the app says which window is in front
    // (TargetInfo.primary). Only when exactly one match claims it.
    const primaries = hits.filter((t) => t.primary);
    if (primaries.length === 1) return primaries[0]!;
    if (!hits.length) {
      // A filtered list cannot explain its own gaps — @see ComputerUseDriver.explainMiss
      const why = [...new Set(slices.map((sl) => sl.driver.explainMiss(q)).filter(Boolean))].join("\n");
      throw new Error(`no surface matches ${JSON.stringify(q)} — the open ones are:\n${lines(ts)}${why ? `\n${why}` : ""}`);
    }
    throw new Error(`${hits.length} surfaces match ${JSON.stringify(q)} — name one exactly:\n${lines(hits)}`);
  };

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
    surface: async (want?: unknown) => handleFor(await resolve(want)),
    // Touches no surface, which is why it is the one member that never belonged on a handle.
    log: raw.log,
    help: () => requestedHelp = slices.map((sl) => apiReference(sl.driver)).join("\n\n"),
  });

  /**
   * The one error worth rewording: a top-level verb call gets `click is not defined`, which reads
   * as GONE rather than "lives on a surface handle". Only this driver's verb names are reworded,
   * so a genuine typo still reads as one.
   */
  const verbNames = new Set(Object.keys(raw));
  const explain = (msg: string, fresh: boolean): string => {
    const m = /^(?:ReferenceError: )?(\w+) is not defined$/.exec(msg);
    if (!m) return msg;
    if (verbNames.has(m[1]!)) {
      return `${msg} — verbs live on a surface handle, not on the top level: `
        + `const w = await computer.surface('<id or title>'); await w.${m[1]}(…). `
        + "computer.surface() with no argument binds the only surface, or the one this session opened among several; computer.surfaces() lists them.";
    }
    // Any other undefined name is usually a handle the code expected to hold: nothing binds one
    // implicitly, and a restarted runtime has lost earlier bindings.
    return `${msg} — `
      + (fresh
        ? "this call started a FRESH runtime, so nothing declared in an earlier call survives (the server was restarted, or its host reaped it while idle). "
        : "no call on this runtime declared it at the top level, and nothing is predefined but computer. ")
      + "If it is a surface handle, bind it: const w = await computer.surface('<id or title>').";
  };

  // `createContext` starts from a bare V8 global: no require / process / fetch / setTimeout, and
  // no top-level verbs (every verb is reached through a surface handle).
  const freshSandbox = () => createContext({ computer, console: undefined });
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
    label: "Computer REPL",
    description: REPL_DESCRIPTION,
    promptSnippet: "computer_repl runs JavaScript over the GUI in a persistent session: verbs, surface handles, one observation per call.",
    promptGuidelines: [
      "Plan several actions per computer_repl call — one call costs one step and one observation whatever it does inside.",
      "Keep surface handles and collected data in top-level declarations; they persist across calls.",
      "Re-find by name inside a loop rather than reusing a ref you read earlier: find() handles re-resolve, raw refs do not survive a re-render.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description: "JavaScript, run as the body of an async function in the persistent runtime. `await` every verb; "
          // Models copy this example into EVERY call, so it shows bind-once and a later call that
          // just uses `w` apart; otherwise calls keep re-binding an intact handle.
          + "`return` what you want back. Bind once — first call: `const w = await computer.surface();` — "
          + "then later calls use `w` directly: `for (const e of (await w.observe()).elements.filter(e => e.role === 'checkbox')) await w.click(e.ref);`",
      }),
      purpose: Type.Optional(Type.String({ maxLength: 500,
        description: "Briefly describe the intended task when requesting app access. Shown to the user as the agent's stated purpose; it does not narrow the app permission. Do not include secrets.",
      })),
      interaction: Type.Optional(Type.Union([Type.Literal("background"), Type.Literal("desktop")], {
        description: "Native apps default to background — macOS: driver mouse/activation/clipboard routes are blocked, including fallback; "
          + "Windows: limited UIA setText/click/scroll by ref, with automatic focus and real-input fallback disabled; unsupported routes are refused. "
          + "Use desktop only after explaining effects and obtaining permission covering this call. This option is not user consent.",
      })),
      platform: Type.Optional(Type.String({
        description: "For a HOST that mounts several platforms in one session: the platform this call is about "
          + "(\"browser\", \"electron\", \"macos\", \"windows\"). computer.surfaces() and computer.surface() then see only its surfaces, and the "
          + "observation is of it; the other platforms stay mounted and untouched.",
      })),
      target: Type.Optional(Type.String({
        description: "Bind this surface before the code runs — the same string computer.surface() takes (an id, a whole "
          + "title, or a piece of one). For a HOST that decides which surface a call is about: the code can still "
          + "bind whatever it likes, and this only settles where a run that binds nothing lands.",
      })),
      observation: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("brief"), Type.Literal("none")], {
        description: "How much of the end-of-run observation to render. \"full\" (default) is the element list and the text "
          + "excerpt; \"brief\" keeps the head (title, targets, verdict) and drops the listing; \"none\" leaves only the action "
          + "journal. The observation is always TAKEN either way — the change verdict and the stale-ref bookkeeping are "
          + "unaffected — and a NOTE line always survives, so a swallowed click is never hidden by this. Reach for it when "
          + "the window holds content you do not want in the transcript, or when your own `return` value is the answer.",
      })),
    }),
    async execute(params) {
      ownershipRefusal = null;
      requestedHelp = null;
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
      const waited = () => slices.reduce((ms, sl) => ms + sl.driver.waitedOnUserMs, 0);
      const waitedBefore = waited();
      let actions = 0;
      let acted: string | null = null; // the last verb the run dispatched, or null for a pure look
      let refused = false; // a verb was attempted and failed — the run was not a look either
      let stepStart: number | null = null; // the open step's first charge (a verb can charge twice)
      const round: WriteRound = { fields: 0, verified: 0, ended: null };
      current = {
        round,
        charge(kind) {
          stepStart ??= Date.now();
          if (resetPending) throw new Error("The runtime was reset; this run stops before its next operation.");
          if (++actions > MAX_ACTIONS) throw new Error(`step cap reached (${MAX_ACTIONS} actions) at ${kind} — split the work across calls, or narrow the loop`);
          if (Date.now() - started - (waited() - waitedBefore) > MAX_MS) throw new Error(`time cap reached (${MAX_MS / 1000}s) at ${kind} — the surface may be slower than the code assumes`);
        },
        push(kind, target, ok, note, read, outcome) {
          if (!read && ok && !READ_KINDS.has(kind) && !OFF_SURFACE_KINDS.has(kind)) acted = kind;
          if (!read && !ok && !READ_KINDS.has(kind)) refused = true;
          const ms = stepStart === null ? undefined : Date.now() - stepStart;
          stepStart = null;
          journal.push({ i: journal.length + 1, kind, target, ok, note, ...(outcome ? { outcome } : {}), ...(ms !== undefined ? { ms } : {}) });
        },
        attach(part) { images.push(part); },
      };
      const fresh = !sandbox;
      sandbox ??= freshSandbox();

      let returned: unknown;
      let failure: string | null = null;
      try {
        // A host's `target` is bound through the same pick and `bind` the code would use, so a run
        // that binds nothing lands where the CALLER meant.
        const want = String((params as { target?: unknown }).target ?? "").trim();
        if (want) await bind(handleFor(await resolveHostTarget(want)));
        returned = await runInContext(prepareCode(src), sandbox, { filename: "computer_repl", timeout: SYNC_MAX_MS });
      } catch (e) {
        if ((e as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
          e = new Error(`the code ran for ${SYNC_MAX_MS / 1000}s without awaiting anything and was stopped — `
            + "a loop that never awaits blocks the whole runtime; await a verb (or w.wait) inside it");
        }
        failure = explain(e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : String(e), fresh);
      } finally {
        try { await gate.drain(); }
        catch (e) { failure ??= explain(e instanceof Error ? e.message : String(e), fresh); }
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
      // A throw ends the call before `return`; say here what survives a stop.
      if (failure && journal.length > 0) {
        lines.push("Nothing was returned: the throw ended the call before `return`. What survives a stop — "
          + "top-level bindings (read them in your next call) and anything already passed to log() (in the journal above).");
      }
      // After a stop the next call tends to re-bind; name the handles that still hold.
      if (failure) {
        const held = boundHandles(sandbox);
        if (held.length) lines.push(`Still bound: ${held.join(", ")} — use ${held.length === 1 ? "it" : "them"} directly in the next call.`);
      }
      if (returned !== undefined) {
        const body = stringify(returned);
        lines.push(`Returned: ${body.length > RETURN_CAP && returned !== requestedHelp
          ? `${body.slice(0, RETURN_CAP)}… (cut at ${RETURN_CAP} of ${body.length} chars — return a slice, a count or a filtered list instead of the whole thing)`
          : body}`);
      }
      // The reference is owed once per PLATFORM, delivered when the session first reaches it.
      const docs = slices.filter((sl) => sl.docsDue && (sl === landed || slices.length === 1))
        .map((sl) => {
          sl.docsDue = false;
          // The FIRST platform carries the whole reference; a later one only its own part.
          const whole = !coreSent;
          coreSent = true;
          const body = whole ? apiReference(sl.driver) : platformReference(sl.driver);
          return { type: "text" as const, text: `\n${body}`, pinned: true as const };
        });
      if (respawnNoteDue) {
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
      // A run whose only verb was refused did not look either: no look wording under the refusal.
      else if (refused) landed.driver.noteContentRead();
      const after = acted ? { afterAction: acted } : {};
      const permissionRefusal = slices.find(sl => sl.driver.permissionRefusal)?.driver.permissionRefusal;
      if (requestedHelp && journal.length === 0) {
        const r = text(lines.join("\n"), { verdict: "unknown", ledgerLines: lines.length, timing: timing(),
          ...(failure ? { error: "run_stopped" } : {}) });
        r.content.push(...docs);
        return r;
      }
      if (permissionRefusal || ownershipRefusal) {
        // Binding can be denied before an app becomes active. Observing afterwards would
        // either ask again, read the previous app, or misreport "no app was named".
        const refusal = permissionRefusal || ownershipRefusal!;
        if (!failure?.includes(refusal)) lines.push(`Observation skipped: ${refusal}`);
        const r = text(lines.join("\n"), { verdict: "unknown", ledgerLines: lines.length, timing: timing(),
          ...(failure ? { error: "run_stopped" } : {}),
          ...(permissionRefusal ? { permissionRefused: true } : { ownershipRefused: true }) });
        r.content.push(...images, ...docs);
        return r;
      }
      try {
        if (resetPending || (lastBound && (!leaseGroups.has(lastBound)
            || !(await landed.driver.isActiveTarget(owner.get(lastBound)!.inner))))) {
          const note = landed.driver.takeNoteForResult();
          const r = text(`${lines.join("\n")}${note ? `\nNOTE: ${note}.` : ""}\nObservation skipped: the bound target was released, closed or replaced. List surfaces and bind the intended target before continuing.`,
            { verdict: "unknown", ledgerLines: lines.length, timing: timing(), ...(failure ? { error: "run_stopped" } : {}) });
          r.content.push(...images, ...docs);
          return r;
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
        const r = text(`${lines.join("\n")}\n(re-observation failed: ${again}.)`, { verdict: "unknown", ledgerLines: lines.length, timing: timing(), ...(failure ? { error: "run_stopped" } : {}) });
        r.content.push(...images, ...docs);
        return r;
      }
    },
  });
  // What was granted for one call alone (ComputerUseDriver.endCall) ends with it, however the call ends.
  const runCall = repl.execute.bind(repl);
  repl.execute = async (params) => {
    callRunning = true;
    let finish!: () => void;
    callFinished = new Promise<void>(resolve => { finish = resolve; });
    try {
      return await runCall(params);
    } finally {
      try {
        if (resetPending) {
          for (const sl of slices) await sl.driver.releaseInputResources();
          await ownership.releaseAll();
          resetPending = false;
        }
        scoped = null;
        for (const sl of slices) {
          sl.driver.endCall();
          sl.driver.consentPurpose = null;
          sl.driver.permissionRefusal = null;
        }
      } finally { callRunning = false; finish(); }
    }
  };

  const reset = spec({
    name: "computer_repl_reset",
    label: "Computer REPL reset",
    description: RESET_DESCRIPTION,
    promptSnippet: "computer_repl_reset discards the persistent JavaScript bindings; surfaces are untouched.",
    parameters: Type.Object({}),
    async execute(params) {
      const draining = callFinished;
      if (callRunning) resetPending = true;
      else {
        for (const sl of slices) await sl.driver.releaseInputResources();
        await ownership.releaseAll();
      }
      sandbox = null;
      lastBound = null;
      handles.clear();
      refOwner.clear();
      for (const sl of slices) sl.docsDue = true;
      coreSent = false;
      respawnNoteDue = false;
      if ((params as { waitForIdle?: boolean } | undefined)?.waitForIdle) await draining;
      return text("The JavaScript runtime was reset: every binding is gone. The next computer_repl call starts fresh and "
        + "returns the API reference. No surface was touched — tabs, windows and apps are as they were.", { reset: true });
    },
  });

  return [repl, reset];
}
