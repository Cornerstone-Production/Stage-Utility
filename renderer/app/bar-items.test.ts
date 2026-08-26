import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  BAR_ITEMS,
  BAR_SPACE,
  BAR_SPACE_ITEM,
  BAR_SPACER,
  BAR_SPACER_ITEM,
  DEFAULT_BAR_ORDER,
  isBarGap,
  normalizeBarRows,
  visibleBarItems,
} from "./bar-items.js";

// Exhaustiveness is the COMPILER's job: BAR_ITEMS is Record<BarItemId, BarItem>,
// so a new id without an entry fails tsc. The design doc singles that out
// because this becomes another place a new integration has to register itself,
// and source-scanning guards here have repeatedly passed while missing entries.
//
// These cover what the type system cannot: that a saved config from another
// build cannot produce a broken bar.

describe("the bar registry", () => {
  test("every item describes itself for the configurator", () => {
    // A palette tile with no hint is a choice made blind.
    for (const [id, item] of Object.entries(BAR_ITEMS)) {
      assert.equal(item.id, id, `${id} disagrees with its key`);
      assert.ok(item.label.length > 0, `${id} has no label`);
      assert.ok(item.hint.length > 10, `${id} has no useful hint`);
    }
  });

  test("both gaps describe themselves too", () => {
    // Neither is in BAR_ITEMS, so the loop above cannot cover them — and they
    // are the palette tiles whose purpose is least obvious from the name.
    for (const gap of [BAR_SPACER_ITEM, BAR_SPACE_ITEM]) {
      assert.ok(gap.label.length > 0);
      assert.ok(gap.hint.length > 10);
    }
    assert.notEqual(BAR_SPACER_ITEM.label, BAR_SPACE_ITEM.label, "two tiles named the same");
  });

  test("the default is the bar as it shipped", () => {
    // plan on the left; the current item and the timer on the right.
    assert.deepEqual(DEFAULT_BAR_ORDER, ["plan", "spacer", "current-item", "live-timer"]);
    assert.ok(!DEFAULT_BAR_ORDER.includes("recording"), "recording is opt-in");
    assert.ok(!DEFAULT_BAR_ORDER.includes("integration-health"), "health is opt-in");
  });

  test("every default item exists in the registry", () => {
    for (const id of DEFAULT_BAR_ORDER) {
      if (isBarGap(id)) continue;
      assert.ok(BAR_ITEMS[id], `default names ${id}, which is not a registered item`);
    }
  });
});

describe("visibleBarItems", () => {
  test("keeps the operator's order and their spacers", () => {
    assert.deepEqual(
      visibleBarItems(["clock", BAR_SPACER, "recording"]),
      ["clock", "spacer", "recording"],
    );
  });

  test("keeps TWO spacers, which is how a group gets centred", () => {
    // The arrangement the single-split model could not express at all: slack
    // shared equally either side of the clock.
    assert.deepEqual(
      visibleBarItems(["plan", BAR_SPACER, "clock", BAR_SPACER, "recording"]),
      ["plan", "spacer", "clock", "spacer", "recording"],
    );
  });

  test("collapses adjacent spacers", () => {
    // Two in a row divide the slack between two points that are the same point,
    // so the second only pads the saved order.
    assert.deepEqual(
      visibleBarItems(["clock", BAR_SPACER, BAR_SPACER, "recording"]),
      ["clock", "spacer", "recording"],
    );
  });

  test("reads the name the spacer had before it could repeat", () => {
    // Written by an earlier build of this branch. Dropping it would silently
    // left-align a bar its operator had arranged.
    assert.deepEqual(visibleBarItems(["clock", "split", "recording"]), ["clock", "spacer", "recording"]);
  });

  test("skips an id this build does not have", () => {
    // A downgrade, or an integration removed. A hole in the bar is worse than a
    // shorter bar, and rendering an unknown id would be a hole.
    assert.deepEqual(
      visibleBarItems(["clock", "stream-status", BAR_SPACER, "recording"]),
      ["clock", "spacer", "recording"],
    );
  });

  test("falls back to the default rather than rendering an empty bar", () => {
    // A bar showing nothing reads as broken, not as configured.
    assert.deepEqual(visibleBarItems([]), DEFAULT_BAR_ORDER);
    assert.deepEqual(visibleBarItems(undefined), DEFAULT_BAR_ORDER);
    // A saved order that is nothing BUT spacers is still an empty bar.
    assert.deepEqual(visibleBarItems([BAR_SPACER, BAR_SPACER]), DEFAULT_BAR_ORDER);
  });

  test("falls back when every saved id is unknown", () => {
    // The realistic downgrade: a config written by a much newer build.
    assert.deepEqual(visibleBarItems(["nope", "also-nope"]), DEFAULT_BAR_ORDER);
  });
});

