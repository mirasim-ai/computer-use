/**
 * What the driver READS: the walk, and the four channels built on it (observation, screenshot,
 * text, one element's value). The middle slice of {@link MacosDriver}'s chain:
 * `MacosDriverApps` (which app, which window, may we touch it) → this → `MacosDriverTargets`
 * (the listing and the switch) → the driver itself (its wiring and the verbs).
 *
 * Everything here starts at a pid and ends in bytes for the model; nothing here ACTS. The state
 * of the last walk (frame, rects, ref table) lives here and is `protected` for the verbs.
 */

import { SurfaceUnreadableError, type Element, type ScopedShot, type ShotScope, type Snapshot } from "../types.ts";
import { MacosDriverApps } from "./driver-apps.ts";
import { AxRequestError } from "./ax-client.ts";
import type { ElementActs } from "./act-element.ts";
import { mapTree, textOf, type AxTree, type AxWindow, type MappedTree } from "./elements.ts";
import { newWindowsNote, noWindowYetNote, textRunsNote, windowUnreadableNote } from "./narrate.ts";
import {
  SHOT_MAX_LONG_SIDE,
  TREE_MAX_DEPTH,
  TREE_MAX_ELEMENTS,
  TREE_MAX_TEXT,
  TREE_MAX_VISITED,
  TEXT_PREVIEW,
  TREE_WALK_DEADLINE_MS,
  pinnable,
  unreadable,
  type AxShot,
  type AxScopedShot,
} from "./ax-shapes.ts";

export abstract class MacosDriverRead extends MacosDriverApps {
  /** Everything that acts on ONE ref-named element, supplied by {@link MacosDriver}; `readValue`
   *  answers from its ref table. */
  protected abstract readonly acts: ElementActs;
  /** The app pack this observation just delivered, held until the trim hook can claim it. */
  protected abstract appNoteThisRound: string | null;
  /** Bundles whose `app-notes.ts` entry has been delivered this session. */
  protected abstract readonly toldAbout: Set<string>;

  protected frame: AxWindow | null = null;
  /** ref → window-local rect from the last walk; with `frame` it is where a mouse event goes. */
  protected rects = new Map<string, { x: number; y: number; w: number; h: number }>();
  /** The refs the last walk listed OUTSIDE the window — reachable by every AX rung, by no pointer. */
  protected offscreenRefs = new Set<string>();
  /** Every control of the last walk, in and outside the window: what a click's effect is named
   *  from (`changeNote` in press-rungs.ts). */
  protected lastListed: Array<{ ref: string; role: string; name: string; offscreen?: boolean }> = [];
  /** How many of those are list rows the app has not filled in yet — nameless, with nothing named
   *  inside them. Nonzero only for a list that builds its rows as they scroll in. */
  protected offscreenEmptyRows = 0;
  /** Window points per pixel of the LAST screenshot the model saw (1 = unscaled). */
  protected shotScale = 1;
  /** Has a capture set {@link shotScale} in this session? A model point is "a pixel of the last
   *  screenshot", so without one the 1 above is a guess, wrong by 2× on a Retina window.
   *  @see MacosDriver.toScreen */
  protected shotTaken = false;
  /** Signature → ref across snapshots (see {@link RefAllocator}), kept PER WINDOW, so a visit to
   * another app and back does not re-mint the refs of an unchanged window: a task spanning two
   * apps is exactly where a caller holds refs it wants to keep.
   *
   * Safe because the counter below is never reset (no two surfaces share a ref), a walk replaces
   * `acts.keys` wholesale, and the repl re-owns every ref to the surface that last LISTED it.
   * Within one window the map is what the walk found plus uniquely-keyed elements that went away.
   *
   * Keyed on the RAW window id, so an app's unnumbered (`-1`) windows share one map. That is
   * deliberate: they are reachable only through the app-level target, one surface to a caller;
   * keying on `pinnable()` would give that surface no memory at all. */
  protected refsByWindow = new Map<string, Map<string, string>>();
  /** How many windows' maps to keep. A session that tours an app's windows must not grow without
   *  bound; the oldest is the one least likely to be returned to. */
  private static readonly MAX_WINDOWS_REMEMBERED = 12;
  /** How many signatures absent from the latest walk a window keeps a ref for (see `walk`). */
  private static readonly MAX_ABSENT_REFS = 400;
  protected refCount = 0;
  /** Which windows the app had at the last walk, so a NEW one can be named. Null until the first
   *  walk; the unnumbered count is where a just-opened sheet shows up first (see
   *  noteWindowChanges). Keyed by pid: a baseline of ANOTHER app is no baseline. */
  protected appWindowIds: { pid: number; ids: Set<number>; unnumbered: number } | null = null;

