/**
 * find(name) — a NAME the script wrote into the element it meant.
 *
 * Pure ranking over plain element records; api.ts does the read and the journaling. Tiers:
 *  1. EXACT name (else find('Save') on a Save panel answers the label "Save As:" over the button).
 *  2. PARTIAL, shortest name first — the shorter the name, the more of it the query is.
 *  3. INCIDENTAL: the query is only a word inside a long name ({@link isIncidental}); answered,
 *     but reported.
 * Within any tier a control beats a text label, and `near` re-orders by distance when given.
 */

/**
 * A target as the script may name it: a `find()` handle, or a bare ref.
 *
 * A handle SAYS how many controls the name matched: `find` picks the best one, but picking
 * silently is how the wrong "Copy" gets clicked, so the count and runners-up land in the journal
 * line. It also carries the SCOPE it was found under, so re-resolution after a re-render searches
 * the same narrowed set — a handle found in a sheet must never re-resolve onto a same-named
 * control in the window behind it.
 */
export type Handle = {
  ref: string;
  name: string;
  /** The PICK's role, on the same terms as `others` carry theirs — what says whether a runner-up
   *  is the SAME kind of thing or merely shares a name (a label beside a button). */
  role?: string;
  matches?: number;
  /** The runners-up, with whatever tells them apart. `id` rides along because names are
   *  confusable ("Expand Formula Bar" and "Formula Bar" both answer "Formula Bar") while developer ids never are. */
  others?: Array<{ ref: string; name: string; role: string; id?: string }>;
  /** The PICK's own id, on the same terms. */
  id?: string;
  scope?: FindScope;
  /** A labelled group's membership narrowed the search; distance did not break remaining ties. */
  nearGroup?: string;
  /** Set when NOTHING is named this and the only matches merely contain the query in a long name
   *  ({@link isIncidental}). Reported because `matches: 1` alone reads as "unambiguous" when it
   *  means "one bad option". */
  incidental?: boolean;
  /** Set when the pick was matched by the VALUE it holds (a file row, a filled field), not its
   *  name. Reported like {@link incidental}. @see valueOf */
  byValue?: boolean;
  /** Set when the control's whole name is what the QUERY starts with — asked for "Search for
   *  flights", the control is called "Search". Reported because the rest of the query matched
   *  nothing. @see shortenedName */
  byShortName?: boolean;
};

/**
 * How `find` is narrowed — one filter per way a name is ambiguous in practice: the wrong KIND of
 * thing carries it, it lives in another part of the surface, or it is not on screen.
 *
 * `within` is GEOMETRIC (the scope element's box, not accessibility ancestry): every platform
 * reports a frame and none reports a parent in the observation. Do not read it as "a descendant of".
 */
export interface FindScope {
  /** Only this normalized role (button, textbox, checkbox, …). */
  role?: string;
  /** Only controls whose centre lies inside this element's box (a ref, or a find() handle). */
  within?: string;
  /** Only controls the surface currently shows (drops the off-viewport matches). */
  visible?: boolean;
  /**
   * A matching group label restricts the search to that group's members (duplicate labels and
   * same-name members stay ambiguous). Otherwise a geometric anchor: prefer the match CLOSEST to
   * the element with this name — "the Copy next to 6:01 PM" in a transcript with one Copy per
   * message, where neither role nor box tells them apart. Ranking, not filtering: every match
   * stays in `matches`, ordered by distance.
   */
  near?: string;
}

/** Other matches a `find` names: three shows the ambiguity and which way to narrow; the exact
 *  count says how deep the pile goes. */
const AMBIGUITY_SHOWN = 3;

/** An element as the ranking needs it — every driver's observation carries these. */
interface Named { ref: string; name: string; role: string; id?: string; state?: string; offscreen?: boolean; rect: { x: number; y: number; w: number; h: number } }

/**
 * The VALUE a control holds, read out of the rendered state string (`filled:old-name.txt`). A
 * Finder list-view file row is an unnamed `textbox` whose only identity is its value.
 *
 * A value the line CUT (ends in the appended ellipsis) can only be matched as a prefix.
 */
function valueOf(e: Named): { text: string; cut: boolean } | null {
  const m = /(?:^|,)\s*filled:([^,]*)/.exec(e.state ?? "");
  if (!m) return null;
  const text = m[1].trim();
  return text ? { text: text.replace(/…$/, ""), cut: /…$/.test(text) } : null;
}

