// The one authority for URL slugs the app already owns.
//
// A display's URL slug is matched against the same path space as the app's own
// pages. If a display could take the slug "history", the server resolves that
// path to the operator app FIRST, so the display would never render at all —
// worse than a duplicate, which is at least detectable.
//
// The router, the server's route table and the slug validator therefore all have
// to agree. Adding a page without reserving its path here is a CI failure (see
// reserved-slugs.test.ts), not a broken display discovered on a Sunday.
//
// The renderer cannot import this at runtime — the `@main/*` tsconfig alias is
// types-only and Vite has no matching resolve alias, so adding one would let
// renderer code pull in node-dependent backend modules. The settings UI fetches
// this list instead of keeping a copy that can drift.

import { LOG_PAGE_PATHS } from "./routes/log-paths.js";
import { OPERATOR_PATHS } from "./routes/operator-paths.js";

/**
 * Paths the app serves itself. A display slug may never take one of these.
 *
 * The operator surfaces are DERIVED from OPERATOR_PATHS rather than restated.
 * They were listed by hand until the operator app took them over, and adding
 * /automation and /integrations there left both unreserved — a display slugged
 * "automation" would have resolved to the operator app and never rendered.
 * Deriving removes that class of mistake: a new operator route is reserved the
 * moment it is routed.
 */
export const RESERVED_SLUGS: readonly string[] = [
  "", // the display picker
  "settings",
  "photos",
  // Both spellings of the log viewer, DERIVED for the same reason the operator
  // paths are: `/logs` was added as an alias of `/log` and reserving it by hand
  // is exactly the step that gets missed. A display slugged "logs" would resolve
  // to the redirect and never render.
  ...LOG_PAGE_PATHS.map((p) => p.replace(/^\//, "")),
  // The one URL every kiosk device opens. An output slug of "enroll" would
  // shadow it and leave every unclaimed screen showing that output instead.
  "enroll",
  ...OPERATOR_PATHS.map((p) => p.replace(/^\//, "")),
];

/** Prefix reserved for the settings live-preview iframes (see stage-view.tsx). */
export const RESERVED_SLUG_PREFIX = "preview-";

/** Slugs are lowercase, alphanumeric and hyphens — nothing that needs escaping in
 *  a URL, and nothing that could be read as a path segment. */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

export type SlugRejection =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a proposed display slug.
 *
 * `taken` is every id and slug already in use, EXCLUDING the output being edited —
 * otherwise re-saving an output would reject its own slug.
 */
export function validateSlug(slug: string, taken: Iterable<string>): SlugRejection {
  const s = slug.trim().toLowerCase();

  if (s === "") return { ok: true }; // clearing the alias is always allowed

  if (!SLUG_PATTERN.test(s)) {
    return { ok: false, reason: "Use lowercase letters, numbers and hyphens only." };
  }
  if (s.startsWith(RESERVED_SLUG_PREFIX)) {
    return { ok: false, reason: `"${RESERVED_SLUG_PREFIX}" is reserved for layout previews.` };
  }
  if (RESERVED_SLUGS.includes(s)) {
    return { ok: false, reason: `"/${s}" is a built-in page.` };
  }
  for (const t of taken) {
    if (t.toLowerCase() === s) {
      return { ok: false, reason: `"/${s}" is already used by another display.` };
    }
  }
  return { ok: true };
}
