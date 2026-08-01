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

function resolveAppRoot(): string {
  // An explicit override wins. The packaged launcher sets this, which makes the
  // answer independent of how the process was started.
  const override = process.env.STAGE_UTILITY_ROOT?.trim();
  if (override) return path.resolve(override);

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