  /** Every walk goes through here: the helper REPLACES its key table on each `tree`, so the
   *  ref → key map must follow every walk (a text read included), or the next click by ref meets
   *  `stale_key` for an element that is right there. */
  protected async walk(maxText = TREE_MAX_TEXT): Promise<{ tree: AxTree; mapped: MappedTree }> {
    const { pid, window } = await this.ensure();
    const budget = {
      max: TREE_MAX_VISITED, deadlineMs: TREE_WALK_DEADLINE_MS,
      maxElements: TREE_MAX_ELEMENTS, maxText, depth: TREE_MAX_DEPTH,
    };
    let tree: AxTree;
    try {
      tree = await this.call<AxTree>("tree", { pid, ...(window !== undefined ? { window } : {}), ...budget });
    } catch (e) {
      // The pinned window is gone (closed, or replaced by the app) while the app lives on:
      // follow the app to its current main window once instead of failing every read.
      if (!(e instanceof AxRequestError && e.code === "no_window" && window !== undefined)) throw await this.sayNoWindow(e);
      this.windowId = null;
      try {
        tree = await this.call<AxTree>("tree", { pid, ...budget });
      } catch (again) {
        throw await this.sayNoWindow(again);
      }
    }
    if (tree.capped) {
      // The read budget, not the element budget: what the walk did not reach is unknown, so no
      // count. Out of NODES is a huge window (narrow it), out of TIME a slow app (retry). An older
      // helper sends no reason, which reads as the node wording.
      this.addNote(`the accessibility walk stopped at its read budget (${tree.visited} nodes) before covering the whole window — `
        + "what is listed is complete for the part it reached; "
        + (tree.cappedBy === "time"
          ? "the app answered too slowly to finish, so retrying may well reach further"
          : "focus a smaller window or read text"));
    }
    this.frame = tree.window;
    this.windowId = pinnable(tree.window.id);
    // After the pin, so the window being READ is never reported as one that appeared.
    await this.noteWindowChanges(pid, this.windowId);
    // A window the window server does not list reads as a zero frame with nothing in it, and an
    // empty SUCCESS reads as "this app has no controls". Refuse by name, as the screenshot channel
    // does; the reason is the helper's `locked` fact, not a guess.
    if (!tree.window.onScreen && tree.elements.length === 0) throw new SurfaceUnreadableError(this.windowUnreadable(tree.locked));
    // Off the window server's list does NOT by itself mean unreadable (an app launched in the
    // background has no row yet reads in full). What it lacks is geometry, so the note is about
    // coordinates, and only when there is no frame.
    if (tree.window.w <= 0 || tree.window.h <= 0) {
      this.addNote("this window reports no frame at all (macOS does not list it: minimised, another Space, or a sleeping display) — "
        + "coordinates and element rects from it mean nothing, so act by ref; a screenshot of it will be refused");
    }
    // Keyed on the window the walk ACTUALLY read: `windowId` is null whenever the helper picked
    // the main window itself.
    const winKey = `${this.app?.bundle ?? "?"}:${tree.window.id}`;
    const known = this.refsByWindow.get(winKey);
    const present = new Map<string, string>();
    const mapped = mapTree(tree, (sig) => {
      const ref = known?.get(sig) ?? `e${++this.refCount}`;
      present.set(sig, ref);
      return ref;
    });
    // What is not on screen now KEEPS its ref for when it comes back (a readout dropped while
    // empty), but only a rank-1 signature: "the third Delete button" may be a different row after
    // one went away, so those mint fresh.
    let carried = 0;
    for (const [sig, ref] of known ?? []) {
      if (carried >= MacosDriverRead.MAX_ABSENT_REFS) break;
      if (!present.has(sig) && sig.endsWith("|1")) { present.set(sig, ref); carried++; }
    }
    this.refsByWindow.delete(winKey); // re-insert: Map keeps insertion order, so this is recency
    this.refsByWindow.set(winKey, present);
    for (const k of this.refsByWindow.keys()) {
      if (this.refsByWindow.size <= MacosDriverRead.MAX_WINDOWS_REMEMBERED) break;
      this.refsByWindow.delete(k);
    }
    this.acts.keys = mapped.keys;
    this.rects = mapped.rects;
    this.offscreenRefs = new Set(mapped.offscreenElements.map((e) => e.ref));
    this.lastListed = [
      ...mapped.elements.map((e) => ({ ref: e.ref, role: e.role, name: e.name })),
      ...mapped.offscreenElements.map((e) => ({ ref: e.ref, role: e.role, name: e.name, offscreen: true })),
    ];
    // A row past the window with no name and no named element inside its frame: the list has not
    // built it yet (see `offscreenWindowNote`). By geometry, since the walk hands back a flat list.
    const named = mapped.offscreenElements.filter((e) => e.name).map((e) => mapped.rects.get(e.ref)).filter((r) => !!r);
    this.offscreenEmptyRows = mapped.offscreenElements.filter((e) => {
      const row = e.role === "row" && !e.name ? mapped.rects.get(e.ref) : undefined;
      return !!row && !named.some((r) => {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        return cx >= row.x && cx <= row.x + row.w && cy >= row.y && cy <= row.y + row.h;
      });
    }).length;
    return { tree, mapped };
  }

