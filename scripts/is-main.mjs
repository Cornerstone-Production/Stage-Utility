// is-main.mjs — is this module the script node was started on?
//
//   if (isMain(import.meta.url, process.argv[1])) main();
//
// So a test can import a script without running it. Compared as paths, not as a suffix of
// the URL: argv[1] is `C:\repo\scripts\x.mjs` on Windows, whose last "/"-separated piece is
// the whole string, and a suffix test that fails there is a script that prints nothing and
// exits 0. For a check that is a silent pass, and for manifest-changed.mjs it was `npm ci`
// never running after a dependency change.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** `windows` is whether paths are read as Windows writes them (and compared without regard to case): this host's own answer unless a test says otherwise. */
export function isMain(importMetaUrl, argv1, { windows = process.platform === "win32" } = {}) {
  if (!argv1) return false;
  const p = windows ? path.win32 : path;
  const self = p.resolve(fileURLToPath(importMetaUrl, { windows }));
  const entry = p.resolve(argv1);
  if (self === entry) return true;
  if (windows) return self.toLowerCase() === entry.toLowerCase();
  // A symlinked invocation names the same file by another path.
  try {
    return fs.realpathSync(self) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}
