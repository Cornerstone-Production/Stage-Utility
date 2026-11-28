// is-main.ts — is this module the script node was started on?
//
//   if (isMain(import.meta.url, process.argv[1])) main();
//
// So a test can import a script without running it. Compared as paths, not as a suffix of
// the URL: argv[1] is `C:\repo\scripts\x.ts` on Windows, whose last "/"-separated piece is
// the whole string, so a suffix test there never matches and the script does nothing.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** `windows` is whether paths are read as Windows writes them (and compared without regard to case): this host's own answer unless a test says otherwise. */
export function isMain(
  importMetaUrl: string,
  argv1: string | undefined,
  { windows = process.platform === "win32" }: { windows?: boolean } = {},
): boolean {
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
