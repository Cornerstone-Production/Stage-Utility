import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  HOME_CARD_TYPES,
  cardOrder,
  cardRows,
  isHomeCard,
  reorderCards,
  toggleCard,
  visibleCards,
} from "./home-cards.js";
import { LAYOUT_OBJECTS } from "../../main/layout-objects.js";

/** A layout object with the geometry Home ignores, so a test that depended on it
 *  would be depending on nonsense. */
const obj = (type: string, id = type) =>
  ({ id, x: 0, y: 0, w: 1, h: 1, z: 1, config: { type }, style: {} }) as never;

const DEFAULT = [
  obj("home-live-status"),
  obj("home-next-service"),
  obj("home-readiness"),
  obj("home-recent-services"),
];

describe("one widget set", () => {
  test("every Home card is a type in the shared registry", () => {
    // A Home-only card would be the beginning of two widget sets: one for the
    // front page and one for everything else, drifting apart card by card.
    // Phase 6 exists specifically to prevent that.
    for (const t of HOME_CARD_TYPES) {
      assert.ok(t in LAYOUT_OBJECTS, `${t} is a Home card but not a registry object`);
    }
  });

  test("each carries the registry's own label, not a second copy", () => {
    for (const row of cardRows(DEFAULT)) {
      assert.equal(row.label, LAYOUT_OBJECTS[row.type].label);
    }
  });
});

describe("order and presence", () => {
  test("cards render in the layout's array order", () => {
    const flipped = [obj("home-readiness"), obj("home-next-service")];
    assert.deepEqual(cardOrder(flipped), ["home-readiness", "home-next-service"]);
  });

  test("a card that is not in the layout is not on the page", () => {
    assert.deepEqual(cardOrder([obj("home-next-service")]), ["home-next-service"]);
  });

  test("a duplicate renders once", () => {
    // Two objects of one type would draw the same card twice and give the editor
    // two switches that fight each other.
    const dup = [obj("home-readiness", "a"), obj("home-readiness", "b")];
    assert.deepEqual(cardOrder(dup), ["home-readiness"]);
  });

  test("live and idle cards do not appear together", () => {
    // The behaviour the two fixed panels had. A running timer is noise on a
    // Thursday, and a readiness checklist is noise mid-service.
    assert.deepEqual(visibleCards(DEFAULT, "live"), ["home-live-status"]);
    assert.deepEqual(visibleCards(DEFAULT, "idle"), [
      "home-next-service",
      "home-readiness",
      "home-recent-services",
    ]);
  });

  test("every card belongs to exactly one mood, so none is unreachable", () => {
    const shown = new Set([...visibleCards(DEFAULT, "live"), ...visibleCards(DEFAULT, "idle")]);
    assert.deepEqual([...shown].sort(), [...HOME_CARD_TYPES].sort());
  });
});

describe("the editor's rows", () => {
  test("switched-off cards are listed too", () => {
    // An editor that only shows what is already there gives you no way to put
    // something back, which turns "hide" into "delete".
    const rows = cardRows([obj("home-readiness")]);
    assert.equal(rows.length, HOME_CARD_TYPES.length);
    assert.deepEqual(
      rows.map((r) => r.present),
      [true, false, false, false],
    );
  });

  test("present cards come first, in their stored order", () => {
    const rows = cardRows([obj("home-recent-services"), obj("home-next-service")]);
    assert.deepEqual(
      rows.filter((r) => r.present).map((r) => r.type),
      ["home-recent-services", "home-next-service"],
    );
  });
});

describe("toggling", () => {
  test("off removes the card", () => {
    const next = toggleCard(DEFAULT, "home-readiness");
    assert.ok(!cardOrder(next).includes("home-readiness"));
  });

  test("on appends it at the end, where a new thing belongs", () => {
    const without = toggleCard(DEFAULT, "home-readiness");
    assert.deepEqual(cardOrder(toggleCard(without, "home-readiness")), [
      "home-live-status",
      "home-next-service",
      "home-recent-services",
      "home-readiness",
    ]);
  });

  test("off then on leaves every OTHER card exactly where it was", () => {
    const round = toggleCard(toggleCard(DEFAULT, "home-live-status"), "home-live-status");
    assert.deepEqual(
      cardOrder(round).filter((t) => t !== "home-live-status"),
      cardOrder(DEFAULT).filter((t) => t !== "home-live-status"),
    );
  });

  test("the input is not mutated", () => {
    const before = cardOrder(DEFAULT);
    toggleCard(DEFAULT, "home-readiness");
    assert.deepEqual(cardOrder(DEFAULT), before);
  });
});

describe("reordering", () => {
  test("moves a card down", () => {
    assert.deepEqual(cardOrder(reorderCards(DEFAULT, 0, 2)), [
      "home-next-service",
      "home-readiness",
      "home-live-status",
      "home-recent-services",
    ]);
  });

  test("moves a card up", () => {
    assert.deepEqual(cardOrder(reorderCards(DEFAULT, 3, 0)), [
      "home-recent-services",
      "home-live-status",
      "home-next-service",
      "home-readiness",
    ]);
  });

  test("an out-of-range index changes nothing", () => {
    // A drag that ends on nothing is a no-op, not an exception that blanks the
    // page it was dropped on.
    assert.deepEqual(cardOrder(reorderCards(DEFAULT, 0, 9)), cardOrder(DEFAULT));
    assert.deepEqual(cardOrder(reorderCards(DEFAULT, -1, 0)), cardOrder(DEFAULT));
  });

  test("objects keep their identity — this reorders, it does not recreate", () => {
    // A recreated object would take a fresh id, and anything keyed on that id
    // (a per-object note, a preset) would quietly lose its association.
    const moved = reorderCards(DEFAULT, 0, 1);
    for (const o of moved) {
      assert.ok(
        DEFAULT.some((d) => d === o),
        "an object was rebuilt rather than moved",
      );
    }
  });
});

describe("objects Home does not draw", () => {
  // Home has no canvas, so nothing can add one now — but a restored snapshot
  // could carry one, and deleting an operator's data to tidy something up is
  // never this code's call. They are skipped when rendering and otherwise left
  // exactly where they are.
  const stray = (objs: readonly unknown[]) =>
    (objs as { config: { type: string } }[]).filter((o) => !isHomeCard(o.config.type)).length;

  test("are not drawn", () => {
    assert.deepEqual(cardOrder([...DEFAULT, obj("clock")]), cardOrder(DEFAULT));
    assert.equal(isHomeCard("clock"), false);
  });

  test("survive a reorder", () => {
    assert.equal(stray(reorderCards([...DEFAULT, obj("clock")], 0, 1)), 1);
  });

  test("survive a toggle", () => {
    assert.equal(stray(toggleCard([...DEFAULT, obj("clock")], "home-readiness")), 1);
  });

  test("a duplicate card object is kept too, not quietly deleted", () => {
    // cardOrder draws one of each, which is right. Reordering used to DELETE the
    // extra while doing it — silent data loss on the operator's first drag, for
    // a state a restored snapshot can produce.
    const dup = [...DEFAULT, obj("home-readiness", "second-copy")];
    const after = reorderCards(dup, 0, 1);
    assert.equal(after.length, dup.length, "an object went missing");
    assert.ok(after.some((o) => (o as { id: string }).id === "second-copy"));
  });
});
