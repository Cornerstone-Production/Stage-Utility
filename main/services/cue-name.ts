// cue-name.ts — a cue name from the words an operator typed.
//
// PURE: no I/O, no engine, nothing node-only. The New cue dialog and the editor's
// Make it manual both import it, so the name a cue is given and the name the
// server accepts cannot be two opinions.
//
// A cue name is a URL (`POST /api/cues/<name>`) and a Home Assistant entity id,
// so it is `lower_snake_case`, unique across every cue's name AND former names,
// and not one of the built-ins. The operator types a display name ("Projectors
// on"); this makes the name from it.

import { firstFree } from "./first-free.js";
import { slugForCue } from "./cue-slug.js";
import { isPairHalfName } from "./cue-pairs.js";

/** Long enough for any sentence somebody types, short enough for a URL. */
export const MAX_CUE_NAME = 60;

/** Room kept under the cap for what is added after the cut: `_cue`, then `_NN`. */
const ROOM = 8;

/** The suffix that takes a name out of the `_on`/`_off` shape. See below. */
const NOT_A_PAIR_HALF = "_cue";

/** What differs between the paths that name a cue, and nothing else. */
export interface CueNameOptions {
  /** Goes in front of the slug (a Button's own command is `btn_…`). It counts toward the cap and the pair-half check. */
  prefix?: string;
  /** The slug when the text has no letters or digits in it. */
  fallback?: string;
}

/**
 * A usable cue name for `display`, not in `taken`. THE one deriver: the New cue
 * dialog, Make it manual, a rule converted to a command and a Button's own
 * command all come through here, so the same words are the same name on every
 * path. Only NEW names are made this way; a stored name is never re-derived.
 *
 * Four rules, each a failure that would otherwise ship:
 *
 *  - NEVER ENDING `_on` OR `_off`. The cue manifest reads that shape as one half
 *    of an ON/OFF pair, and a half with no partner is an ORPHAN: left out of Home
 *    Assistant, and absent from the manifest a console's cue button resolves
 *    against, so the button reads Unbound. "Projectors on" is exactly the cue an
 *    operator makes first, and `projectors_on` is exactly the name that breaks.
 *    It becomes `projectors_on_cue`. See isPairHalfName.
 *  - NEVER A NAME THAT IS TAKEN. `taken` is every name and former name the rules
 *    hold plus the built-ins, lowercased by the caller; a pair's base counts as
 *    taken too (see namesTakenForNewCue). A clash gets `_2`, `_3`… rather than a
 *    refusal at Create, which would be the first the operator heard of it.
 *  - NEVER EMPTY. Words with no letters or digits in them ("!!!") slug to
 *    nothing; the cue is called `fallback` ("cue" unless the caller says).
 *  - NEVER LONGER THAN MAX_CUE_NAME, prefix and suffixes included.
 */
export function deriveCueName(display: string, taken: Iterable<string>, opts: CueNameOptions = {}): string {
  const used = new Set(taken);
  const prefix = opts.prefix ?? "";
  const core = slugForCue(display).slice(0, MAX_CUE_NAME - ROOM - prefix.length).replace(/_+$/, "");
  let base = `${prefix}${core === "" ? (opts.fallback ?? "cue") : core}`;
  if (isPairHalfName(base)) base += NOT_A_PAIR_HALF;
  return firstFree(base, (s) => used.has(s), (b, n) => `${b}_${n}`);
}
