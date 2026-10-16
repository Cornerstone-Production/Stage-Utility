// The editor's "hide objects whose integration isn't set up" switch, remembered
// per browser. Opt-in, so off wherever nothing is stored — which includes a
// browser whose storage is blocked: the editor must open there, not throw.

import { readStored, writeStored, type StorageLike } from "../lib/safe-storage";

export const HIDE_UNCONFIGURED_KEY = "layout-hide-unconfigured";

export function readHideUnconfigured(storage?: StorageLike | null): boolean {
  return readStored(HIDE_UNCONFIGURED_KEY, (raw) => raw === "1", false, storage);
}

export function writeHideUnconfigured(hide: boolean): void {
  writeStored(HIDE_UNCONFIGURED_KEY, hide ? "1" : "0");
}