  /** Whether the last walk found nothing but window chrome. Read by the base class to keep the
   *  frozen verdict from denying an effect it cannot see (@see ComputerUseDriver.treeBlind) and by
   *  `renderHeadLines` to explain the window once per spell. */
  private lastWalkBare = false;

  protected override treeBlind(): boolean {
    return this.lastWalkBare;
  }

  /** Did the last walk find web content — a `webarea`, or an app that took the Chromium
   *  accessibility switch? Asked by advice that only applies where a web view can collapse a
   *  control's frame. @see MacosDriver.frozenExtra */
  protected lastWalkHadWeb(): boolean {
    return this.walkHadWeb;
  }

  private walkHadWeb = false;

  /** The bare fact, and whether it is NEW: asking marks the spell as explained, so it is true once
   *  until a readable walk resets it. @see selfDrawnWindowNote */
  protected takeBareWindow(): boolean {
    if (!this.lastWalkBare || this.saidSelfDrawn) return false;
    this.saidSelfDrawn = true;
    return true;
  }

  private saidSelfDrawn = false;

  /** Nothing but the window's own chrome? Any named control means the app publishes something to
   *  act on; unnamed traffic lights plus a static-text title is what a self-drawn app leaves. */
  private chromeOnly(elements: Element[]): boolean {
    return !elements.some((e) => e.name.trim() !== "" && e.role !== "text" && e.role !== "image");
  }

  protected windowUnreadable(locked: boolean): string {
    return windowUnreadableNote(locked);
  }

  // ── Primitives ──────────────────────────────────────────────────────────────

