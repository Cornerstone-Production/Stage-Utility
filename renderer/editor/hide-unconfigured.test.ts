// The editor opens with this switch's stored value, and opens anyway where
// storage is blocked. The initial read used to be a bare localStorage.getItem in
// a useState initialiser, which threw on blocked storage and took the whole
// editor down with it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { StorageLike } from "../lib/safe-storage";
import { HIDE_UNCONFIGURED_KEY, readHideUnconfigured } from "./hide-unconfigured";

function storageHolding(value: string | null): StorageLike {
  return { getItem: (key) => (key === HIDE_UNCONFIGURED_KEY ? value : null), setItem: () => {} };
}

describe("readHideUnconfigured", () => {
  test("reads what was stored", () => {
    assert.equal(readHideUnconfigured(storageHolding("1")), true);
    assert.equal(readHideUnconfigured(storageHolding("0")), false);
  });

  test("is off when nothing is stored", () => {
    assert.equal(readHideUnconfigured(storageHolding(null)), false);
  });

  test("is off, rather than throwing, when storage is blocked", () => {
    const blocked: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError: storage is blocked");
      },
      setItem: () => {
        throw new Error("SecurityError: storage is blocked");
      },
    };
    assert.equal(readHideUnconfigured(blocked), false);
  });

  test("is off when merely touching localStorage throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      assert.equal(readHideUnconfigured(), false);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