/**
 * One control listed twice — a named element wrapping a same-named one (a link inside an
 * option) — counted once. The collection pass keeps both on purpose (dropping a live target costs
 * more than a duplicate), but the AMBIGUITY COUNT must count distinct things. Judged by geometry;
 * the inner element is kept, as the collection pass does when it drops a wrapper.
 */
function dedupeNested<T extends Named>(list: T[]): T[] {
  const area = (e: T) => e.rect.w * e.rect.h;
  const encloses = (outer: T, inner: T) => {
    const cx = inner.rect.x + inner.rect.w / 2;
    const cy = inner.rect.y + inner.rect.h / 2;
    return area(inner) <= area(outer)
      && outer.rect.x <= cx && cx <= outer.rect.x + outer.rect.w
      && outer.rect.y <= cy && cy <= outer.rect.y + outer.rect.h;
  };
  const byName = new Map<string, T[]>();
  for (const e of list) {
    const k = e.name.trim().toLowerCase();
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(e);
  }
  const drop = new Set<T>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    // Same-named groups are small, so the pairwise pass stays cheap.
    for (const a of group) for (const b of group) if (a !== b && encloses(a, b)) drop.add(a);
  }
  return drop.size ? list.filter((e) => !drop.has(e)) : list;
}

/** Shortest control name the short-name tier accepts: "OK" starts plenty of unrelated queries. */
const SHORT_NAME_FLOOR = 3;

/**
 * Is `want` the control's whole name `elName` followed by more words? Anchored at the start and
 * cut at a word boundary, so "Search" matches "search for flights" and "Sign" misses "Signature".
 */
function shortenedName(elName: string, want: string): boolean {
  const n = elName.trim().toLowerCase();
  if (n.length < SHORT_NAME_FLOOR || n.length >= want.length || !want.startsWith(n)) return false;
  return /[^\p{L}\p{N}]/u.test(want.charAt(n.length));
}

type NamedGroup = { label: string; members: string[] };

/** A group label scopes by membership, not by a guessed rectangle around its children. */
function nearGroup(groups: NamedGroup[], near?: string, elements: Named[] = []): NamedGroup | undefined {
  if (!near) return undefined;
  const want = near.trim().toLowerCase();
  const exact = groups.filter((g) => g.label.trim().toLowerCase() === want);
  if (!exact.length && elements.some((e) => e.name.trim().toLowerCase() === want)) return undefined;
  const matches = exact.length ? exact : groups.filter((g) => g.label.toLowerCase().includes(want));
  if (matches.length > 1) throw new Error(`near: "${near}" names ${matches.length} groups — use a more specific group label or observe() and act by ref`);
  return matches[0];
}

