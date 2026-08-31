// Re-check STORED display slugs against the reserved list, on every load.
//
// validateSlug runs on the write path only — stage-controller.setOutputSlug, and
// views.ts says so in as many words ("Validated against RESERVED_SLUGS on
// save"). A slug that was legal the day it was saved is never looked at again.
//
// That held until the app took a path it had previously left free. `/logs` was a
// LEGAL display slug: RESERVED_SLUGS held "log" alone, and OPERATOR_PATHS has no
// /logs. It is now both reserved AND a live route, and log-routes is in
// EARLY_ROUTE_MODULES — dispatched ahead of slug resolution. So an install that
// slugged a wall screen "logs" upgrades into a screen that stops rendering and
// serves the log viewer instead, while its Screens card still advertises that
// URL. Nothing errors and nothing says why.
//
// The screen keeps its `/<id>` URL either way — that never changes and never
// collides. What this repairs is the alias.
//
// Renamed rather than cleared, because the alias is the operator's work and this
// repository does not delete that to tidy something up: "logs" becomes "logs-2",
// which still reads as theirs, still appears on the Screens card, and can be
// changed to anything they like. Clearing would leave the card showing only the
// id with no hint that a name had ever been there. What changed IS reported, by
// the caller, on a line naming the screen and both slugs.
//
// Pure: no I/O, no persistence, no logging, so it can be tested against a real
// output list. Idempotent — after one pass no slug is reserved, so the next boot
// finds nothing.

import { RESERVED_SLUGS, RESERVED_SLUG_PREFIX, validateSlug } from "./reserved-slugs.js";
import type { Output } from "../types/stage.js";

export interface SlugChange {
  /** The output whose alias moved. Its `/<id>` URL is unaffected. */
  outputId: string;
  outputName: string;
  from: string;
  /** What it holds now, or null when no free name could be found. */
  to: string | null;
}

export interface SlugMigrationResult {
  outputs: Output[];
  changed: SlugChange[];
}

/**
 * How many suffixes to try before giving up and clearing.
 *
 * A bound rather than a `while (true)`: the taken set comes from the operator's
 * own screens, so twenty is far past any real install, and a loop that cannot
 * end is worse than an alias that has to be retyped.
 */
const MAX_SUFFIXES = 20;

/** Does the app itself now serve this path? */
function isReserved(slug: string): boolean {
  return RESERVED_SLUGS.includes(slug) || slug.startsWith(RESERVED_SLUG_PREFIX);
}

/** `logs` -> `logs-2`, `logs-3`, … — the first that is neither reserved nor taken. */
function freeAlternative(slug: string, taken: Set<string>): string | null {
  for (let n = 2; n <= MAX_SUFFIXES + 1; n++) {
    const candidate = `${slug}-${n}`;
    if (validateSlug(candidate, taken).ok) return candidate;
  }
  return null;
}

/**
 * Move any stored slug the app has since claimed for itself.
 *
 * `outputs` is returned by the SAME reference when there is nothing to do, so
 * the caller can skip its write on reference equality the way the surface
 * migration does.
 */
export function migrateReservedSlugs(outputs: readonly Output[]): SlugMigrationResult {
  const changed: SlugChange[] = [];
  // Every id and slug in play, so a rename cannot land on another screen's name.
  // Ids are in here too: `/display-2` resolves, so a slug of "display-2" would
  // shadow a different screen.
  const taken = new Set<string>();
  for (const o of outputs) {
    taken.add(o.id.toLowerCase());
    if (o.slug) taken.add(o.slug.toLowerCase());
  }

  const next = outputs.map((o) => {
    const s = o.slug?.trim().toLowerCase();
    // A slug that merely collides with another screen, or that an older
    // validator let through, is NOT this migration's business: it works or fails
    // on its own terms and nothing changed under it. Only a name the app has
    // since taken over is repaired here.
    if (!s || !isReserved(s)) return o;

    // Its own name excluded, or the alternative search would treat it as taken.
    const others = new Set(taken);
    others.delete(s);

    const to = freeAlternative(s, others);
    changed.push({ outputId: o.id, outputName: o.name || o.id, from: o.slug!, to });
    if (to) {
      taken.add(to);
      return { ...o, slug: to };
    }
    // Nothing free after twenty tries. The alias goes; the screen does not.
    const { slug: _gone, ...rest } = o;
    return rest as Output;
  });

  return { outputs: changed.length > 0 ? next : (outputs as Output[]), changed };
}

/** Lines for the server log, kept beside the decision so the two cannot drift. */
export function slugMigrationLog(result: SlugMigrationResult): string[] {
  return result.changed.map((c) =>
    c.to
      ? `"${c.outputName}" had the URL /${c.from}, which is now a built-in page — it is /${c.to} instead. ` +
        `Its /${c.outputId} URL is unchanged.`
      : `"${c.outputName}" had the URL /${c.from}, which is now a built-in page, and no free alternative ` +
        `was available — the alias is gone. Reach it at /${c.outputId}, or rename it in Screens.`,
  );
}
