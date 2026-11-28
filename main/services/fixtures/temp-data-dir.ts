// temp-data-dir.ts — an empty data dir for a test file, removed when it ends.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Point STAGE_UTILITY_DATA at a fresh temp dir and remove it when the test
 *  file's process exits, after every after() hook the file registers. Call it at the top of the file, before any service
 *  module loads: the stores read the variable when they are imported, so the
 *  service imports after it must be dynamic (`await import(...)`).
 *  `home: true` also sets HOME to `<dir>/home`, for code that reads ~. */
export function tempDataDir(prefix: string, opts: { home?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.STAGE_UTILITY_DATA = dir;
  if (opts.home) process.env.HOME = join(dir, "home");
  // On exit, not in after(): after() hooks run in registration order and this
  // one registers first, so it would delete the dir before the file's own
  // teardown (server.close, publisher.stop, recorder.forget) had run.
  process.once("exit", () => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
