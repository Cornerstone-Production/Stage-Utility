// export-filename.ts — the name a downloaded export file gets.
//
// One place for the view, plan and video feeds exports, so the date rule below
// cannot drift between them, and the one place a download's Content-Disposition
// value is built, so no route can put unchecked text into that header.

import { zonedDateKey } from "./app-timezone.js";
import { slugText } from "./slug.js";

/**
 * Operator-supplied text, safe to put in a quoted Content-Disposition value.
 *
 * Keeps only [a-z0-9-]: a quote or a path separator surviving here would be a
 * header injection, not a cosmetic problem. Bounded because some filesystems cap
 * a path component at 255 bytes.
 */
export function filenameSlug(name: string): string {
  // slugText trims again after the cut, which can land on the hyphen a space became.
  return slugText(name, { max: 60 });
}

/** `<prefix>-<slug>-2026-08-17.json`, or `<prefix>-2026-08-17.json` for an empty slug.
 *  The date is the app's zone, not the server's clock: a UTC box dates a file
 *  exported at 22:30 in Chicago as the next day. patch-export.ts fixed the same
 *  line first; the config and archive exports are the other copies. */
export function datedExportFilename(prefix: string, name: string, now: Date): string {
  const slug = filenameSlug(name);
  return `${prefix}-${slug ? `${slug}-` : ""}${zonedDateKey(now.getTime())}.json`;
}

/** What a download name may be: built by this server from slugs, dates and fixed
 *  words, so nothing a quoted header value would have to escape, and under the
 *  255-byte limit some filesystems put on a path component. */
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * `name` if it is a safe download name; throws otherwise.
 *
 * Every name reaching here is the server's own, so a refusal is a bug in the
 * code that built it, and answers 500 rather than writing the header. The name
 * is not echoed: it is exactly the text that failed the check.
 */
export function safeFilename(name: string): string {
  if (!SAFE_FILENAME.test(name)) throw new Error("refusing to name a download with unsafe characters");
  return name;
}

/** The whole Content-Disposition value for a download named `name`. Every route
 *  that serves a file builds the header through this; the export-filename test
 *  holds the list of the ones that do not yet. */
export function attachmentDisposition(name: string): string {
  return `attachment; filename="${safeFilename(name)}"`;
}
