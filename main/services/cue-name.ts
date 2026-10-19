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

import { slugForCue } from "./companion-export.js";
import { isPairHalfName } from "./cue-pairs.js";

/** Long enough for any sentence somebody types, short enough for a URL. */
export const MAX_CUE_NAME = 60;

/** Room kept under the cap for what is added after the cut: `_cue`, then `_NN`. */
const ROOM = 8;

/** The suffix that takes a name out of the `_on`/`_off` shape. See below. */
const NOT_A_PAIR_HALF = "_cue";

/**
 * A usable cue name for `display`, not in `taken`.
 *
 * Three rules, each a failure that would otherwise ship:
 *
 *  - NEVER ENDING `_on` OR `_off`. The cue manifest reads that shape as one half
 *    of an ON/OFF pair, and a half with no partner is an ORPHAN: left out of Home
 *    Assistant, and absent from the manifest a console's cue button resolves
 *    against, so the button reads Unbound. "Projectors on" is exactly the cue an
 *    operator makes first, and `projectors_on` is exactly the name that breaks.
 *    It becomes `projectors_on_cue`. See isPairHalfName.
 *  - NEVER A NAME THAT IS TAKEN. `taken` is every name and former name the rules
 *    hold plus the built-ins, lowercased by the caller. A clash gets `_2`, `_3`…
 *    rather than a refusal at Create, which would be the first the operator
 *    heard of it.
 *  - NEVER EMPTY. Words with no letters or digits in them ("!!!") slug to
 *    nothing; the cue is called `cue`.
 */
export function deriveCueName(display: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = slugForCue(display).slice(0, MAX_CUE_NAME - ROOM).replace(/_+$/, "");
  if (base === "") base = "cue";
  if (isPairHalfName(base)) base += NOT_A_PAIR_HALF;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base}_${n}`;
    if (!used.has(next)) return next;
  }
}
