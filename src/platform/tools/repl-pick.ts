/** Which surface a script means by `computer.surface(…)`: one pure decision over the listing,
 * kept out of repl.ts so it can be read, and tested, without the runtime around it. */
import type { TargetInfo } from "../types.ts";
import type { MountedTarget } from "./repl-state.ts";

/**
 * Which surface the script named, or a refusal that lists the candidates — never a guess.
 *
 * Tried in order: the opaque `id`, the whole title, a piece of the title. The title carries the
 * human names (macOS: "TextEdit (com.apple.TextEdit) — Untitled"), hence ONE entry point and no
 * per-platform app()/tab(). NO ARGUMENT is not "the one in front of the user": it binds the
 * surface the call's host named (`hostBound`, settled before this is asked), else the only
 * surface, else the one THIS runtime opened or claimed (TargetInfo.mine) — the one it is on when
 * it has several. Tabs an earlier session left in a shared browser, and the user's, are never
 * the default; with no surface of its own among several the call is refused.
 *
 * `explainMiss` is asked only when nothing matched a name: the platforms' own reasons a surface
 * the caller named is not in the list (ComputerUseDriver.explainMiss), joined, or "".
 */
export function pickSurface(ts: MountedTarget[], want: unknown, explainMiss: (query: string) => string): MountedTarget {
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
  // With several platforms mounted ids carry a `<platform>/` prefix; the platform's own id
  // (`t2`, as a note or an app's own listing spells it) names the same surface when only one
  // platform has it. Two platforms with a `t2` each is a refusal below, listing both.
  const byInner = byId.length ? [] : ts.filter((t) => t.inner === q && t.id !== q);
  if (byInner.length === 1) return byInner[0]!;
  if (byInner.length > 1) throw new Error(`${byInner.length} surfaces have the id ${JSON.stringify(q)} — name one with its platform:\n${lines(byInner)}`);
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
    const why = explainMiss(q);
    throw new Error(`no surface matches ${JSON.stringify(q)} — the open ones are:\n${lines(ts)}${why ? `\n${why}` : ""}`);
  }
  throw new Error(`${hits.length} surfaces match ${JSON.stringify(q)} — name one exactly:\n${lines(hits)}`);
}