/** The pick, plus what else carried the name. Pure, so the tiers reproduce without a surface. */
export function rankByName(elements: Named[], name: string, scope: FindScope = {}, groups: NamedGroup[] = []): Handle | null {
  const want = name.trim().toLowerCase();
  const group = nearGroup(groups, scope.near, elements);
  const members = group ? new Set(group.members) : null;
  const searched = narrow(elements, scope).filter((e) => !members || members.has(e.ref));
  // The developer id counts as an EXACT name, never a partial one: it does not move when the UI is
  // translated, and a substring of an id is not something anybody asks for.
  const exact = searched.filter((e) => e.name.trim().toLowerCase() === want
    || (e.id ?? "").trim().toLowerCase() === want);
  // Shortest name first among partials, else find('Follow') answers a long card that mentions it
  // before the Follow button.
  const partial = exact.length ? [] : searched
    .filter((e) => e.name.toLowerCase().includes(want))
    .sort((a, b) => a.name.length - b.name.length);
  const named = partial.filter((e) => !isIncidental(e.name, want));
  // The other direction: `query.startsWith(name)`. Controls relabel themselves as a flow
  // progresses ("Search for flights" becomes "Search"), so a name spelled a moment ago must still
  // land. Word-boundary anchored with a length floor, since "a" or "S" prefixes most queries.
  // Longest name first: the longer name explains more of the query.
  const shortened = exact.length || named.length ? [] : searched
    .filter((e) => shortenedName(e.name, want))
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  // Value tiers sit between the name tiers and the incidental one.
  const valued = exact.length || named.length || shortened.length ? [] : searched.filter((e) => {
    const v = valueOf(e);
    return !!v && (v.cut ? v.text.toLowerCase().startsWith(want) : v.text.toLowerCase() === want);
  });
  const valuedPartial = exact.length || named.length || shortened.length || valued.length ? [] : searched
    .filter((e) => valueOf(e)?.text.toLowerCase().includes(want))
    .sort((a, b) => (valueOf(a)?.text.length ?? 0) - (valueOf(b)?.text.length ?? 0));
  // The incidental tier still answers (refusing would return null for a name the surface
  // contains); it is REPORTED instead.
  const byShortName = !exact.length && !named.length && shortened.length > 0;
  const byValue = !exact.length && !named.length && !byShortName && (valued.length > 0 || valuedPartial.length > 0);
  const incidental = !exact.length && !named.length && !byShortName && !byValue && partial.length > 0;
  const pool = exact.length ? exact
    : named.length ? named
    : shortened.length ? shortened
    : valued.length ? valued
    : valuedPartial.length ? valuedPartial
    : partial;
  const controls = pool.filter((e) => e.role !== "text");
  const ranked = dedupeNested(nearestFirst(controls.length ? controls : pool, elements, group ? undefined : scope.near));
  const hit = ranked[0];
  if (!hit) return null;
  return {
    ref: hit.ref,
    name: hit.name,
    role: hit.role,
    matches: ranked.length,
    ...(group ? { nearGroup: group.label } : {}),
    ...(hit.id ? { id: hit.id } : {}),
    others: ranked.slice(1, 1 + AMBIGUITY_SHOWN).map((e) => ({ ref: e.ref, name: e.name, role: e.role, ...(e.id ? { id: e.id } : {}) })),
    ...(incidental ? { incidental: true } : {}),
    ...(byValue ? { byValue: true } : {}),
    ...(byShortName ? { byShortName: true } : {}),
    ...(scope.role || scope.within || scope.visible || scope.near ? { scope } : {}),
  };
}

/** The elements a scoped `find` is allowed to match. */
function narrow<T extends { ref: string; role: string; offscreen?: boolean; rect: { x: number; y: number; w: number; h: number } }>(
  elements: T[],
  scope: FindScope,
): T[] {
  let list = elements;
  if (scope.role) {
    const role = scope.role.trim().toLowerCase();
    list = list.filter((e) => e.role.toLowerCase() === role);
  }
  if (scope.visible) list = list.filter((e) => !e.offscreen);
  if (scope.within) {
    const box = elements.find((e) => e.ref === scope.within)?.rect;
    if (!box) throw new Error(`within: ${scope.within} is not in the current observation — observe() and use a ref it lists`);
    // The CENTRE inside the box, not full containment: frames overhang their container by a pixel.
    list = list.filter((e) => {
      const cx = e.rect.x + e.rect.w / 2, cy = e.rect.y + e.rect.h / 2;
      return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
    });
  }
  return list;
}

/** Candidates ordered by distance to the element named `near`. A missing anchor throws: falling
 *  back to "the first one" is what `near` was passed to prevent. */
function nearestFirst<T extends { name: string; rect: { x: number; y: number; w: number; h: number } }>(
  ranked: T[],
  all: T[],
  near: string | undefined,
): T[] {
  if (!near) return ranked;
  const want = near.trim().toLowerCase();
  const anchor = all.find((e) => e.name.trim().toLowerCase() === want) ?? all.find((e) => e.name.toLowerCase().includes(want));
  if (!anchor) throw new Error(`near: nothing on the surface is named "${near}", so it cannot pick between the matches — `
    + "read the surface with text() and name something that is really beside the one you mean");
  const centre = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const a = centre(anchor.rect);
  return [...ranked].sort((p, q) => {
    const cp = centre(p.rect), cq = centre(q.rect);
    return Math.hypot(cp.x - a.x, cp.y - a.y) - Math.hypot(cq.x - a.x, cq.y - a.y);
  });
}

/** `find`'s second argument, as the script may write it: a plain object, `within` either a ref
 *  string or a find() handle. Anything else is a mistake worth naming rather than ignoring. */
