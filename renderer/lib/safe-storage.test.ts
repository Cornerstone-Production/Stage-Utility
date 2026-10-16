// What a page gets from storage that is not there: private browsing, a locked-down
// kiosk profile and a full quota all make localStorage throw, and the answer in
// every case is the caller's own fallback or a plain "not kept", never an
// exception out of a render.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { browserStorage, readStored, removeStored, storeFailure, writeStored, type RemovableStorage } from "./safe-storage";

function throwing(): RemovableStorage {
  const refuse = (): never => {
    throw new Error("SecurityError: storage is blocked");
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

function inMemory(initial: Record<string, string> = {}): RemovableStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("readStored", () => {
  test("hands what is stored to parse, and null when nothing is", () => {
    const storage = inMemory({ k: "7" });
    assert.equal(readStored("k", (raw) => Number(raw), -1, storage), 7);
    assert.equal(readStored("missing", (raw) => (raw === null ? "none" : raw), "fallback", storage), "none");
  });

  test("storage that throws gives the fallback, and parse is never asked", () => {
    let asked = false;
    const value = readStored("k", () => {
      asked = true;
      return "parsed";
    }, "fallback", throwing());
    assert.equal(value, "fallback");
    assert.equal(asked, false);
  });

  test("no storage at all gives the fallback", () => {
    assert.equal(readStored("k", () => "parsed", "fallback", null), "fallback");
  });

  test("a parse that throws gives the fallback: a value nobody can read is no value", () => {
    const storage = inMemory({ k: "{not json" });
    assert.deepEqual(readStored("k", (raw) => JSON.parse(raw ?? "null") as unknown, { ok: false }, storage), { ok: false });
  });
});

describe("writeStored", () => {
  test("stores the value and says so", () => {
    const storage = inMemory();
    assert.equal(writeStored("k", "v", storage), true);
    assert.equal(storage.data.get("k"), "v");
  });

  test("storage that throws is false, not an exception", () => {
    assert.equal(writeStored("k", "v", throwing()), false);
  });

  test("no storage at all is false", () => {
    assert.equal(writeStored("k", "v", null), false);
  });
});

describe("storeFailure", () => {
  test("null when stored", () => {
    assert.equal(storeFailure("k", "v", inMemory()), null);
  });

  test("the thrown Error itself, so a caller can log why", () => {
    const failure = storeFailure("k", "v", throwing());
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /storage is blocked/);
  });

  test("no storage at all is an Error too", () => {
    assert.ok(storeFailure("k", "v", null) instanceof Error);
  });
});

describe("removeStored", () => {
  test("forgets the key and says so", () => {
    const storage = inMemory({ k: "v" });
    assert.equal(removeStored("k", storage), true);
    assert.equal(storage.data.has("k"), false);
  });

  test("storage that throws, or none, is false", () => {
    assert.equal(removeStored("k", throwing()), false);
    assert.equal(removeStored("k", null), false);
  });
});

describe("browserStorage", () => {
  test("is null where merely touching localStorage throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      assert.equal(browserStorage(), null);
      // And the defaults, which read it, fall back rather than throw.
      assert.equal(readStored("k", () => "parsed", "fallback"), "fallback");
      assert.equal(writeStored("k", "v"), false);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
