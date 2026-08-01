// update-log.ts — Persistent, size-capped log of update activity.
//
// The in-memory /log ring buffer (log-buffer.ts) is wiped on every restart, and
// updates ALWAYS restart the server — so without this, the record of what an
// update did (and why it failed) vanishes the moment it finishes. This module
// persists update activity to a small on-disk file that survives restarts, and
// replays its tail back into the /log buffer at startup so it's visible there.
//
// Storage-safe by construction: the file is HARD-CAPPED at MAX_BYTES, trimmed to
// the last MAX_BYTES (at a line boundary) on every append and at startup. Each
// update run only appends a bounded tail (see scripts/update.sh), so it can
// never grow without limit — worst case it holds the most recent ~128 KB.

import * as fs from "node:fs";
import * as path from "node:path";

import { getUserDataPath } from "./app-paths.js";
import { addLogLine } from "./log-buffer.js";
import { trimFileToLastBytes } from "./trim-file.js";

const MAX_BYTES = 128 * 1024; // hard cap on the on-disk update log (~128 KB)
const REPLAY_LINES = 150; // how much of the tail to surface in /log at startup

export function updateLogPath(): string {
  return path.join(getUserDataPath(), "update.log");
}

/** Append one timestamped line, then trim the file back under the cap. Never throws. */
export function appendUpdateLog(line: string): void {
  try {
    fs.appendFileSync(updateLogPath(), `${new Date().toISOString()} ${line}\n`);
    trimUpdateLog();
  } catch {
    /* logging must never break the app */
  }
}

/** Keep only the last MAX_BYTES of the file, cut at a line boundary. */
function trimUpdateLog(): void {
  trimFileToLastBytes(updateLogPath(), MAX_BYTES);
}

/** Last `maxLines` lines of the persisted log, oldest → newest. */
export function readUpdateLogTail(maxLines = REPLAY_LINES): string[] {
  try {
    return fs
      .readFileSync(updateLogPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-maxLines);
  } catch {
    return [];
  }
}

/** On startup: trim the file, then surface its tail in the in-memory /log buffer
 *  (tagged [last-update]) so the last update's activity survives the restart. */
export function initUpdateLog(): void {
  trimUpdateLog();
  const tail = readUpdateLogTail();
  if (!tail.length) return;
  addLogLine("info", "[last-update] ---- recent update activity (persisted across restart) ----");
  for (const raw of tail) {
    // Lines are "<ISO> <message>" — split the leading timestamp back out so the
    // replayed line keeps its original time rather than "now".
    const sp = raw.indexOf(" ");
    const t = sp > 0 ? raw.slice(0, sp) : "";
    const msg = sp > 0 ? raw.slice(sp + 1) : raw;
    const validT = /^\d{4}-\d\d-\d\dT/.test(t) ? t : undefined;
    addLogLine("info", `[last-update] ${msg}`, validT);
  }
}
