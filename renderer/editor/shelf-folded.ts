// Whether the editor's widget shelf is folded to its one line, remembered per
// browser. Open wherever nothing is stored -- including a browser whose storage
// is blocked -- so the shelf is found the first time and the editor opens there.

import { readStored, writeStored, type StorageLike } from "../lib/safe-storage";

export const SHELF_FOLDED_KEY = "layout-widget-shelf-folded";

export function readShelfFolded(storage?: StorageLike | null): boolean {
  return readStored(SHELF_FOLDED_KEY, (raw) => raw === "1", false, storage);
}

export function writeShelfFolded(folded: boolean): void {
  writeStored(SHELF_FOLDED_KEY, folded ? "1" : "0");
}
