// safe-storage.ts — browser storage that is allowed not to be there.
//
// Private browsing, a locked-down kiosk profile and a full quota all make
// localStorage throw, and a preference that cannot be kept must never stop a
// page from drawing. Every per-browser preference here used to carry its own
// try/catch for that; they share these now. Each caller still decides what a
// failure MEANS: a read names its own fallback, and a write says whether it
// stuck (`writeStored`) or why it did not (`storeFailure`), so a caller that
// must tell the operator, or log a `[history]` line, still can.
//
// `storage` is a parameter only so a test can hand in one that throws, or an
// in-memory one; every real caller takes the default.

import { toError } from "@main/services/errors";

/** The part of the Storage interface a read or a write touches. */
export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** What `removeStored` needs on top of that. */
export interface RemovableStorage extends StorageLike {
  removeItem: (key: string) => void;
}

/** The browser's localStorage, or null where there is none or merely touching it
 *  throws (blocked cookies). */
export function browserStorage(): RemovableStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Read `key` and turn what is there into a value. `parse` gets null when nothing
 * is stored. `fallback` when there is no storage, when reading throws, or when
 * `parse` does: a stored value nobody can read is the same answer as no stored
 * value.
 */
export function readStored<T>(
  key: string,
  parse: (raw: string | null) => T,
  fallback: T,
  storage: StorageLike | null = browserStorage(),
): T {
  if (!storage) return fallback;
  try {
    return parse(storage.getItem(key));
  } catch {
    return fallback;
  }
}

/** Why storing `value` under `key` failed, or null when it was stored. For a
 *  caller that reports the failure rather than only noting it. */
export function storeFailure(key: string, value: string, storage: StorageLike | null = browserStorage()): Error | null {
  if (!storage) return new Error("browser storage is unavailable");
  try {
    storage.setItem(key, value);
    return null;
  } catch (err) {
    return toError(err);
  }
}

/** Store `value` under `key`. Whether it was kept: false is a browser that will
 *  not remember it, and the value still applies for this visit. */
export function writeStored(key: string, value: string, storage: StorageLike | null = browserStorage()): boolean {
  return storeFailure(key, value, storage) === null;
}

/** Forget `key`. Whether storage accepted it. */
export function removeStored(key: string, storage: RemovableStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