describe("the fixed gap", () => {
  test("survives a round trip like any other row", () => {
    assert.deepEqual(
      visibleBarItems(["clock", BAR_SPACE, "plan", BAR_SPACER, "recording"]),
      ["clock", "space", "plan", "spacer", "recording"],
    );
  });

  test("two in a row are KEPT — that is how you ask for a wider gap", () => {
    // The flexible one collapses because two of it divide the slack at one
    // point. Two fixed gaps are twice the distance, which is a real request.
    assert.deepEqual(
      visibleBarItems(["clock", BAR_SPACE, BAR_SPACE, "plan", BAR_SPACER]),
      ["clock", "space", "space", "plan", "spacer"],
    );
  });

  test("collapsing still applies to the flexible one beside it", () => {
    assert.deepEqual(
      visibleBarItems(["clock", BAR_SPACER, BAR_SPACER, BAR_SPACE, "plan"]),
      ["clock", "spacer", "space", "plan"],
    );
  });

  test("a bar of nothing but gaps is still an empty bar", () => {
    // Spacing is not a reading. Falling back beats rendering a strip that is
    // 100% gap and looks broken.
    assert.deepEqual(visibleBarItems([BAR_SPACE, BAR_SPACER, BAR_SPACE]), DEFAULT_BAR_ORDER);
  });

  test("normalizing keeps fixed gaps and still guarantees a flexible one", () => {
    assert.deepEqual(
      normalizeBarRows(["clock", BAR_SPACE, "plan"]),
      ["clock", "space", "plan", "spacer"],
    );
  });

  test("a pre-spacer bar that somehow carries a fixed gap keeps it", () => {
    // Cannot happen from a real config — fixed gaps postdate the migration —
    // but the migration used to rebuild the row list from ITEMS only, which
    // would have silently dropped anything that was not one.
    assert.deepEqual(
      visibleBarItems(["clock", BAR_SPACE, "live-timer"]),
      ["clock", "space", "spacer", "live-timer"],
    );
  });
});

describe("a bar saved before spacers existed", () => {
  // Every install upgrading into this change has one. Its bar must not move.
  test("gets a spacer where the inferred rule used to cut", () => {
    // Old rule: the first of live-timer/current-item/integration-health/
    // recording, and everything after it, was pushed right.
    assert.deepEqual(
      visibleBarItems(["clock", "plan", "live-timer", "recording"]),
      ["clock", "plan", "spacer", "live-timer", "recording"],
    );
  });

  test("splits at the front when a service item came first", () => {
    // The old rule gave this item the auto-margin, which shoved the WHOLE bar
    // right. Preserved rather than quietly corrected.
    assert.deepEqual(visibleBarItems(["recording", "clock"]), ["spacer", "recording", "clock"]);
  });

  test("splits at the end when the bar had no service item at all", () => {
    // Nothing matched, so nothing took the margin and everything packed left.
    assert.deepEqual(visibleBarItems(["clock", "plan"]), ["clock", "plan", "spacer"]);
  });
});

describe("normalizeBarRows", () => {
  // What the configurator saves. Its contract with visibleBarItems is that a
  // saved order ALWAYS contains a spacer — which is what lets "no spacer" keep
  // meaning "saved before spacers existed" for good.
  test("an arrangement with no spacer gets a trailing one", () => {
    // Everything hard left. A trailing spacer looks identical and cannot be
    // mistaken for a config that predates them.
    assert.deepEqual(normalizeBarRows(["clock", "plan"]), ["clock", "plan", "spacer"]);
  });

  test("dragging every spacer out still round-trips as left-aligned", () => {
    // THE case the invariant exists for. Without the trailing spacer this saves
    // as ["clock","plan"], which visibleBarItems reads as a pre-spacer config
    // and "migrates" — silently re-splitting a bar the operator just flattened.
    const saved = normalizeBarRows(["clock", "live-timer"]);
    assert.deepEqual(visibleBarItems(saved), ["clock", "live-timer", "spacer"]);
  });

  test("collapses adjacent spacers rather than saving padding", () => {
    assert.deepEqual(
      normalizeBarRows(["clock", BAR_SPACER, BAR_SPACER, "plan"]),
      ["clock", "spacer", "plan"],
    );
  });

  test("leaves a deliberate arrangement alone", () => {
    const rows = ["plan", BAR_SPACER, "clock", BAR_SPACER, "recording"] as const;
    assert.deepEqual(normalizeBarRows(rows), [...rows]);
  });
});