export function findScope(opts: unknown, readsOffscreen: boolean): FindScope {
  if (opts === undefined || opts === null) return {};
  if (typeof opts !== "object") throw new Error(`find's second argument is an options object: {role, within${readsOffscreen ? ", visible" : ""}, near}`);
  const o = opts as { role?: unknown; within?: unknown; visible?: unknown; near?: unknown };
  const within = typeof o.within === "string" ? o.within
    : o.within && typeof o.within === "object" && typeof (o.within as Handle).ref === "string" ? (o.within as Handle).ref
      : undefined;
  if (o.within !== undefined && within === undefined) throw new Error("find's `within` must be a ref string or a find() handle");
  // Refused, not dropped: where reads never contain off-screen controls it would narrow nothing
  // while reading as though it had.
  if (o.visible && !readsOffscreen) {
    throw new Error("find's `visible` narrows nothing on this platform — its read never contains an off-screen control, "
      + "so every match find returns is already on screen. Drop it; to reach what is scrolled out, scroll first, then find");
  }
  return {
    ...(typeof o.role === "string" && o.role.trim() ? { role: o.role.trim() } : {}),
    ...(within ? { within } : {}),
    ...(o.visible ? { visible: true } : {}),
    ...(typeof (o as { near?: unknown }).near === "string" && (o as { near: string }).near.trim() ? { near: (o as { near: string }).near.trim() } : {}),
  };
}

/** What the journal shows a scoped find as. */
export function scopeLabel(scope: FindScope): string {
  const parts = [
    ...(scope.role ? [`role:${scope.role}`] : []),
    ...(scope.within ? [`within:${scope.within}`] : []),
    ...(scope.visible ? ["visible"] : []),
    ...(scope.near ? [`near:${scope.near}`] : []),
  ];
  return parts.length ? ` {${parts.join(", ")}}` : "";
}

/**
 * Is the query merely MENTIONED inside this name, rather than being what the element is called?
 *
 * Measured name/query length ratios fall in two bands: real names up to ~4x ("4506 Replies.
 * Reply"/Reply 3.8x), incidental mentions from ~13x (an account card containing "Follow"). 6x sits
 * in the empty middle. The absolute floor is for short queries, where a ratio alone means little.
 */
const INCIDENTAL_RATIO = 6;
const INCIDENTAL_CHARS = 40;
function isIncidental(name: string, want: string): boolean {
  return name.length > INCIDENTAL_CHARS && name.length > INCIDENTAL_RATIO * want.length;
}

/**
 * What to say when NOTHING carried the name — a bare "no match" costs the caller a full observe().
 * Three things it can know, in the order they help:
 *  1. the surface lists no controls at all — then the name was never the problem;
 *  2. the name IS there but the scope removed it (role/visible/within) — the most actionable
 *     miss there is, and the one a caller cannot guess;
 *  3. the closest names by shared words, so a wording difference or a typo is one hop, not two.
 */
export function nearMissNote(elements: Named[], name: string, scope: FindScope = {}, inText = false, groups: NamedGroup[] = []): string {
  const want = name.trim().toLowerCase();
  const group = nearGroup(groups, scope.near, elements);
  if (group) return `no matching control in group "${group.label}" — nothing outside this group's members was considered; observe() to check its controls`;
  // The surface's TEXT carries the name but no control does (a heading, a card title). Said
  // separately because the next move is opposite: text() or `near`, not scrolling or waiting.
  const asText = inText
    ? " — but the surface's TEXT carries it, so it IS here and is not a control: nothing to act on, "
      + "read it with text(), or use it to scope another find (near:'…')"
    : "";
  const named = elements.filter((e) => e.name.trim() && e.role !== "text");
  if (!named.length) return `no match — this surface lists no named controls at all${asText}`;

  // Scoped out: same name, excluded by role/visible/within. Re-rank with no scope and say what
  // the scope cost, naming the role that DOES carry it.
  if (scope.role || scope.visible || scope.within) {
    const loose = rankByName(elements, name, {});
    if (loose) {
      const why = scope.role ? `role:'${scope.role}'` : scope.visible ? "visible:true" : `within:${scope.within}`;
      return `no match under ${why} — without it the name finds ${loose.ref} (${loose.name.slice(0, 40)}); `
        + "widen the scope or name the control the surface actually carries";
    }
  }

  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const wanted = words(want);
  if (!wanted.length) return `no match${asText}`;
  const scored = named
    .map((e) => {
      const have = new Set(words(e.name));
      const shared = wanted.filter((w) => have.has(w)).length;
      return { e, score: shared / wanted.length };
    })
    // A third of the query's words in common: enough for one wrong word or one extra, not
    // enough for two unrelated names that happen to share "the".
    .filter((x) => x.score >= 0.34)
    .sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length);
  // One row per NAME: repeated nav links would otherwise crowd the three slots.
  const seen = new Set<string>();
  const shortlist = scored
    .filter((x) => { const k = `${x.e.role}\u0000${x.e.name.trim().toLowerCase()}`; return seen.has(k) ? false : (seen.add(k), true); })
    .slice(0, 3);
  if (!shortlist.length) return `no match — nothing among the ${named.length} named controls is close to it${asText}`;
  const list = shortlist.map((x) => `${x.e.role} "${x.e.name.slice(0, 40)}"`).join(", ");
  return `no match — closest by name: ${list}${asText}`;
}

