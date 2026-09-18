// The renderer half of main/types/extern-keyed.test.ts — read that file first.
//
// Same bug, same fix: a registry indexed by a string the process did not author
// hands back a TRUTHY prototype member for "constructor", "__proto__",
// "valueOf" and "toString", and every `?? fallback` under it stays unused
// because a function is not nullish. In here the keys come off views.json,
// bar-config.json and a GitHub release body, all of which reach the renderer
// through the server without being narrowed to the union the type claims.
//
// The tables are the REAL exports, imported and probed — not source text.
//
// Four more wrapped tables are module-private and NOT covered here, named so
// the omission is a decision rather than an oversight:
//
//   WALL_TWIN, PEOPLE_PANEL_LABELS  (renderer/main/layout-renderer.tsx)
//   KIND_LABELS                     (renderer/settings/sections/new-view-dialog.tsx)
//   SECTION_TONE                    (renderer/app/update-notices.tsx)
//
// All four live inside component modules that need the jsdom harness, and none
// is exported. WALL_TWIN is the one that mattered — `x.type in WALL_TWIN` is a
// TYPE GUARD, so a card typed "constructor" narrowed to a wall-twin type and
// then read `WALL_TWIN[c.type]`, handing a function to streamingReadout as the
// platform name. gate-render-parity.test.ts asserts that table is found and
// non-empty; the null prototype itself is asserted only by the wrap being
// there. The other three end in a CSS class or a label and are wrapped for
// uniformity, not because a crash was reachable through them.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LAYOUT_OBJECTS } from "./layout-objects";
import { SURFACE_PRESETS } from "../editor/object-surface";
import { RECORDER_FOR, STREAMER_FOR } from "../app/recording-status";
import { BAR_ITEMS } from "../app/bar-items";
import { SIZES, WHEN_LABELS } from "../app/home/home-cards";
import { defaultSize, defaultWhen, sizeOf, whenOf } from "../app/home/home-cards";
import { surfaceOf } from "../editor/object-surface";
import { pickedValue, togglesFor } from "../app/home/card-toggles";
import type { LayoutObject } from "@main/types/views";

/** The names JavaScript hands back for free on any object with a prototype. */
const INHERITED = [
  "constructor",
  "__proto__",
  "valueOf",
  "toString",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
];

/** Every wrapped table the renderer EXPORTS, under the name it has in its module. */
const EXPORTED: Record<string, object> = {
  LAYOUT_OBJECTS,
  SURFACE_PRESETS,
  STREAMER_FOR,
  RECORDER_FOR,
  BAR_ITEMS,
  SIZES,
  WHEN_LABELS,
};

/**
 * The names in EXPORTED, sorted, one per line. A count cannot tell a table
 * added and a table removed from no change at all, and a sorted list merges
 * cleanly when two branches each wrap a different table.
 */
const EXPECTED_TABLES = [
  "BAR_ITEMS",
  "LAYOUT_OBJECTS",
  "RECORDER_FOR",
  "SIZES",
  "STREAMER_FOR",
  "SURFACE_PRESETS",
  "WHEN_LABELS",
];

describe("renderer tables keyed from outside this process", () => {
  it("covers exactly the exported ones", () => {
    // Not a floor, and not a bare count. Change this only alongside the list
    // above, having decided whether the new table's keys arrive off disk or off
    // HTTP.
    assert.deepEqual(
      Object.keys(EXPORTED).sort(),
      EXPECTED_TABLES,
      "a table was added or removed; update EXPECTED_TABLES deliberately",
    );
  });

  for (const [name, table] of Object.entries(EXPORTED)) {
    it(`${name} answers nothing for an inherited member name`, () => {
      const t = table as Record<string, unknown>;
      for (const key of INHERITED) {
        assert.equal(
          t[key],
          undefined,
          `${name}["${key}"] answered with a prototype member, which every ` +
            "`?? fallback` downstream leaves unused because a function is not nullish",
        );
        assert.equal(key in t, false, `"${key}" in ${name} — an \`in\` test passes on it`);
      }
    });

    it(`${name} still answers for its own keys`, () => {
      // So the case above cannot pass by the table being empty or broken.
      const keys = Object.keys(table);
      assert.ok(keys.length > 0, `${name} has no entries at all`);
      for (const k of keys) {
        assert.notEqual(
          (table as Record<string, unknown>)[k],
          undefined,
          `${name}["${k}"] vanished`,
        );
      }
    });
  }
});

