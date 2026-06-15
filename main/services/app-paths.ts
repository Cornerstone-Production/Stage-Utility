// app-paths.ts — User-data directory accessor.
//
// Resolves the directory that persists config, secrets, and the photo cache:
//   $STAGE_UTILITY_DATA  — if set
//   ~/.stage-utility     — default
//
// The value is resolved once on first access and memoised.
//
// Legacy migration: the data dir was renamed across releases
// (~/.stage-monitor → ~/.stage-display → ~/.stage-utility). To make updates
// non-destructive, the first time we resolve an empty target dir we look for an
// older dir that still holds config and copy it forward (the source is left
// intact). This is what keeps the App ID, secrets, logos, and slot layout from
// disappearing after an update/rename.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let _userDataPath: string | null = null;

// Older default dir basenames, most-recent first. Used only for one-time
// auto-migration into the current data dir.
const LEGACY_BASENAMES = ["stage-display", "stage-monitor"];

// A dir "has data" if it holds the primary config file.
function hasData(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, "settings.json"));
  } catch {
    return false;
  }
}

// Candidate legacy dirs to recover from, most-recent first. Looks for siblings
// of the target (same parent, legacy basenames — covers both /var/lib/stage-*
// and ~/.stage-*) plus the home-dir defaults as a fallback.
function legacyCandidates(target: string): string[] {
  const parent = path.dirname(target);
  const dot = path.basename(target).startsWith(".") ? "." : "";
  const home = os.homedir();

  const candidates = [
    ...LEGACY_BASENAMES.map((n) => path.join(parent, dot + n)),
    ...LEGACY_BASENAMES.map((n) => path.join(home, "." + n)),
  ];

  // De-dupe while preserving order, and never offer the target itself.
  return [...new Set(candidates)].filter((c) => c !== target);
}

function migrateLegacyData(target: string): void {
  if (hasData(target)) return; // already populated — nothing to do

  const source = legacyCandidates(target).find(hasData);
  if (!source) return;

  try {
    fs.mkdirSync(target, { recursive: true });
    // Copy everything (settings.json, slots.json, secrets.bin, encryption.key,
    // photo cache). The encryption key must come along or secrets won't decrypt.
    fs.cpSync(source, target, { recursive: true });
    console.log(`[app-paths] recovered config from legacy data dir ${source} → ${target}`);
  } catch (err) {
    console.error(
      `[app-paths] could not migrate legacy data ${source} → ${target}; ` +
        `you may need to copy it manually. Error:`,
      err,
    );
  }
}

/** Absolute path to the user-data directory. */
export function getUserDataPath(): string {
  if (!_userDataPath) {
    const target =
      process.env.STAGE_UTILITY_DATA ?? path.join(os.homedir(), ".stage-utility");
    migrateLegacyData(target);
    _userDataPath = target;
  }
  return _userDataPath;
}