  protected async snapshot(): Promise<Snapshot> {
    const { tree: t, mapped } = await this.walk();
    const app = this.app!;
    if (t.textOverflow) this.addNote(textRunsNote(t.textOverflow));
    // Said because every other budget announces; these carry nothing, so the count is the fact.
    if (t.folded) this.addNote(`${t.folded} structural nodes with no name, value or action of their own were folded out of the listing`);
    // Reset the bare state FIRST: a window can look self-drawn, come back, and earn the note again.
    // A nudged app (took the accessibility switch) with almost nothing listed has not published
    // its web content yet; say so, or nameless boxes read as "this app is empty". The routes
    // named work in VS Code, and the helper keeps re-nudging.
    const bare = this.chromeOnly(mapped.elements);
    this.lastWalkBare = bare;
    this.walkHadWeb = !!t.nudged || mapped.elements.some((e) => e.role === "webarea");
    if (!bare) this.saidSelfDrawn = false;
    if (t.nudged && mapped.elements.length < 5) {
      this.addNote(`${app.name} answered the accessibility switch and its window still lists almost nothing — its web content is not `
        + "published to accessibility yet. The menu commands still work (menu({})), and a control you can SEE is reachable by "
        + "position (w.observe({screenshot: true}), then w.click({x, y})). Reading again later may find it awake");
    }
    // The bare case (a NATIVE self-drawn app) is said in `renderHeadLines`, NOT via addNote (why:
    // `takeIntro` in macos/driver.ts).
    return {
      url: `macos:${app.bundle}:${t.window.id}`,
      title: `${app.name} — ${t.window.title || "(untitled window)"}`,
      elements: mapped.elements,
      // Carried, not only counted: `readElements` merges it with `offscreen: true`, which lets
      // `find` name a row scrolled out of a list.
      offscreenElements: mapped.offscreenElements,
      text: mapped.text.length > TEXT_PREVIEW ? `${mapped.text.slice(0, TEXT_PREVIEW)}…` : mapped.text,
      meta: {
        scrollY: 0, viewportH: t.window.h, docH: t.window.h,
        // Found but not listed — the base narrates both counts with the way to reach them.
        ...(t.offscreen ? { offscreen: t.offscreen } : {}),
        ...(t.overflow ? { capped: t.overflow } : {}),
        // Carried into observe()'s return and find()'s miss, not only the NOTE: a script reads the
        // array, and only this tells a partial read from a full one.
        ...(t.capped ? { partial: `the walk stopped at its read budget (${t.visited} nodes, out of ${t.cappedBy === "time" ? "time" : "nodes"})` } : {}),
        // Action marks the walk took off every element line; this driver narrates them itself.
        ...(mapped.sharedMarks.length ? { sharedMarks: mapped.sharedMarks } : {}),
      },
    };
  }

  /** Window-list changes are effect evidence even when the observed parent stays unchanged.
   * Numbered ids and the unnumbered count also cover newly opened sheets and transient editors. */
  protected async noteWindowChanges(pid: number, reading: number | null): Promise<void> {
    const rows = await this.windows(pid).then((r) => r.rows).catch(() => null);
    if (!rows) return;
    const numbered = rows.filter((w) => pinnable(w.id) !== null);
    const unnumbered = rows.length - numbered.length;
    const before = this.appWindowIds?.pid === pid ? this.appWindowIds : null;
    const ids = new Set(numbered.map((w) => w.id));
    this.appWindowIds = { pid, ids, unnumbered };
    if (!before) return;
    const note = newWindowsNote(
      pid,
      numbered.filter((w) => !before.ids.has(w.id) && w.id !== reading),
      unnumbered > before.unnumbered,
    );
    const missing = [...before.ids].filter((id) => !ids.has(id));
    if (note || missing.length || unnumbered < before.unnumbered) {
      this.pendingSurfaceChange = true;
      this.addNote(note ?? (missing.length
        ? `this app no longer lists window${missing.length > 1 ? "s" : ""} ${missing.map((id) => `${pid}:${id}`).join(", ")} — computer.surfaces() lists the remaining targets`
        : "this app's window list changed: an unnumbered window is no longer listed"));
    }
  }

