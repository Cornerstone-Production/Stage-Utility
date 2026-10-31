// cue-naming.ts — a cue name for any text, that nothing else answers to.
//
// PURE, and shared: the server names the cue of a migrated Button with it, and the
// renderer names the cue of a new one, so the two cannot disagree about what
// `Projectors on` becomes. The renderer imports it through `@main/services`, like
// the rest of the cue grammar.

import { slugForCue } from "./cue-slug.js";
import { isPairHalfName } from "./cue-pairs.js";

/** The label every action button was created with, before a blank one meant "use
 *  the action's name". Saved buttons still carry it, and it names nothing. */
const LEGACY_DEFAULT_LABEL = "Action";

/** The label the operator actually chose, or undefined when it is blank or the old
 *  default. A cue is named from this, and a rebound button keeps it. */
export function chosenLabel(label: string | undefined): string | undefined {
  const t = (label ?? "").trim();
  return t && t !== LEGACY_DEFAULT_LABEL ? t : undefined;
}

/** lower_snake_case from any text, by the Companion import's own slug with accents
 *  folded first. "" when nothing usable is left. */
export function cueSlug(text: string): string {
  return slugForCue(text.normalize("NFKD").replace(/[̀-ͯ]/g, ""));
}

/**
 * A cue name for this text that nothing in `taken` answers to.
 *
 * Two traps beyond a plain clash. A name ending `_on` or `_off` reads as half of
 * an ON/OFF pair, and a half with no partner is dropped from the manifest, so a
 * Button labelled "Projectors on" would be bound to a cue that never appears: it
 * gets `_cue` appended. An empty slug (a label of only symbols) falls back to
 * `button`. `prefix` goes in front of the slug, so the pair-half check sees the
 * whole name.
 *
 * `taken` is what `takenCueNames` returns, and a pair's base counts as taken as
 * well as its two halves: the manifest lists a pair under its base.
 */
export function cueNameFor(text: string, taken: ReadonlySet<string>, prefix = ""): string {
  let base = `${prefix}${cueSlug(text) || "button"}`;
  if (isPairHalfName(base)) base = `${base}_cue`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
