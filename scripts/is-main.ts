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

/**
 * `windows` is whether paths are read as Windows writes them (and compared without regard to case): this host's own answer unless a test says otherwise.
 * `realpath` resolves a symlink; a test passes its own to stand in for a Windows filesystem.
 */
export function isMain(
  importMetaUrl: string,
  argv1: string | undefined,
  { windows = process.platform === "win32", realpath = fs.realpathSync }: { windows?: boolean; realpath?: (p: string) => string } = {},
): boolean {
  if (!argv1) return false;
  const p = windows ? path.win32 : path;
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const self = p.resolve(fileURLToPath(importMetaUrl, { windows }));
  const entry = p.resolve(argv1);
  if (same(self, entry)) return true;
  // A symlinked invocation names the same file by another path, on every platform.
  try {
    return same(realpath(self), realpath(entry));
  } catch {
    return false;
  }
}
