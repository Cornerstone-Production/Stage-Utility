import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { screenFromQuery, describeScreen, mergeScreen, sameScreen } from "./kiosk-screen-size.js";

// These numbers arrive on a URL over plain HTTP from anything on the LAN, and
// they end up rendered on a card and on a wall-mounted holding screen. So the
// parse is total and the phrasing has to survive each half being absent.

const q = (s: string) => screenFromQuery(new URLSearchParams(s));

describe("a size off a query string", () => {
  test("reads what a browser reports", () => {
    assert.deepEqual(q("w=1920&h=1080&dpr=2"), { w: 1920, h: 1080, dpr: 2 });
  });

  test("a missing dpr is dropped rather than defaulted to a lie", () => {
    assert.deepEqual(q("w=1920&h=1080"), { w: 1920, h: 1080, dpr: undefined });
  });

  test("fractional CSS pixels are rounded, not printed as 1707.5", () => {
    assert.deepEqual(q("w=1707.5&h=960.5&dpr=1.5"), { w: 1708, h: 961, dpr: 1.5 });
  });

  test("junk is rejected instead of rendering as NaN on the wall", () => {
    for (const bad of ["", "w=abc&h=1080", "w=1920", "w=0&h=0", "w=-1920&h=1080", "w=99999&h=1080"]) {
      assert.equal(q(bad), null, `"${bad}" was accepted`);
    }
  });

  test("an absurd dpr is dropped but the size is kept", () => {
    assert.deepEqual(q("w=1920&h=1080&dpr=9000"), { w: 1920, h: 1080, dpr: undefined });
  });
});

describe("phrasing a size", () => {
  test("nothing known prints nothing, so the field can be dropped", () => {
    assert.equal(describeScreen(undefined), "");
  });

  test("CSS pixels alone", () => {
    assert.equal(describeScreen({ w: 1920, h: 1080 }), "1920 × 1080");
  });

  test("a mode matching the layout is not said twice", () => {
    assert.equal(describeScreen({ w: 1920, h: 1080, mode: "1920x1080" }), "1920 × 1080");
  });

  test("a disagreement is the interesting part and is shown", () => {
    // The scaled-desktop case: a 1080p panel laying out at 720p.
    assert.equal(
      describeScreen({ w: 1280, h: 720, mode: "1920x1080" }),
      "1280 × 720 (driving 1920 × 1080)",
    );
  });

  test("a mode with no browser size still says something", () => {
    // A Linux device heard over UDP that has not loaded the holding screen yet.
    assert.equal(describeScreen({ w: 0, h: 0, mode: "1920x1080" }), "driving 1920 × 1080");
  });
});

// Every write of a screen size goes through mergeScreen. It was hand-rolled at
// four call sites before this existed, and the four had drifted three ways —
// which is what these pin.
describe("merging what two sources know", () => {
  test("the probe's mode joins the browser's size instead of replacing it", () => {
    assert.deepEqual(
      mergeScreen({ w: 1280, h: 720, dpr: 1.5 }, { w: 0, h: 0, mode: "1920x1080" }),
      { w: 1280, h: 720, dpr: 1.5, mode: "1920x1080" },
    );
  });

  test("a zero from the probe does not zero a known size", () => {
    // The probe fills w/h with 0 to satisfy the type — it has no way to know
    // them. Treating 0 as a value blanks the card.
    assert.deepEqual(mergeScreen({ w: 1920, h: 1080 }, { w: 0, h: 0 }), { w: 1920, h: 1080 });
  });

  test("an explicit dpr: undefined does not erase a known dpr", () => {
    // screenFrom ALWAYS emits the dpr key, so a plain object spread let a device
    // that reported no dpr wipe one already recorded. This is the drift.
    assert.deepEqual(
      mergeScreen({ w: 1920, h: 1080, dpr: 2 }, { w: 1280, h: 720, dpr: undefined }),
      { w: 1280, h: 720, dpr: 2 },
    );
  });

  test("nothing known on either side stays nothing", () => {
    assert.equal(mergeScreen(undefined, undefined), undefined);
  });

  test("a merged size has no undefined keys, so it compares equal to a fresh one", () => {
    // Otherwise every sameScreen and every JSON round-trip disagrees with itself.
    assert.deepEqual(Object.keys(mergeScreen(undefined, { w: 800, h: 600 })!).sort(), ["h", "w"]);
  });
});

describe("deciding whether a size is worth writing", () => {
  test("identical sizes are the same", () => {
    assert.equal(sameScreen({ w: 1920, h: 1080, mode: "x" }, { w: 1920, h: 1080, mode: "x" }), true);
  });

  test("a changed mode counts, so a re-plugged screen broadcasts", () => {
    assert.equal(sameScreen({ w: 1920, h: 1080 }, { w: 1920, h: 1080, mode: "1920x1080" }), false);
  });

  test("both absent is the same, so an unknown size is not a change every probe", () => {
    assert.equal(sameScreen(undefined, undefined), true);
  });
});
