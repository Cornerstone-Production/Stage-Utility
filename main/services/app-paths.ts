// app-paths.ts — User-data directory accessor.
//
// Resolves the directory that persists config, secrets, and the photo cache:
//   $STAGE_MONITOR_DATA  — if set
//   ~/.stage-monitor     — default
//
// The value is resolved once on first access and memoised.

import * as os from "os";
import * as path from "path";

let _userDataPath: string | null = null;

/** Absolute path to the user-data directory. */
export function getUserDataPath(): string {
  if (!_userDataPath) {
    _userDataPath =
      process.env.STAGE_MONITOR_DATA ?? path.join(os.homedir(), ".stage-monitor");
  }
  return _userDataPath;
}
