// app-root.ts — the directory the application was installed into.
//
// Four modules used to work this out by walking up from their own file with the
// depth written in by hand — `"..", ".."` from `main/services`, `"..", "..", ".."`
// from `main/services/archive`. That holds only while every file stays exactly
// where it is. Bundling the server into a single file collapses them all to one
// location at a different depth, so every one of those sums becomes wrong at the
// same moment, and each failure looks like a missing file rather than a bad path.
//
// Resolved once, by searching for a marker rather than counting directories, so
// the answer does not depend on where the caller happens to live.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Files that only exist at the root of an install or a checkout. */
const MARKERS = ["package.json", "VERSION"];

/** Guards against walking to `/` on a filesystem where no marker exists. */
const MAX_DEPTH = 8;

/** Does this directory actually look like the app's own install? */
function looksLikeAppRoot(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
}

function resolveAppRoot(): string {
  // An explicit override wins. The packaged launcher sets this, which makes the
  // answer independent of how the process was started.
  //
  // VALIDATED, not just resolved. This value ends up as the script path the
  // updater spawns and as the cwd it spawns in, so a typo used to mean the
  // updater ran a script from a directory that is not the app — and CodeQL
  // reads it, correctly, as an unchecked environment variable reaching a
  // command line. Requiring a real directory carrying one of the app's own
  // markers is the check that makes it a verified app root rather than an
  // arbitrary string.
  //
  // An override that fails the check is IGNORED rather than fatal, and says so:
  // falling back to the search below finds the right answer in every case where
  // the override was simply wrong, and refusing to boot over an environment
  // variable would take a display wall down for a typo.
  const override = process.env.STAGE_UTILITY_ROOT?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (looksLikeAppRoot(resolved)) return resolved;
    // The VALUE is deliberately not echoed. This module stays dependency-free —
    // it resolves at import time and is copied verbatim by the bundler, which is
    // what app-root.test.ts reproduces — so it has no scrub() to hand, and
    // interpolating an unscrubbed environment variable into a LAN-visible log is
    // the exact bug being fixed three files over. Whoever set the variable can
    // read it back; the log only has to say it was ignored and why.
    console.warn(
      `[app-root] ignoring STAGE_UTILITY_ROOT: not a directory containing ${MARKERS.join(" or ")}`,
    );
  }

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break; // hit the filesystem root
    dir = up;
  }
  // Nothing found: the working directory is what the server already assumes for
  // build/renderer and public/, so it is the least surprising fallback.
  return process.cwd();
}

/** Where the app's own files live — `build/`, `public/`, `scripts/`, `package.json`. */
export const APP_ROOT = resolveAppRoot();