  /**
   * Say WHY an app answers nothing, when the reason is that it has no window at all: replaces the
   * helper's bare `app 470 has no window` with {@link noWindowYetNote}, as launch already does.
   *
   * ASK FIRST: `no_window` also carries a LOCKED screen, a window on another Space or minimised,
   * and a point covered by another window, each with truer wording. So the windows are counted,
   * and the helper's message passes through unless the count is zero (one extra call, failure
   * path only).
   */
  private async sayNoWindow(e: unknown): Promise<unknown> {
    if (!(e instanceof AxRequestError) || e.code !== "no_window") return e;
    const app = this.app;
    if (!app) return e;
    try {
      const { windows, locked } = await this.call<{ windows: unknown[]; locked?: boolean }>("windows", { pid: app.pid });
      if (locked || windows.length > 0) return e;
    } catch {
      return e;
    }
    return new AxRequestError("no_window", noWindowYetNote(app.name), e.ax);
  }

  async screenshot(): Promise<Buffer> {
    const { pid, window } = await this.ensure();
    let shot: AxShot;
    try {
      shot = await this.call<AxShot>("shot", { pid, ...(window !== undefined ? { window } : {}), maxLongSide: SHOT_MAX_LONG_SIDE });
    } catch (e) {
      // Same recovery as walk(): the pinned window is gone while the app lives on.
      if (!(e instanceof AxRequestError && e.code === "no_window" && window !== undefined)) throw unreadable(await this.sayNoWindow(e));
      this.windowId = null;
      try {
        shot = await this.call<AxShot>("shot", { pid, maxLongSide: SHOT_MAX_LONG_SIDE });
      } catch (again) {
        throw unreadable(await this.sayNoWindow(again));
      }
    }
    this.shotScale = shot.scale || 1;
    this.shotTaken = true;
    // Pin the window the model is now looking at, or a later read could re-pick another window
    // and map the model's x/y against a frame it never saw.
    this.windowId = pinnable(shot.id);
    this.frame = { id: shot.id, title: this.frame?.title ?? "", onScreen: true, x: shot.x, y: shot.y, w: shot.w, h: shot.h };
    // A separate sheet can open while the captured parent stays pixel-identical.
    await this.noteWindowChanges(pid, this.windowId);
    return Buffer.from(shot.png, "base64");
  }

  override async screenshotScoped(scope: ShotScope): Promise<ScopedShot> {
    if (scope.fullPage) throw new Error("fullPage screenshots are not supported on macOS; use ref or region for window detail");
    if (!!scope.ref === !!scope.region) throw new Error("pick exactly one of ref or region for a macOS scoped screenshot");
    if (scope.padding !== undefined && (!scope.ref || !Number.isFinite(scope.padding) || scope.padding < 0)) {
      throw new Error("padding needs a finite number of full-screenshot pixels, 0 or more, with ref");
    }
    if (scope.region && (![scope.region.x, scope.region.y, scope.region.width, scope.region.height].every(Number.isFinite)
      || !(scope.region.width > 0) || !(scope.region.height > 0))) {
      throw new Error("region needs finite x/y and positive width/height");
    }
    if (scope.region && !this.shotTaken) {
      throw new Error("region coordinates use the full screenshot; take w.screenshot() or w.observe({screenshot:true}) first");
    }
    const { pid, window } = await this.ensure();
    const windowId = window ?? this.frame?.id;
    if (windowId === undefined || windowId < 0) throw new Error("observe the intended window before taking a scoped screenshot");
    let key: string | undefined;
    if (scope.ref) {
      const target = this.acts.resolve(scope.ref, undefined);
      if (!("key" in target)) throw new Error(target.note ?? this.staleRefNote(scope.ref));
      if (this.offscreenRefs.has(scope.ref)) throw new Error(`${scope.ref} is outside the captured window; choose a visible control or region`);
      key = target.key;
    }
    const r = scope.region;
    const padding = (scope.padding ?? 0) * this.shotScale;
    if (!Number.isFinite(padding)) throw new Error("padding is too large for the full screenshot's coordinate scale");
    let shot: AxScopedShot;
    try {
      shot = await this.call<AxScopedShot>("shotscoped", { pid, window: windowId,
        ...(key ? { key, padding } : { region: {
          x: r!.x * this.shotScale, y: r!.y * this.shotScale,
          width: r!.width * this.shotScale, height: r!.height * this.shotScale,
        } }),
      });
    } catch (e) {
      if (e instanceof AxRequestError && e.code === "stale_key" && scope.ref) throw new Error(this.staleRefNote(scope.ref));
      throw unreadable(e);
    }
    // A detail crop never replaces the full-window pixel baseline used by point actions.
    const frame = this.frame;
    const canMap = this.shotTaken && frame?.id === shot.id
      && [frame.x - shot.x, frame.y - shot.y, frame.w - shot.w, frame.h - shot.h].every((delta) => Math.abs(delta) < 0.5);
    const capture = {
      target: { pid, windowId: shot.id },
      window: { x: shot.x, y: shot.y, width: shot.w, height: shot.h },
      region: { x: shot.region.x, y: shot.region.y, width: shot.region.w, height: shot.region.h },
      units: "window-points",
      pointsPerPixel: { x: shot.scale, y: shot.scaleY },
      toFullScreenshot: canMap ? {
        origin: { x: shot.region.x / this.shotScale, y: shot.region.y / this.shotScale },
        scale: { x: shot.scale / this.shotScale, y: shot.scaleY / this.shotScale },
      } : null,
    };
    return { bytes: Buffer.from(shot.png, "base64"), mimeType: "image/png", capture,
      note: `${scope.ref ? `element ${scope.ref}` : "region"}, ${shot.pixelWidth}×${shot.pixelHeight} pixels`
        + ` from ${shot.region.w}×${shot.region.h} window points at (${shot.region.x},${shot.region.y})`
        + ` in window ${shot.id}${shot.trimmed ? " — trimmed to the window" : ""}`
        + (this.shotTaken && !canMap ? " — window geometry changed since observation; observe again before point actions" : "") };
  }

