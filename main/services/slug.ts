// slug.ts — text to a "[a-z0-9-]" slug. The one copy of the regex chain.
//
// The variants are deliberate and named, not tidied away: some slugs are stored or
// re-derived, so a change in what a name becomes would orphan what was saved under it.
// See servicecue-slug.ts (no fold, no cap), feed-id.ts, stageplots-store.ts.

export interface SlugOptions {
  /** Accents dropped before the rest is read. "marks" removes every Unicode mark
   *  (\p{M}); "combining" only the Latin combining block (U+0300-036F). They differ for
   *  scripts whose vowel signs are marks, so each keeps the rule its slugs were made with. */
  fold?: "marks" | "combining";
  /** At most this many characters; a hyphen the cut leaves at the end is trimmed. */
  max?: number;
  /** What a name with no letters or digits becomes. Empty by default. */
  fallback?: string;
}

export function slugText(text: string, { fold, max, fallback = "" }: SlugOptions = {}): string {
  let s = text;
  if (fold) s = s.normalize("NFKD").replace(fold === "marks" ? /\p{M}+/gu : /[\u0300-\u036f]/g, "");
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (max !== undefined) s = s.slice(0, max).replace(/-+$/g, "");
  return s || fallback;
}
