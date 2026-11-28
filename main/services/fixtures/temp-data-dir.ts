// temp-data-dir.ts — an empty data dir for a test file, removed when it ends.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/** Point STAGE_UTILITY_DATA at a fresh temp dir and remove it when the test
 *  file's last test ends. Call it at the top of the file, before any service
 *  module loads: the stores read the variable when they are imported, so the
 *  service imports after it must be dynamic (`await import(...)`).
 *  `home: true` also sets HOME to `<dir>/home`, for code that reads ~. */
export function useTempDataDir(prefix: string, opts: { home?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.STAGE_UTILITY_DATA = dir;
  if (opts.home) process.env.HOME = join(dir, "home");
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