  /** `what:'text'` is the "give me everything" channel, so it PAYS for everything: the walk
   *  carries a 400-char preview of each value, and the elements it flagged as cut are completed
   *  here, one op each.
   *
   *  Refs are never touched: completed values go through `textOf`, not a second mapTree (a static
   *  text's name IS its value, so re-mapping would re-mint every ref). A helper too old to send
   *  the flag completes nothing; the previews carry their receipt. */
  async readText(): Promise<string> {
    // As many text runs as the READ budget allows: the observation's text budget would silently
    // cut the one channel where nothing is trimmed for the model's sake.
    const { tree, mapped } = await this.walk(TREE_MAX_VISITED);
    // Both arrays: a row scrolled out of the window is as likely to hold a long value.
    const cut = [...tree.elements, ...(tree.offscreenElements ?? [])].filter((e) => e.valueCut);
    // `mapped.text` IS textOf(tree), off-screen rows included; only previewed values need more.
    if (!cut.length) return mapped.text;
    await Promise.all(cut.map(async (e) => {
      try {
        const full = (await this.call<{ value: string }>("value", { key: e.key })).value;
        // Only when it really is more: a shrunken answer would replace a preview with less.
        if (full.length >= e.value.length) { e.value = full; delete e.valueCut; }
      } catch {
        // Keep the preview and its receipt: the element may have left the tree since the walk.
      }
    }));
    return textOf(tree);
  }

  /**
   * One element's whole value (`value(ref)`), of which the listing's preview is a prefix. Read
   * from the live key the last walk registered: one round trip, no new walk
   * (@see {@link ComputerUseDriver.readValue}). A ref the latest observation lacks gets the
   * ordinary stale refusal, worded by `ElementActs`.
   */
  override async readValue(ref: string): Promise<string> {
    const k = this.acts.resolve(ref, undefined);
    if (!("key" in k)) throw new Error(k.note ?? this.staleRefNote(ref));
    try {
      return String((await this.call<{ value: string }>("value", { key: k.key })).value ?? "");
    } catch (e) {
      // The element left the tree since the walk: re-observe, do not retry the dead key.
      if (e instanceof AxRequestError && e.code === "stale_key") throw new Error(this.staleRefNote(ref));
      throw e;
    }
  }
}