/**
 * The runners-up the RANKING had no reason to put below the pick: same name, same role, still
 * tied. Empty for every other ambiguity, where the order IS an answer. Checked by a WRITE about
 * to act: in the repl the journal arrives only after the run, so the tie is caught there.
 */
export function tiedOthers(h: Handle): Array<{ ref: string; name: string; role: string; id?: string }> {
  const scope = h.scope ?? {};
  if ((h.matches ?? 1) < 2 || !h.others?.length) return [];
  // A filter is not proof of uniqueness: two visible textboxes can survive role/within/visible.
  // Only geometric `near` ranks a preferred match; a labelled group merely filters membership.
  if (!h.nearGroup && scope.near) return [];
  const same = h.name.trim().toLowerCase();
  return h.others.filter((o) => o.name.trim().toLowerCase() === same && o.role === h.role);
}

/** One journal line for a find: the ref, plus what else carried that name. */
export function ambiguityNote(h: Handle): string {
  const n = h.matches ?? 1;
  const groupNote = h.nearGroup ? ` (in group "${h.nearGroup}")` : "";
  // Said before the ambiguity count, even for one match: "1 of 1" would read as certainty.
  if (h.incidental) {
    const also = n > 1 ? ` (${n} such matches)` : "";
    return `${h.ref} — nothing here is NAMED that${also}; the closest is the word inside `
      + `«${h.name.slice(0, 60)}${h.name.length > 60 ? "…" : ""}», which is probably not the `
      + "control you meant — name it as the surface spells it, or observe() and pick a ref";
  }
  if (h.byShortName) {
    const also = n > 1 ? ` (${n} such matches)` : "";
    return `${h.ref} — the surface spells it «${h.name}»${also}, which is where your name STARTS; `
      + "the rest of what you asked for was matched against nothing. Controls relabel themselves "
      + "as a flow progresses, so check this is the one you meant";
  }
  if (h.byValue) {
    const also = n > 1 ? ` (${n} such matches)` : "";
    // The pick's OWN name, not the query's, so an unnamed row is not quoted as a placeholder.
    return `${h.ref} — matched by the VALUE it holds, not by a name${also}: `
      + `${h.name ? `its own name is "${h.name}"` : "it has no name of its own"}. A file row and a filled field are the usual shape`;
  }
  if (n <= 1) return h.ref + groupNote;
  // Each runner-up is NAMED, not just referenced: a bare "also e72" needs another read to act on.
  const tag = (x: { name: string; id?: string }) =>
    x.id && x.id.toLowerCase() !== x.name.trim().toLowerCase() ? ` ⟨id: ${x.id}⟩` : "";
  const also = (h.others ?? []).map((o) => `${o.ref} "${o.name}"${tag(o)}`).join(", ");
  const more = n - 1 - (h.others?.length ?? 0);
  // An id is exact and untranslated: suggested only when one exists.
  const byId = (h.id || (h.others ?? []).some((o) => o.id)) ? ", or name one of their ids — exact, and never translated" : "";
  return `${h.ref}${tag(h)}${groupNote} — 1 of ${n} matching "${h.name}" (also ${also}${more > 0 ? `, +${more} more` : ""}); `
    + `name it more precisely if that is the wrong one${byId}`;
}
