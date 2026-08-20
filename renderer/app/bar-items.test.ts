import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { BAR_ITEMS, BAR_SPLIT, DEFAULT_BAR_ORDER, barRows, visibleBarItems } from "./bar-items.js";

// Exhaustiveness is the COMPILER's job: BAR_ITEMS is Record<BarItemId, BarItem>,
// so a new id without an entry fails tsc. The design doc singles that out
// because this becomes another place a new integration has to register itself,
// and source-scanning guards here have repeatedly passed while missing entries.
//
// These cover what the type system cannot: that a saved config from another
// build cannot produce a broken bar.

describe("the bar registry", () => {
  test("every item describes itself for the chooser", () => {
    // A chooser row with no hint is a choice made blind.
    for (const [id, item] of Object.entries(BAR_ITEMS)) {
      assert.equal(item.id, id, `${id} disagrees with its key`);
      assert.ok(item.label.length > 0, `${id} has no label`);
      assert.ok(item.hint.length > 10, `${id} has no useful hint`);
    }
  });

  test("the default is the bar as it shipped", () => {
    // An install that never opens the chooser must look exactly as it does
    // today. The two new items are opt-in, not added to everyone's bar.
    assert.deepEqual(DEFAULT_BAR_ORDER, ["plan", "current-item", "live-timer"]);
    assert.ok(!DEFAULT_BAR_ORDER.includes("recording" as never));
    assert.ok(!DEFAULT_BAR_ORDER.includes("integration-health" as never));
  });

  test("every default item exists in the registry", () => {
    for (const id of DEFAULT_BAR_ORDER) {
      assert.ok(BAR_ITEMS[id], `default names ${id}, which is not a registered item`);
    }
  });
});

describe("visibleBarItems", () => {
  test("keeps the operator's order, and their split", () => {
    assert.deepEqual(visibleBarItems(["clock", BAR_SPLIT, "recording"]), ["clock", "split", "recording"]);
  });

  test("honours a split the inferred rule could never have produced", () => {
    // The whole point of making it explicit. Under the old rule `recording` was
    // a right-hand item, so it and everything after it went right and the clock
    // could not follow it on the left. Now the operator decides.
    assert.deepEqual(
      visibleBarItems(["recording", "clock", BAR_SPLIT, "plan"]),
      ["recording", "clock", "split", "plan"],
    );
  });

  test("skips an id this build does not have", () => {
    // A downgrade, or an integration removed. A hole in the bar is worse than a
    // shorter bar, and rendering an unknown id would be a hole.
    assert.deepEqual(
      visibleBarItems(["clock", "stream-status", BAR_SPLIT, "recording"]),
      ["clock", "split", "recording"],
    );
  });

  test("falls back to the default rather than rendering an empty bar", () => {
    // A bar showing nothing reads as broken, not as configured.
    const def = ["plan", "split", "current-item", "live-timer"];
    assert.deepEqual(visibleBarItems([]), def);
    assert.deepEqual(visibleBarItems(undefined), def);
    // A saved order that is nothing BUT a split is still an empty bar.
    assert.deepEqual(visibleBarItems([BAR_SPLIT]), def);
  });

  test("falls back when every saved id is unknown", () => {
    // The realistic downgrade: a config written by a much newer build.
    assert.deepEqual(visibleBarItems(["nope", "also-nope"]), ["plan", "split", "current-item", "live-timer"]);
  });

  test("does not invent duplicates", () => {
    const out = visibleBarItems(["clock", "clock", BAR_SPLIT]);
    assert.deepEqual(out, ["clock", "clock", "split"], "dedupe is the chooser's job, not the renderer's");
  });

  test("keeps only the FIRST of two splits", () => {
    // A hand-edited bar-config.json. Two splits would give two items ml-auto,
    // and the bar's alignment would depend on which the renderer saw last.
    assert.deepEqual(
      visibleBarItems(["clock", BAR_SPLIT, "plan", BAR_SPLIT, "recording"]),
      ["clock", "split", "plan", "recording"],
    );
  });
});

describe("which side an item lands on", () => {
  // The bar gives ONE item `sm:ml-auto`, and that margin eats the slack — so
  // that item and everything after it sits at the right edge. barRows says
  // which one, and these are the cases that decide the bar's whole shape.
  test("the split's index is the first RIGHT-aligned item", () => {
    const { ids, splitAt } = barRows(["clock", "plan", BAR_SPLIT, "live-timer", "recording"]);
    assert.deepEqual(ids, ["clock", "plan", "live-timer", "recording"]);
    assert.equal(splitAt, 2, "live-timer should start the right-hand group");
    assert.equal(ids[splitAt], "live-timer");
  });

  test("a split at the front right-aligns the whole bar", () => {
    assert.equal(barRows([BAR_SPLIT, "clock", "plan"]).splitAt, 0);
  });

  test("a split at the end leaves everything left", () => {
    // No item's index can equal ids.length, so nothing takes the margin.
    const { ids, splitAt } = barRows(["clock", "plan", BAR_SPLIT]);
    assert.equal(splitAt, ids.length);
    assert.ok(!ids.some((_, i) => i === splitAt), "an item was pushed right by a trailing split");
  });

  test("no split at all leaves everything left", () => {
    assert.equal(barRows(["clock", "plan"]).splitAt, -1);
  });

  test("the split is not itself rendered as an item", () => {
    // It draws nothing. A split leaking into `ids` would render an empty span
    // and take a gap's worth of width.
    assert.ok(!barRows([BAR_SPLIT, "clock"]).ids.includes(BAR_SPLIT as never));
  });
});

describe("a bar saved before the split existed", () => {
  // Every install upgrading into this change has one. Its bar must not move.
  test("gets its split where the inferred rule used to cut", () => {
    // Old rule: the first of live-timer/current-item/integration-health/
    // recording, and everything after it, was pushed right.
    assert.deepEqual(
      visibleBarItems(["clock", "plan", "live-timer", "recording"]),
      ["clock", "plan", "split", "live-timer", "recording"],
    );
  });

  test("splits at the front when a service item came first", () => {
    // The old rule gave this item index 0 the auto-margin, which shoved the
    // WHOLE bar right. Preserved rather than quietly corrected.
    assert.deepEqual(visibleBarItems(["recording", "clock"]), ["split", "recording", "clock"]);
  });

  test("splits at the end when the bar had no service item at all", () => {
    // Nothing matched, so nothing took the margin and everything packed left.
    assert.deepEqual(visibleBarItems(["clock", "plan"]), ["clock", "plan", "split"]);
  });

  test("the shipped default keeps the shape it shipped with", () => {
    // plan on the left; the current item and the timer on the right.
    assert.deepEqual(visibleBarItems(DEFAULT_BAR_ORDER), ["plan", "split", "current-item", "live-timer"]);
  });
});
