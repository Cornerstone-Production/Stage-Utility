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

import { HOST_FRAMED_TYPES, LAYOUT_OBJECTS, defaultStyleFor } from "./layout-objects.js";

/** Content whose box is drawn for it, or that is deliberately full-bleed. */
const BARE = [
  // Media — the picture IS the object.
  "image", "brand-logo", "slide-thumbnail", "ndi-video",
  // Full-bleed text on a stage display. A frame around every line is chrome
  // nobody asked for, and the operator's own layouts leave all of these bare.
  "text", "current-service-item", "next-service-item",
  "current-slide-text", "next-slide-text", "current-slide-notes", "transcript-strip",
  // Draws its own grid of tiles; a card around a grid of cards is noise.
  "slots-grid",
  // Home's cards. They used to draw their own frame — hence bare — and now draw
  // none at all, because Home's GRID draws one tile frame for everything on it.
  // A card here would be a second box inside that tile, and its padding would
  // inset a newly added widget further than one added before the change.
  "home-readiness", "home-next-service", "home-live-status", "home-recent-services",
  "home-recording", "home-recording-obs", "home-recording-reaper", "home-spl", "home-screens",
  "home-streaming", "home-streaming-resi", "home-streaming-youtube",
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
    assert.equal(all.length, 54);
    assert.equal(all.filter(hasCard).length, 29);
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

// ── The same widget, two destinations ──────────────────────────────────────
// A Resi status dropped on a wall sat there with no edge at all, beside a REAPER
// status wearing a card. They are the same kind of widget and read as two
// different components.
//
// The BARE list above is right, and is why: Home's grid draws one tile frame
// around everything on it, so a card there is a second box inside that tile. But
// the palette offers these on a custom layout too, where nothing draws a frame.
//
// The frame belongs to the DESTINATION, not to the widget, so the default has to
// know which surface it is being added to.

describe("a Home tile added somewhere that is not Home", () => {
  const chrome = (s: Record<string, unknown>) =>
    ["background", "borderColor", "cornerRadius"].some((k) => s[k] != null);

  test("wears a card, so it matches the widget beside it", () => {
    for (const t of HOST_FRAMED_TYPES) {
      const s = defaultStyleFor(t as never, { hostDrawsFrame: false }) as Record<string, unknown>;
      assert.ok(chrome(s), `${t} is still bare on a custom layout`);
    }
  });

  test("and stays bare on Home, where the grid already frames it", () => {
    for (const t of HOST_FRAMED_TYPES) {
      const s = defaultStyleFor(t as never, { hostDrawsFrame: true }) as Record<string, unknown>;
      assert.ok(!chrome(s), `${t} would draw a second box inside its Home tile`);
    }
  });

  test("a Resi status and a REAPER status end up wearing the same card", () => {
    // The actual report, as an assertion. reaper-status was never host-framed,
    // so it is the fixed point both must agree with.
    const resi = defaultStyleFor("home-streaming-resi", { hostDrawsFrame: false }) as Record<string, unknown>;
    const youtube = defaultStyleFor("home-streaming-youtube", { hostDrawsFrame: false }) as Record<string, unknown>;
    const reaper = defaultStyleFor("reaper-status", { hostDrawsFrame: false }) as Record<string, unknown>;
    for (const k of ["background", "borderColor", "borderWidth", "cornerRadius"]) {
      assert.equal(resi[k], reaper[k], `Resi's ${k} differs from REAPER's`);
      assert.equal(youtube[k], reaper[k], `YouTube's ${k} differs from REAPER's`);
    }
  });

  test("every widget that wears a card wears the SAME card", () => {
    // One hairline, one ground, one radius. Three widgets on a wall had three
    // different edges before this.
    const grounds = new Set<unknown>(), borders = new Set<unknown>(), widths = new Set<unknown>(), radii = new Set<unknown>();
    for (const t of Object.keys(LAYOUT_OBJECTS)) {
      // A shape's fill IS the object -- a blue rectangle is not a blue card, and
      // holding it to the card's ground would make every shape black.
      if (t === "shape") continue;
      const s = defaultStyleFor(t as never, { hostDrawsFrame: false }) as Record<string, unknown>;
      if (!chrome(s)) continue;
      grounds.add(s.background); borders.add(s.borderColor); widths.add(s.borderWidth); radii.add(s.cornerRadius);
    }
    assert.deepEqual([...grounds], ["#000000"], "more than one card ground");
    assert.deepEqual([...borders], ["rgba(255,255,255,0.1)"], "more than one border colour");
    assert.deepEqual([...widths], [1 / 1080], "more than one hairline width");
    assert.deepEqual([...radii], [0.0148], "more than one corner radius");
  });
});
