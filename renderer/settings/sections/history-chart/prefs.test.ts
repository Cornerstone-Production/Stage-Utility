// prefs.test.ts — what Customize remembers, and what it refuses to.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../../../test-dom.js";

const teardown = installDom();
const { addDefaultOnce, readStoredKeys } = await import("./prefs.js");

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

describe("addDefaultOnce", () => {
  test("appends the new key to an existing stored selection", () => {
    // The case it exists for: a stored chip selection from before `average`
    // existed. The stored list wins over the defaults, and it cannot name a key
    // that did not exist when it was written, so the new figure reaches nobody.
    localStorage.setItem(KEY, JSON.stringify(["peak", "samples"]));
    addDefaultOnce(KEY, "average");
    assert.deepEqual(readStoredKeys(KEY, [...ALLOWED, "average"], FALLBACK), ["peak", "samples", "average"]);
  });

  test("ONCE — an untick is not undone at the next load", () => {
    localStorage.setItem(KEY, JSON.stringify(["peak"]));
    addDefaultOnce(KEY, "average");
    // The operator unticks it again.
    localStorage.setItem(KEY, JSON.stringify(["peak"]));
    addDefaultOnce(KEY, "average");
    addDefaultOnce(KEY, "average");
    assert.deepEqual(readStoredKeys(KEY, [...ALLOWED, "average"], FALLBACK), ["peak"]);
  });

  test("a browser with nothing stored is left alone", () => {
    // It takes the DEFAULTS, which already carry the key. Writing a list here
    // would freeze today's defaults for that browser forever.
    addDefaultOnce(KEY, "average");
    assert.equal(localStorage.getItem(KEY), null);
  });

  test("a key already in the list is not duplicated", () => {
    localStorage.setItem(KEY, JSON.stringify(["peak", "average"]));
    addDefaultOnce(KEY, "average");
    assert.deepEqual(JSON.parse(localStorage.getItem(KEY) as string), ["peak", "average"]);
  });

  test("an unreadable selection is left exactly as it was", () => {
    localStorage.setItem(KEY, "{not json");
    addDefaultOnce(KEY, "average");
    assert.equal(localStorage.getItem(KEY), "{not json");
  });

  test("the marker is per key, so a second new default still lands", () => {
    localStorage.setItem(KEY, JSON.stringify(["peak"]));
    addDefaultOnce(KEY, "average");
    addDefaultOnce(KEY, "lowest");
    assert.deepEqual(JSON.parse(localStorage.getItem(KEY) as string), ["peak", "average", "lowest"]);
  });
});