/** A saved card, the way one arrives out of views.json. */
const card = (config: Record<string, unknown>, home?: Record<string, unknown>): LayoutObject =>
  ({ id: "o1", x: 0, y: 0, w: 0.2, h: 0.2, config, ...(home ? { home } : {}) }) as LayoutObject;

describe("renderer lookups driven with a key off a saved layout", () => {
  it("a card typed with a prototype member gets the DEFAULT size and visibility", () => {
    // LAYOUT_OBJECTS, through home-cards. `?.homeSize ?? "m"` already read
    // undefined off the Object function, so these were right by luck; the case
    // that was not is sizeOf/whenOf below, which read the SIZES table directly.
    for (const type of INHERITED) {
      assert.equal(defaultSize(type), "m", `defaultSize("${type}")`);
      assert.equal(defaultWhen(type), "always", `defaultWhen("${type}")`);
    }
    assert.equal(defaultSize("clock"), "s");
  });

  it("a saved size that is a prototype member has real geometry", () => {
    // SIZES. `const { w, h } = SIZES[sizeOf(o)]` fed NaN into the Home grid.
    for (const size of INHERITED) {
      const s = sizeOf(card({ type: "clock" }, { size }));
      assert.ok(
        (SIZES as Record<string, { w: number } | undefined>)[s] === undefined ||
          Number.isFinite(SIZES[s].w),
        `a saved size of "${size}" resolved to ${JSON.stringify(s)} with no width`,
      );
      assert.equal(
        (SIZES as Record<string, unknown>)[size],
        undefined,
        `SIZES["${size}"] is still answerable`,
      );
    }
    assert.equal(SIZES[sizeOf(card({ type: "clock" }, { size: "l" }))].w, 2);
  });

  it("a saved visibility that is a prototype member has no label", () => {
    // WHEN_LABELS.
    for (const when of INHERITED) {
      assert.equal(
        (WHEN_LABELS as Record<string, unknown>)[whenOf(card({ type: "clock" }, { when }))],
        undefined,
        `a saved visibility of "${when}" found a label`,
      );
    }
    assert.equal(WHEN_LABELS[whenOf(card({ type: "clock" }, { when: "live" }))], "During a service");
  });

  it("a saved surface that is a prototype member is CLASSIFIED, not believed", () => {
    // SURFACE_PRESETS. `if (s.surface && SURFACE_PRESETS[s.surface]) return s.surface`
    // returned "constructor" as a SurfaceKind.
    for (const surface of INHERITED) {
      const k = surfaceOf({ surface } as never);
      assert.notEqual(k, surface, `surfaceOf believed a stored surface of "${surface}"`);
      assert.ok(["glass", "solid", "outline", "flat"].includes(k), `surfaceOf answered ${k}`);
    }
    assert.equal(surfaceOf({ surface: "glass" } as never), "glass");
  });

  it("a card typed with a prototype member supports no toggles and no picks", () => {
    // The `in` tests in card-toggles.ts, which walked the prototype: a card
    // typed "toString" claimed every picked setting and every toggle.
    for (const type of INHERITED) {
      assert.equal(pickedValue(card({ type }), "recorder"), null, `pickedValue for "${type}"`);
      assert.deepEqual(togglesFor(card({ type })), [], `togglesFor for "${type}"`);
    }
    // Real cards still answer, so this is not passing by refusing everything.
    assert.equal(pickedValue(card({ type: "home-recording" }), "recorder"), "any");
    assert.ok(togglesFor(card({ type: "clock" })).length > 0);
  });

  it("a bar item id that is a prototype member is not an item", () => {
    // BAR_ITEMS, indexed straight off bar-config.json in bar-configurator.tsx.
    for (const id of INHERITED) {
      assert.equal((BAR_ITEMS as Record<string, unknown>)[id], undefined, `BAR_ITEMS["${id}"]`);
    }
  });
});
