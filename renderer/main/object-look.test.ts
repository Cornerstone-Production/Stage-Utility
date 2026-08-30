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
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { HOST_FRAMED_TYPES, LAYOUT_OBJECTS, defaultStyle, defaultStyleFor } from "./layout-objects.js";

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
    assert.equal(all.length, 55);
    assert.equal(all.filter(hasCard).length, 30);
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
    // #141414, not #000000: the canvas grounds at #0a0a0a, so a pure-black card
    // is darker than the surface it sits on and stops reading as a card at all.
    assert.deepEqual([...grounds], ["#141414"], "more than one card ground");
    assert.deepEqual([...borders], ["rgba(255,255,255,0.1)"], "more than one border colour");
    assert.deepEqual([...widths], [1 / 1080], "more than one hairline width");
    assert.deepEqual([...radii], [0.0148], "more than one corner radius");
  });
});

// ── A card has to be lighter than the ground it sits on ────────────────────
// "Default should be fill with black" was asked for and taken literally, and it
// made the editor look blank. The stage canvas grounds at #0a0a0a, so a #000000
// card is DARKER than the surface under it: it stops reading as a card and
// starts reading as a hole cut in the canvas, and a layout full of them reads as
// nothing at all. Measured in a browser on a real layout -- every card ground
// now lands +10 or more against the canvas's luminance of 10.0.
//
// #141414 IS the black a card can be here. The rule is not "not black", it is
// "lighter than what is behind it", so this compares rather than pins.

describe("the card ground against the canvas it sits on", () => {
  /** What a bare stage canvas grounds at — see KIOSK_SURFACE in styles.css. */
  const CANVAS = 0x0a;
  const luminance = (hex: string) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return null;
    const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
    return r * 0.299 + g * 0.587 + b * 0.114;
  };

  test("is lighter than the canvas, or it is a hole and not a card", () => {
    const floor = CANVAS * 0.299 + CANVAS * 0.587 + CANVAS * 0.114;
    for (const t of Object.keys(LAYOUT_OBJECTS)) {
      if (t === "shape") continue; // a shape's fill IS the object
      const s = defaultStyleFor(t as never, { hostDrawsFrame: false }) as Record<string, unknown>;
      const bg = typeof s.background === "string" ? s.background : null;
      if (!bg || !bg.startsWith("#")) continue;
      const l = luminance(bg);
      assert.ok(l != null, `${t}: unreadable ground ${bg}`);
      assert.ok(l > floor, `${t}: ${bg} is not lighter than the #0a0a0a canvas — it will read as a hole`);
    }
  });
});

// ── The two lists that have to agree ───────────────────────────────────────
// HOST_FRAMED_TYPES (source) and the home-* half of BARE (this file) describe
// the same set from two directions: BARE says these ship with no card, and
// HOST_FRAMED_TYPES says the reason is that Home frames them itself.
//
// BARE has an exact-count guard, so a new Home widget has to be listed there.
// Nothing forced adding it to HOST_FRAMED_TYPES, and the one that got missed
// would land naked on a wall again — the exact bug that set exists to fix.

describe("HOST_FRAMED_TYPES and BARE", () => {
  test("name the same Home widgets, so neither can be updated alone", () => {
    const bareHome = new Set([...BARE].filter((t) => t.startsWith("home-")));
    assert.deepEqual(
      [...HOST_FRAMED_TYPES].sort(),
      [...bareHome].sort(),
      "a Home widget is in one list and not the other",
    );
  });
});

// ── defaultStyleFor is defaultStyle plus a destination ─────────────────────
// It read the registry directly for one release and quietly dropped both of the
// jobs defaultStyle does: stripping the `textAlign` that TEXT() writes but
// nobody chose, and surviving a type this build does not know. makeObject and
// resetLook had both moved onto it, so every readout added in the editor stored
// textAlign:"center" permanently, and Reset look on an object from a newer
// build threw inside setObjects and white-screened the page.

describe("defaultStyleFor", () => {
  test("strips the alignment nobody chose, exactly as defaultStyle does", () => {
    for (const t of Object.keys(LAYOUT_OBJECTS)) {
      const via = defaultStyleFor(t as never, { hostDrawsFrame: false }) as Record<string, unknown>;
      const plain = defaultStyle(t as never) as Record<string, unknown>;
      assert.equal(via.textAlign, plain.textAlign, `${t}: alignment differs from defaultStyle`);
    }
  });

  test("returns a style for a type this build has never heard of", () => {
    // A views.json written by a newer build, restored onto this one.
    assert.doesNotThrow(() => defaultStyleFor("a-type-from-the-future" as never, { hostDrawsFrame: false }));
    assert.doesNotThrow(() => defaultStyleFor("a-type-from-the-future" as never, { hostDrawsFrame: true }));
  });
});

// ── Every add path, not three of four ──────────────────────────────────────
// The destination argument reached three of the four makeObject call sites. The
// one it missed is the draw-a-rectangle palette, which on Home offers the
// host-framed types — so a widget added that way got a card inside Home's own
// tile frame. Fixing a repeated shape in all but one of its places is the
// mistake CLAUDE.md names as this repo's most expensive.
//
// Source text, because the alternative is mounting the editor, and what has to
// hold is a property of the CALL SITES rather than of any one render.

describe("the editor's add paths", () => {
  test("every makeObject call passes the destination", () => {
    const src = readFileSync(new URL("../editor/layout-editor.tsx", import.meta.url), "utf8");
    const calls = [...src.matchAll(/\bmakeObject\((?!\s*$)[^;]*?\)/gs)]
      .map((m) => m[0].replace(/\s+/g, " "))
      // the declaration itself is `function makeObject(`, not a call
      .filter((c) => !/^makeObject\(\s*type: /.test(c));
    assert.ok(calls.length >= 4, `expected every add path, found ${calls.length}`);
    for (const c of calls) {
      assert.match(c, /HOME_VIEW_ID/, `a makeObject call decides the frame by default: ${c}`);
    }
  });
});
