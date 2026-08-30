import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  COLUMNS,
  SIZES,
  SIZE_ORDER,
  addCard,
  defaultSize,
  removeCard,
  setSize,
  setWhen,
  sizeOf,
  visibleCards,
  whenOf,
} from "./home-cards.js";
import { LAYOUT_OBJECTS } from "../../main/layout-objects.js";
import type { HomeCardSize, LayoutObject } from "@main/types/views";

/** A card, with the geometry Home ignores. */
const card = (id: string, type: string, size?: HomeCardSize, when?: string) =>
  ({
    id, x: 0, y: 0, w: 1, h: 1, z: 1,
    config: { type },
    style: {},
    ...(size || when ? { home: { ...(size ? { size } : {}), ...(when ? { when } : {}) } } : {}),
  }) as unknown as LayoutObject;

describe("the four tiles", () => {
  test("every size is a whole number of columns, and none is wider than the grid", () => {
    for (const s of SIZE_ORDER) {
      assert.equal(SIZES[s].w, Math.round(SIZES[s].w));
      assert.ok(SIZES[s].w >= 1 && SIZES[s].w <= COLUMNS, `${s} is ${SIZES[s].w} of ${COLUMNS}`);
    }
  });

  test("they are the shapes that tile", () => {
    // THE arithmetic. S+M, S+L and S+S+S each fill a row exactly, and XL is a
    // row of its own. If any of these stops holding, the grid grows gaps that
    // nothing can fill and the whole model is worth revisiting.
    const w = (s: HomeCardSize) => SIZES[s].w;
    assert.equal(w("s") + w("m"), COLUMNS, "S + M must fill a row");
    assert.equal(w("s") + w("l"), COLUMNS, "S + L must fill a row");
    assert.equal(w("s") * 3, COLUMNS, "three Smalls must fill a row");
    assert.equal(w("xl"), COLUMNS, "XL must be the full width");
  });

  test("Small is 1x1, so every leftover slot is fillable", () => {
    // The property that stops a layout stranding a gap: whatever space is left,
    // a Small fits it.
    assert.deepEqual({ w: SIZES.s.w, h: SIZES.s.h }, { w: 1, h: 1 });
  });

  test("a Large leaves exactly two Smalls' worth of room beside it", () => {
    // The block that makes the grid read as composed rather than striped.
    const beside = (COLUMNS - SIZES.l.w) * SIZES.l.h;
    assert.equal(beside, 2 * (SIZES.s.w * SIZES.s.h));
  });

  test("two Mediums deliberately do NOT fit", () => {
    // Recorded because it is what the three-column grid gives up: two equal
    // halves side by side is not expressible. If someone "fixes" this, they have
    // changed the model and should mean to.
    assert.ok(SIZES.m.w * 2 > COLUMNS);
  });
});

describe("defaults", () => {
  test("a card with nothing set falls back to its type's size", () => {
    assert.equal(sizeOf(card("a", "clock")), defaultSize("clock"));
    assert.equal(sizeOf(card("a", "clock", "xl")), "xl");
  });

  test("every registry type has a size that exists", () => {
    // A typo in a spec would silently hand a widget an undefined tile.
    for (const t of Object.keys(LAYOUT_OBJECTS)) {
      assert.ok(SIZE_ORDER.includes(defaultSize(t)), `${t} has size "${defaultSize(t)}"`);
    }
  });

  test("a placed widget shows up unless its type says otherwise", () => {
    // Defaulting to "always" is what stops a widget somebody deliberately added
    // from being invisible for six days with no explanation.
    assert.equal(whenOf(card("a", "clock")), "always");
    assert.equal(whenOf(card("a", "home-live-status")), "live");
  });
});

describe("what is on the page", () => {
  const list = [
    card("a", "clock"),                       // always
    card("b", "home-live-status"),            // live
    card("c", "home-readiness"),              // idle
    card("d", "spl-meter", "s", "live"),
  ];

  test("during a service", () => {
    assert.deepEqual(visibleCards(list, "live").map((o) => o.id), ["a", "b", "d"]);
  });

  test("the rest of the week", () => {
    assert.deepEqual(visibleCards(list, "idle").map((o) => o.id), ["a", "c"]);
  });

  test("order is preserved — visibility filters, it does not sort", () => {
    const shown = visibleCards(list, "live");
    assert.deepEqual(shown.map((o) => o.id), ["a", "b", "d"]);
  });

  test("the card list cannot be computed from a mode nobody knows yet", () => {
    // A COMPILE-time guard, and the reason homeMode returns HomeModeOrUnknown
    // rather than defaulting to "idle": there is no filtering to be done before
    // the live channel has answered, so this call must not type-check. Widen
    // visibleCards to accept "unknown" and tsc fails on the unused directive,
    // which is the point — the flash on Home was a filtered grid built from a
    // mode that had not arrived.
    //
    // Runtime-asserted too, so this is a test rather than a bare comment: the
    // narrowing is what makes the cast below necessary in the first place.
    // @ts-expect-error "unknown" is not a HomeMode and must never be filterable
    const forced = visibleCards(list, "unknown");
    assert.deepEqual(forced.map((o) => o.id), ["a"]);
  });
});

describe("editing", () => {
  const base = [card("a", "clock"), card("b", "spl-meter")];

  test("adding puts the widget at the end, at its type's size", () => {
    const next = addCard(base, "home-readiness", "new");
    assert.equal(next.length, 3);
    assert.equal(next[2].id, "new");
    assert.equal(sizeOf(next[2]), defaultSize("home-readiness"));
  });

  test("adding gives the object a real config and style from the registry", () => {
    // Not a bare shell: a card added on Home must be the same object a canvas
    // would place, or the two surfaces are drawing different widgets.
    const o = addCard(base, "countdown-timer", "new")[2];
    assert.equal(o.config.type, "countdown-timer");
    assert.deepEqual(o.config, LAYOUT_OBJECTS["countdown-timer"].config());
    assert.deepEqual(o.style, LAYOUT_OBJECTS["countdown-timer"].style());
  });

  test("removing takes exactly one card", () => {
    assert.deepEqual(removeCard(base, "a").map((o) => o.id), ["b"]);
  });

  test("resizing changes only that card, and keeps its other placement", () => {
    const next = setSize(setWhen(base, "a", "live"), "a", "xl");
    assert.equal(sizeOf(next[0]), "xl");
    assert.equal(whenOf(next[0]), "live", "setting the size dropped the visibility");
    assert.equal(sizeOf(next[1]), sizeOf(base[1]));
  });

  test("nothing mutates its input", () => {
    const before = base.map((o) => o.id);
    addCard(base, "clock", "x"); removeCard(base, "a"); setSize(base, "a", "xl");
    assert.deepEqual(base.map((o) => o.id), before);
  });
});

