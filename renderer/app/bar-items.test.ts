import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { BAR_ITEMS, DEFAULT_BAR_ORDER, visibleBarItems } from "./bar-items.js";

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
  test("keeps the operator's order", () => {
    assert.deepEqual(visibleBarItems(["recording", "clock"]), ["recording", "clock"]);
  });

  test("skips an id this build does not have", () => {
    // A downgrade, or an integration removed. A hole in the bar is worse than a
    // shorter bar, and rendering an unknown id would be a hole.
    assert.deepEqual(visibleBarItems(["clock", "stream-status", "recording"]), ["clock", "recording"]);
  });

  test("falls back to the default rather than rendering an empty bar", () => {
    // A bar showing nothing reads as broken, not as configured.
    assert.deepEqual(visibleBarItems([]), DEFAULT_BAR_ORDER);
    assert.deepEqual(visibleBarItems(undefined), DEFAULT_BAR_ORDER);
  });

  test("falls back when every saved id is unknown", () => {
    // The realistic downgrade: a config written by a much newer build.
    assert.deepEqual(visibleBarItems(["nope", "also-nope"]), DEFAULT_BAR_ORDER);
  });

  test("does not invent duplicates", () => {
    const out = visibleBarItems(["clock", "clock"]);
    assert.deepEqual(out, ["clock", "clock"], "dedupe is the chooser's job, not the renderer's");
  });
});
