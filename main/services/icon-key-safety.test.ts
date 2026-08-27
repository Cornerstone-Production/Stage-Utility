// The icon map keys come off an HTTP body.
//
// `map[key] = value` with a key of `__proto__` writes the OBJECT PROTOTYPE
// rather than an entry, and every object in the process then carries the
// property. CodeQL flagged both icon setters as js/remote-property-injection —
// two high-severity alerts on one PR — and the route behind them is an
// unauthenticated POST on the LAN.
//
// Both setters had the same three lines, so both are fixed by the same helper
// and both are covered here.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { writeIconEntry } from "./stage-controller.js";

describe("a key that is not an id", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    test(`"${key}" is refused rather than written`, () => {
      assert.throws(() => writeIconEntry({}, key, "#ff0000", "icon-color"), /key must be/);
    });
  }

  test("the prototype is untouched after an attempt", () => {
    try { writeIconEntry({}, "__proto__", "#ff0000", "icon-color"); } catch { /* expected */ }
    // The thing the alert is actually about: a bare object must not have gained
    // a property because a request asked for one.
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
  });

  test("shapes that are not ids or tool paths are refused", () => {
    for (const bad of ["a b", "a.b", "with;semi", "x".repeat(65), "", "a\nb", "../etc"]) {
      assert.throws(() => writeIconEntry({}, bad, "Camera", "icon-glyph"), /key must be/, `"${bad}" was accepted`);
    }
  });
});

describe("the keys the app actually uses", () => {
  for (const key of ["display-1", "/baptism", "view-6", "home", "output_2"]) {
    test(`"${key}" still works`, () => {
      assert.deepEqual(writeIconEntry({}, key, "Camera", "icon-glyph"), { [key]: "Camera" });
    });
  }

  test('"" clears the entry rather than storing a sentinel', () => {
    assert.deepEqual(writeIconEntry({ "display-1": "Camera" }, "display-1", "", "icon-glyph"), {});
  });

  test("other entries survive a write", () => {
    const out = writeIconEntry({ "display-1": "Camera", "/baptism": "Droplet" }, "display-2", "Tv", "icon-glyph");
    assert.deepEqual(out, { "display-1": "Camera", "/baptism": "Droplet", "display-2": "Tv" });
  });

  test("the result is a plain object, so it serialises to settings.json", () => {
    // A null-prototype object is what makes the write safe, but some serialisers
    // skip its entries — the map that reaches disk has to be ordinary.
    const out = writeIconEntry({}, "display-1", "Camera", "icon-glyph");
    assert.equal(JSON.parse(JSON.stringify(out))["display-1"], "Camera");
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
  });
});
