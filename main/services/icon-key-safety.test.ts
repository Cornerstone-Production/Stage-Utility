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

const FORBIDDEN = ["__proto__", "constructor", "prototype"];

/**
 * An icon map as it comes back off disk, carrying a reserved name.
 *
 * PARSED, never written as a literal: an object literal treats `__proto__` as a
 * prototype setter at parse time, so a literal cannot reproduce the case — the
 * key would never be own, and the test would assert nothing.
 */
const hostileMap = () =>
  JSON.parse(
    String.raw`{"display-1":"Camera","__proto__":{"polluted":true},"constructor":{"x":1}}`,
  ) as Record<string, string>;

describe("a key that is not an id", () => {
  test("the fixture really carries the reserved names as own keys", () => {
    // Without this the file could pass by testing nothing: if the parse ever
    // stopped producing an own "__proto__", the assertion below would be
    // trivially true.
    const map = hostileMap();
    for (const k of ["__proto__", "constructor"]) {
      assert.ok(Object.keys(map).includes(k), `fixture lost its own "${k}" key`);
    }
  });

  for (const key of ["__proto__", "constructor", "prototype"]) {
    test(`"${key}" is refused rather than written`, () => {
      assert.throws(() => writeIconEntry({}, key, "#ff0000", "icon-color"), /key must be/);
    });
  }

  test("a reserved name already IN the stored map does not survive a write", () => {
    // WHAT THIS REPLACED. The old version drove the setter with "__proto__" and
    // then asserted that no object anywhere had gained a key named `polluted`.
    // Nothing in this codebase writes that word, and the call throws before it
    // reaches an assignment anyway — so it was green with the guard deleted, and
    // green with the guard reintroduced. It could not fail.
    //
    // The reachable case is the map on the OTHER side. `current` comes off disk:
    // settings.json is JSON.parse'd, which keeps "__proto__" as an OWN key, and
    // a restored config snapshot is a file somebody uploaded. Assigned onto a
    // null-prototype target it becomes an ordinary own key, rides the spread
    // back out, and is written to settings.json again — a reserved name the app
    // then hands to every reader of the icon map.
    const out = writeIconEntry(hostileMap(), "display-2", "Tv", "icon-glyph");

    assert.deepEqual(
      Object.keys(out).filter((k) => FORBIDDEN.includes(k)),
      [],
      "a reserved key survived into the map that gets persisted",
    );
    assert.equal(out["display-1"], "Camera", "the legitimate entry was lost");
    assert.equal(out["display-2"], "Tv");
    // The payload's own word, read the way a later consumer would.
    assert.equal((out as Record<string, unknown>).polluted, undefined);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
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
