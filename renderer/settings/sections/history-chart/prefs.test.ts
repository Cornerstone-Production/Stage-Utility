// prefs.test.ts — what Customize remembers, and what it refuses to.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../../../test-dom.js";

const teardown = installDom();
const { readStoredKeys } = await import("./prefs.js");

const KEY = "attendance:visibleMetrics";
const ALLOWED = ["occupancy", "attendance", "avg", "items", "peak", "lowest", "samples"] as const;
const FALLBACK = ["occupancy", "avg", "items", "peak", "lowest", "samples"];

beforeEach(() => localStorage.clear());
after(() => teardown());

describe("readStoredKeys", () => {
  test("nothing stored yet gives the defaults", () => {
    assert.deepEqual(readStoredKeys(KEY, ALLOWED, FALLBACK), FALLBACK);
  });

  test("a stored choice wins over the defaults", () => {
    localStorage.setItem(KEY, JSON.stringify(["peak", "samples"]));
    assert.deepEqual(readStoredKeys(KEY, ALLOWED, FALLBACK), ["peak", "samples"]);
  });

  test("an EMPTY stored list is a real choice and is kept", () => {
    // "Show me no figures" is a thing an operator can ask for. Treating it as
    // "nothing stored" would spring every figure back on at the next reload,
    // which is how a preference that cannot be turned off gets reported as a bug.
    localStorage.setItem(KEY, JSON.stringify([]));
    assert.deepEqual(readStoredKeys(KEY, ALLOWED, FALLBACK), []);
  });

  test("a key that no longer exists is dropped rather than carried", () => {
    localStorage.setItem(KEY, JSON.stringify(["peak", "dayTotalRemoved"]));
    assert.deepEqual(readStoredKeys(KEY, ALLOWED, FALLBACK), ["peak"]);
  });

  test("unreadable JSON falls back instead of throwing on mount", () => {
    localStorage.setItem(KEY, "{not json");
    assert.deepEqual(readStoredKeys(KEY, ALLOWED, FALLBACK), FALLBACK);
  });

  test("a stored value that is not a list falls back", () => {
    localStorage.setItem(KEY, JSON.stringify({ peak: true }));
    assert.deepEqual(readStoredKeys(KEY, ALLOWED, FALLBACK), FALLBACK);
  });
});
