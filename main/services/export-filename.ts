// export-filename.ts — the name a downloaded export file gets.
//
// One place for the view, plan and video feeds exports, so the date rule below
// cannot drift between them.

import { zonedDateKey } from "./app-timezone.js";

/**
 * Operator-supplied text, safe to put in a quoted Content-Disposition value.
 *
 * Keeps only [a-z0-9-]: a quote or a path separator surviving here would be a
 * header injection, not a cosmetic problem. Bounded because some filesystems cap
 * a path component at 255 bytes.
 */
export function filenameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** `<prefix>-<slug>-2026-08-17.json`, or `<prefix>-2026-08-17.json` for an empty slug.
 *  The date is the app's zone, not the server's clock: a UTC box dates a file
 *  exported at 22:30 in Chicago as the next day. patch-export.ts fixed the same
 *  line first; the config and archive exports are the other copies. */
export function datedExportFilename(prefix: string, name: string, now: Date): string {
  const slug = filenameSlug(name);
  return `${prefix}-${slug ? `${slug}-` : ""}${zonedDateKey(now.getTime())}.json`;
}
