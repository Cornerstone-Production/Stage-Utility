// servicecue-slug.ts — the URL names ServiceCue pages are addressed by, and the rules
// for a layout's name.
//
// A rundown lives at /servicecue/<service type>/<layout>. The layout part is a slug
// stored ON the layout when it is created, so renaming a layout does not move every
// tablet and display pinned to its address. Shared by the server (which assigns and
// guards slugs) and the renderer (which resolves and builds addresses).

import type { ServiceCueLayout } from "../types/pco.js";

/** The implicit layout showing every column; its slug is not a layout's to take. */
export const ALL_COLUMNS_SLUG = "all-columns";

/**
 * URL-friendly slug from a name ("The Gathering" → "the-gathering"). ASCII letters and
 * digits only, so a name with none ("Звук", "!!!") gives "x". That is kept rather than
 * made Unicode-aware: service types are addressed through it too, and every address
 * pinned before slugs were stored was built by exactly this function.
 */
export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** A value fit to be a stored slug: a string slugify leaves as it is. */
export function isSlug(v: unknown): v is string {
  return typeof v === "string" && slugify(v) === v;
}

/** The slug a layout is addressed by. Always present once the server has loaded it;
 *  the fallback covers a list read while saves are refused. */
export function layoutSlug(l: Pick<ServiceCueLayout, "name" | "slug">): string {
  return l.slug || slugify(l.name);
}

/** The slug of the layout with this id, when there is one. */
export function slugOf(layouts: readonly ServiceCueLayout[], id: string): string | undefined {
  const l = layouts.find((x) => x.id === id);
  return l && layoutSlug(l);
}

/** The layout an address names: by id first, then by slug, in `order`. The All columns
 *  address is the caller's to recognise. */
export function findLayout<T extends Pick<ServiceCueLayout, "id" | "name" | "slug" | "order">>(
  layouts: readonly T[],
  param: string,
): T | null {
  const sorted = [...layouts].sort((a, b) => a.order - b.order);
  const want = param.toLowerCase();
  return sorted.find((l) => l.id === param) ?? sorted.find((l) => layoutSlug(l) === want) ?? null;
}

/**
 * Give every layout a slug no other layout has, without moving one that already has
 * a unique slug. Idempotent: a list that is already right comes back unchanged.
 *
 * A layout with no slug yet (a file from before slugs) gets the address that opened it
 * when the rundown looked layouts up by name: of several whose names slugify alike, the
 * first in `order` was the one found, so it keeps the bare slug. Every bare slug is
 * reserved for its first owner BEFORE any suffix is handed out, so a shadowed "audio"
 * cannot take `audio-2` from a layout called "Audio 2", which that address opened.
 */
export function assignSlugs(layouts: ServiceCueLayout[]): ServiceCueLayout[] {
  const visit = layouts.map((_, i) => i).sort((a, b) => layouts[a].order - layouts[b].order || a - b);
  const taken = new Set<string>([ALL_COLUMNS_SLUG]);
  const slugs = new Map<number, string>();
  const claim = (i: number, slug: string) => {
    taken.add(slug);
    slugs.set(i, slug);
  };
  // A stored slug stands, unless it is malformed or another layout claimed it first.
  for (const i of visit) {
    const have = layouts[i].slug;
    if (isSlug(have) && !taken.has(have)) claim(i, have);
  }
  for (const i of visit) {
    const base = slugify(layouts[i].name);
    if (!slugs.has(i) && !taken.has(base)) claim(i, base);
  }
  for (const i of visit) {
    if (slugs.has(i)) continue;
    const base = slugify(layouts[i].name);
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    claim(i, `${base}-${n}`);
  }
  return layouts.map((l, i) => (l.slug === slugs.get(i) ? l : { ...l, slug: slugs.get(i) }));
}

/**
 * What two layout names are compared by: NFKC, lower case, and only the runs of letters,
 * marks and digits in any script. "Audio", "audio!" and "AUDIO" are one name; "Звук" and
 * "Свет" are two, though both slugify to "x". A name with no letter or digit at all
 * ("!!!") is compared as written, trimmed.
 */
export function layoutNameKey(name: string): string {
  const n = name.normalize("NFKC").toLowerCase();
  return n.match(/[\p{L}\p{M}\p{N}]+/gu)?.join(" ") ?? n.trim();
}

