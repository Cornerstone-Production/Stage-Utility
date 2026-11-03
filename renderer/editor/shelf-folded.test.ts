// The shelf is open wherever nothing is stored, and the editor still opens where
// storage is blocked.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { StorageLike } from "../lib/safe-storage";
import { SHELF_FOLDED_KEY, readShelfFolded } from "./shelf-folded";

const holding = (value: string | null): StorageLike => ({ getItem: (k) => (k === SHELF_FOLDED_KEY ? value : null), setItem: () => {} });

describe("readShelfFolded", () => {
  test("reads what was stored", () => {
    assert.equal(readShelfFolded(holding("1")), true);
    assert.equal(readShelfFolded(holding("0")), false);
  });
  test("is open when nothing is stored", () => {
    assert.equal(readShelfFolded(holding(null)), false);
  });
  test("is open, rather than throwing, when storage is blocked", () => {
    const blocked: StorageLike = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
    };
    assert.equal(readShelfFolded(blocked), false);
  });
});
