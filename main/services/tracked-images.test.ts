// No screenshot may be committed to this PUBLIC repository.
//
// This guard exists because one was. `slots-short-after.png` — a full-width
// mic-slots display carrying ten real faces and full names, several of them
// children, plus the church name and a real plan title — was committed as
// working debris in an ordinary feature commit, reached `beta` and `main`, and
// rode 38 release tags before anyone looked at it.
//
// `.gitignore` is not the guard. It was already there and already too narrow
// (`*.playwright.png` matched nothing that screenshot was called), it does
// nothing about a file that is ALREADY tracked, and `git add -f` walks past it
// whatever it says. So this asks git what is actually committed.
//
// The allowlist is EXACT, not a floor. A floor with slack is how three config
// stores went missing from every backup with the suite green: a new image would
// simply slide in under it and nothing would say so. Adding a legitimate image
// to the product means adding it here too, deliberately, in the same change.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { APP_ROOT } from "./app-root.js";

/** Every raster image this repository is allowed to track, and why. */
const ALLOWED = [
  // The PWA/browser icon. Ships to the client; contains no photograph.
  "public/app-icon.png",
] as const;

const RASTER = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i;

test("the repository tracks no image except the ones named here", () => {
  // `git ls-files` is the real index, so this cannot be satisfied by a comment,
  // by a filename, or by anything a source-text scan would read.
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: APP_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter((f) => f !== "" && RASTER.test(f))
    .sort();

  assert.deepEqual(
    tracked,
    [...ALLOWED].sort(),
    `The repository is public. An image outside the allowlist is committed:\n` +
      `  tracked: ${JSON.stringify(tracked)}\n` +
      `  allowed: ${JSON.stringify([...ALLOWED].sort())}\n` +
      `If it is a screenshot, delete it — a screenshot of this app shows real ` +
      `faces, real names and a real plan. If it genuinely belongs in the ` +
      `product, add it to ALLOWED above with a line saying what it is.`,
  );
});