const ALL_COLUMNS_KEY = layoutNameKey("All columns");

/** Why a save may not give a layout this name, or null. Checked only for a name the
 *  save adds or changes, so a store that already holds two same-named layouts can
 *  still be reordered or edited until one is renamed. The list's shape is the
 *  route's to check: every entry here has a string id and name. */
export function layoutNameRefusal(incoming: ServiceCueLayout[], stored: ServiceCueLayout[]): string | null {
  const before = new Map(stored.map((l) => [l.id, l.name]));
  for (const l of incoming) {
    if (before.get(l.id) === l.name) continue;
    if (!l.name.trim()) return "A layout needs a name.";
    const key = layoutNameKey(l.name);
    if (key === ALL_COLUMNS_KEY) return `"${l.name.trim()}" is the built-in All columns layout. Pick another name.`;
    const clash = incoming.find((o) => o.id !== l.id && layoutNameKey(o.name) === key);
    if (clash) return `There is already a layout called "${clash.name.trim()}". Layout names must differ, ignoring case and punctuation.`;
  }
  return null;
}

/** A save refused over a layout's name; the route answers it with a 400. */
export class LayoutNameRefused extends Error {}

/**
 * The list a save stores: `incoming` checked against the naming rules, and each layout's
 * slug decided by the server. The slug already stored for an id is kept through a
 * rename, and a slug the caller sent is ignored, so no save can move the address a screen
 * is pinned to. The one exception is a layout still carrying the name Add layout gave it
 * (`autoNamed`): its first rename moves the slug to the new name, and from then on it is
 * fixed. The flag is taken from the caller only for a layout that is not stored yet.
 * Throws LayoutNameRefused.
 */
export function prepareLayoutsSave(incoming: ServiceCueLayout[], stored: ServiceCueLayout[]): ServiceCueLayout[] {
  const refusal = layoutNameRefusal(incoming, stored);
  if (refusal) throw new LayoutNameRefused(refusal);
  const byId = new Map(stored.map((l) => [l.id, l]));
  return assignSlugs(
    incoming.map((l) => {
      const { slug: _slug, autoNamed: _flag, ...rest } = l;
      const prev = byId.get(l.id);
      if (!prev) return l.autoNamed === true ? { ...rest, autoNamed: true } : rest;
      if (prev.autoNamed && l.name !== prev.name) return rest;
      return { ...rest, ...(prev.slug ? { slug: prev.slug } : {}), ...(prev.autoNamed ? { autoNamed: true } : {}) };
    }),
  );
}

/**
 * The list an import stores: `stored` with `incoming` appended (ids already checked
 * new by the caller). A file is not trusted the way the editor is: its `autoNamed` is
 * dropped (an imported layout counts as named), its slug is kept only when well formed
 * and free, and a name another layout already has, or a blank or All columns one, is
 * replaced by the first free "<name> 2", "<name> 3" … rather than refusing the whole
 * import. `renamed` says which, for the import's report.
 */
export function prepareLayoutsImport(
  incoming: ServiceCueLayout[],
  stored: ServiceCueLayout[],
): { layouts: ServiceCueLayout[]; renamed: { from: string; to: string }[] } {
  const keys = new Set([ALL_COLUMNS_KEY, ...stored.map((l) => layoutNameKey(l.name))]);
  // assignSlugs settles a clash by `order`, and an imported layout may sort first: a slug
  // a layout here already has is dropped up front, so an import never moves one.
  const slugsHere = new Set(stored.map(layoutSlug));
  const renamed: { from: string; to: string }[] = [];
  const added = incoming.map((l) => {
    const { autoNamed: _flag, slug, ...rest } = l;
    const base = l.name.trim() || "Layout";
    let name = base;
    for (let n = 2; keys.has(layoutNameKey(name)); n++) name = `${base} ${n}`;
    keys.add(layoutNameKey(name));
    if (name !== l.name.trim()) renamed.push({ from: l.name, to: name });
    return { ...rest, name, ...(isSlug(slug) && !slugsHere.has(slug) ? { slug } : {}) };
  });
  return { layouts: assignSlugs([...stored, ...added]), renamed };
}
