// store-file-adoption.ts — a store whose file was renamed picks up the old one.
//
// A store's filename is part of what an operator has saved. When a release
// renames one (scriptview-layouts.json became servicecue-layouts.json), an
// install that upgrades has the OLD name on disk and a store that now reads the
// new one: without this it starts empty, and the operator's work looks gone.
//
// A store declares the name it replaced (DataStore's `renamedFrom`), and this
// moves the old file into place:
//
//   old only          -> renamed to the new name (fs.rename, atomic in one
//                        directory), one line says so
//   both exist        -> the NEW one wins and the old one is left exactly as it
//                        was, one line says so. Never deleted: it may be the only
//                        copy of something, and which is right is the operator's
//                        call, not ours.
//   neither / new only -> nothing to do
//
// Two entry points, because two moments matter:
//
//   adoptLegacyStoreFiles runs once at boot, before anything reads a store. It
//   has to run then and not lazily: a config snapshot reads the data directory
//   by the NEW names, so a store nobody had touched yet would be missing from a
//   backup taken straight after the upgrade.
//
//   DataStore itself calls adoptLegacyStoreFile before its first read or write,
//   so a store used outside server.ts (a script, a test) is covered too.
//
// A failure to move is returned to the caller (boot) or thrown (the store), never
// swallowed: the old file is still there and still the operator's, and a store
// that quietly started empty beside it is how a rename becomes data loss.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getUserDataPath } from "./app-paths.js";
import { errorMessage } from "./errors.js";
import { renamedStores, type RenamedFrom } from "./store-registry.js";

export type AdoptOutcome = "moved" | "kept-current" | "none";

export interface AdoptionReport {
  current: string;
  legacy: string;
  outcome: AdoptOutcome;
}

export interface AdoptionFailure {
  logTag: string;
  current: string;
  legacy: string;
  error: string;
}

/** Outcomes already reached in this process, by directory and file. Memoised so a
 *  store's first read and the boot pass cannot both rename (the second would find
 *  nothing and throw ENOENT) or both report the same standoff. */
const settled = new Map<string, Promise<AdoptOutcome>>();

/** Forget what was settled. For tests that reuse a directory; production never calls it. */
export function resetStoreFileAdoptionForTests(): void {
  settled.clear();
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function adopt(dir: string, current: string, legacy: RenamedFrom): Promise<AdoptOutcome> {
  const from = path.join(dir, legacy.filename);
  const to = path.join(dir, current);
  if (!(await exists(from))) return "none";
  if (await exists(to)) {
    console.warn(
      `[${legacy.logTag}] ${legacy.filename} and ${current} both exist: using ${current} and leaving ` +
        `${legacy.filename} untouched. Nothing was deleted; remove ${legacy.filename} yourself once you are sure ${current} is the one to keep.`,
    );
    return "kept-current";
  }
  await fs.rename(from, to);
  console.log(`[${legacy.logTag}] moved ${legacy.filename} to ${current} (renamed in this version; contents unchanged)`);
  return "moved";
}

/** Bring one store's old file forward, once per process. Throws if the move fails. */
export function adoptLegacyStoreFile(dir: string, current: string, legacy: RenamedFrom): Promise<AdoptOutcome> {
  const key = `${dir}\u0000${current}`;
  let pending = settled.get(key);
  if (!pending) {
    pending = adopt(dir, current, legacy);
    settled.set(key, pending);
    // A failed move is not remembered as settled: the next caller tries again
    // and sees the same error, rather than a store reading a file that was
    // never put in place.
    pending.catch(() => settled.delete(key));
  }
  return pending;
}

/**
 * Bring every registered store's old file forward. Run once at boot, before any
 * store is read.
 *
 * Returns what moved and what could not, and does not throw: the caller owns
 * what the operator is told, and one file that cannot move must not stop the
 * others being tried.
 */
export async function adoptLegacyStoreFiles(
  dir: string = getUserDataPath(),
): Promise<{ reports: AdoptionReport[]; failures: AdoptionFailure[] }> {
  const reports: AdoptionReport[] = [];
  const failures: AdoptionFailure[] = [];
  for (const s of renamedStores()) {
    try {
      reports.push({ current: s.filename, legacy: s.renamedFrom.filename, outcome: await adoptLegacyStoreFile(dir, s.filename, s.renamedFrom) });
    } catch (err) {
      failures.push({ logTag: s.renamedFrom.logTag, current: s.filename, legacy: s.renamedFrom.filename, error: errorMessage(err) });
    }
  }
  return { reports, failures };
}
