// servicecue-slug.ts — the URL names ServiceCue pages are addressed by.
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
