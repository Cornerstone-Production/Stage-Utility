// Does a freshly-added widget look like part of a dashboard, or like nothing?
//
// Half the readouts shipped in a card and half did not, for no reason anyone
// could state, so the operator dressed the second half by hand — the SAME
// background, hairline and radius, applied to thirteen different object types
// across four real layouts. That is a missing default.
//
// So this pins the partition EXACTLY. A new object type lands in neither list
// and fails, which forces somebody to decide which side it is on rather than
// inheriting whichever helper was nearest.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { LAYOUT_OBJECTS } from "./layout-objects.js";

/** Content that paints its own box, or is deliberately full-bleed. */
const BARE = [
  // Media — the picture IS the object.
  "image", "brand-logo", "slide-thumbnail", "ndi-video",
  // Full-bleed text on a stage display. A frame around every line is chrome
  // nobody asked for, and the operator's own layouts leave all of these bare.
  "text", "current-service-item", "next-service-item",
  "current-slide-text", "next-slide-text", "current-slide-notes", "transcript-strip",
  // Draws its own grid of tiles; a card around a grid of cards is noise.
  "slots-grid",
  // Home's cards draw their own frame — a default card would double-frame them.
  "home-readiness", "home-next-service", "home-live-status", "home-recent-services",
  "home-recording", "home-recording-obs", "home-recording-reaper", "home-spl", "home-screens",
  // Retired, and left exactly as it shipped.
  "service-order",
] as const;

const hasCard = (t: string) => {
  const s = LAYOUT_OBJECTS[t as keyof typeof LAYOUT_OBJECTS].style() as Record<string, unknown>;
  return ["background", "borderColor", "cornerRadius"].some((k) => s[k] != null);
};

describe("a widget you just added", () => {
  test("sits in a card unless it paints its own box", () => {
    const bare = new Set<string>(BARE);
    const wrong: string[] = [];
    for (const t of Object.keys(LAYOUT_OBJECTS)) {
      if (bare.has(t) === hasCard(t)) wrong.push(`${t} should be ${bare.has(t) ? "bare" : "carded"}`);
    }
    assert.deepEqual(wrong, []);
  });

  test("the split is exact, so a new type cannot default by accident", () => {
    // A floor with slack is how three config stores went missing from every
    // backup with the suite green. When this fails, decide the new type's side
    // and add it here or to BARE — do not bump the number.
    const all = Object.keys(LAYOUT_OBJECTS);
    assert.equal(all.length, 50);
    assert.equal(all.filter(hasCard).length, 28);
    assert.equal(all.filter((t) => !hasCard(t)).length, BARE.length);
  });

  test("every name in BARE is a real type", () => {
    // Otherwise a typo silently moves a widget to the carded side while the
    // list above still claims otherwise.
    for (const t of BARE) assert.ok(t in LAYOUT_OBJECTS, `${t} is not an object type`);
  });
});

describe("slide text reads from the back of the room", () => {
  test("the current slide, the next slide and the notes are all caps", () => {
    // Caps sit level, so consecutive lines do not jump in height as the words
    // change — which is the whole job of a stage display.
    for (const t of ["current-slide-text", "next-slide-text", "current-slide-notes"] as const) {
      assert.equal((LAYOUT_OBJECTS[t].style() as { uppercase?: boolean }).uppercase, true, `${t} is not uppercase`);
    }
  });

  test("and they stay bare — caps was the only change", () => {
    for (const t of ["current-slide-text", "next-slide-text", "current-slide-notes"] as const) {
      assert.equal(hasCard(t), false, `${t} gained a card it should not have`);
    }
  });
});
