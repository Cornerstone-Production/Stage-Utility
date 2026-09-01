import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  BAR_ITEMS,
  BAR_SPACE,
  BAR_SPACE_ITEM,
  BAR_SPACER,
  BAR_SPACER_ITEM,
  BAR_PROSE_ITEMS,
  DEFAULT_BAR_ORDER,
  barRowsFor,
  hasMobileBar,
  phoneShowsEditedSet,
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
    // The service type and the plan on the left; the current item and the timer
    // on the right.
    assert.deepEqual(DEFAULT_BAR_ORDER, [
      "service-type",
      "plan",
      "spacer",
      "current-item",
      "live-timer",
    ]);
    assert.ok(!DEFAULT_BAR_ORDER.includes("recording"), "recording is opt-in");
    assert.ok(!DEFAULT_BAR_ORDER.includes("integration-health"), "health is opt-in");
  });

  test("THE GUARD: the default still draws both halves of the old plan item", () => {
    // `plan` used to draw the service-type name AND the plan title. It draws the
    // title alone now, so a default that named only `plan` would take a reading
    // off the bar of every install that never configured one — silently, and
    // without anybody having asked for it.
    assert.ok(DEFAULT_BAR_ORDER.includes("service-type"), "the default lost the service type");
    assert.ok(DEFAULT_BAR_ORDER.includes("plan"), "the default lost the plan title");
    assert.equal(
      DEFAULT_BAR_ORDER.indexOf("service-type") + 1,
      DEFAULT_BAR_ORDER.indexOf("plan"),
      "the two halves are no longer side by side, in the order the one item drew them",
    );
  });

  test("the two labels have to be tellable apart in the palette", () => {
    // "Service type" beside "Service type and plan" was the trap this split had
    // to avoid: one reads as a shorter spelling of the other rather than as a
    // different item. Neither label may contain the other.
    const a = BAR_ITEMS["service-type"].label;
    const b = BAR_ITEMS.plan.label;
    assert.ok(!a.includes(b) && !b.includes(a), `"${a}" and "${b}" read as the same tile`);
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
    // A bar showing nothing reads as broken, not as configured. Nothing was
    // ever saved here, so there is no arrangement to keep.
    assert.deepEqual(visibleBarItems([]), DEFAULT_BAR_ORDER);
    assert.deepEqual(visibleBarItems(undefined), DEFAULT_BAR_ORDER);
  });

  test("but a bar the operator EMPTIED stays empty", () => {
    // Drag every item out and the configurator commits [], which
    // normalizeBarRows saves as ["spacer"]. Reading that back as "empty, use
    // the defaults" refilled the strip with five items nobody asked for, while
    // the editor below it still said "Drag something in." — the two disagreed
    // on screen at the same time and the removal was undone.
    assert.deepEqual(visibleBarItems([BAR_SPACER]), [BAR_SPACER]);
    assert.deepEqual(visibleBarItems([BAR_SPACER, BAR_SPACER]), [BAR_SPACER]);
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

  test("a bar of nothing but gaps is the bar that was saved", () => {
    // Gaps are the shape of a strip somebody cleared. Handing back the defaults
    // instead put five items on a bar the operator had just emptied.
    assert.deepEqual(
      visibleBarItems([BAR_SPACE, BAR_SPACER, BAR_SPACE]),
      [BAR_SPACE, BAR_SPACER, BAR_SPACE],
    );
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

describe("which set a viewport reads", () => {
  const DESKTOP = ["clock", "plan", BAR_SPACER, "current-item", "live-timer"];
  const PHONE = ["live-timer", BAR_SPACER, "integration-health"];

  test("THE GUARD: an install that has never configured a phone bar does not move on upgrade", () => {
    // The whole upgrade story. Every bar-config.json in existence has no phone
    // set, so the phone must go on showing the desktop arrangement — item for
    // item, in order. A "sensible curated default" here would silently take
    // integration health off the strip of the one operator who put it there
    // because they carry a phone away from the console.
    assert.equal(hasMobileBar([]), false);
    assert.equal(hasMobileBar(undefined), false);
    assert.deepEqual(barRowsFor(DESKTOP, [], true), visibleBarItems(DESKTOP));
    assert.deepEqual(barRowsFor(DESKTOP, undefined, true), visibleBarItems(DESKTOP));
  });

  test("a phone with its own set reads that set, and only on a phone", () => {
    assert.deepEqual(barRowsFor(DESKTOP, PHONE, true), visibleBarItems(PHONE));
    assert.deepEqual(barRowsFor(DESKTOP, PHONE, false), visibleBarItems(DESKTOP));
  });

  test("THE GUARD: the phone's set never reaches a desktop", () => {
    // The mirror of the rule above, and the one that would go unnoticed: a
    // curated three-item phone strip appearing above a 1440px page reads as the
    // bar having lost items rather than as the wrong set being chosen.
    assert.notDeepEqual(barRowsFor(DESKTOP, PHONE, false), visibleBarItems(PHONE));
    assert.deepEqual(barRowsFor(DESKTOP, PHONE, false), visibleBarItems(DESKTOP));
  });

  test("an unconfigured desktop bar still falls back to the default on both", () => {
    assert.deepEqual(barRowsFor([], [], true), DEFAULT_BAR_ORDER);
    assert.deepEqual(barRowsFor([], [], false), DEFAULT_BAR_ORDER);
  });

  test("a phone set naming nothing this build has falls back rather than showing an empty strip", () => {
    // Same rule visibleBarItems already applies: a downgrade, or an integration
    // removed, must not leave a bar that renders nothing and reads as broken.
    assert.deepEqual(barRowsFor(DESKTOP, ["not-an-item", "gone-too"], true), DEFAULT_BAR_ORDER);
  });
});

describe("whether the 320px sentence is about the set being edited", () => {
  const PHONE = ["live-timer", BAR_SPACER, "integration-health"];

  test("THE GUARD: not about a desktop set the phone has stopped following", () => {
    // barRowsFor never puts the desktop rows below 640px once the phone has a
    // set of its own, so measuring them at 320px reports on a strip that cannot
    // exist — one line under "Shown from 640px wide up".
    assert.equal(phoneShowsEditedSet("desktop", PHONE), false);
  });

  test("but IS about the desktop set while the phone still follows it", () => {
    // Following means the phone renders these very rows, so the warning is the
    // only place an operator hears about them being cut.
    assert.equal(phoneShowsEditedSet("desktop", []), true);
    assert.equal(phoneShowsEditedSet("desktop", undefined), true);
  });

  test("and always about the phone's own set", () => {
    assert.equal(phoneShowsEditedSet("mobile", PHONE), true);
    assert.equal(phoneShowsEditedSet("mobile", []), true);
  });
});

describe("which readings are prose", () => {
  test("THE GUARD: prose is named EXACTLY, so a new item cannot join it by accident", () => {
    // This set decides two things at once: which items may ellipsise at the
    // floor, and which ones the configurator warns a phone about. An item that
    // wandered in would start being cut without anyone deciding it could be; one
    // that wandered out would be cut with no warning that it would be.
    //
    // The service type joined it when it became an item of its own: it is a name
    // somebody wrote, it survives every rung now that it is somebody's choice,
    // and an item that survives to the floor with nowhere to give would be
    // clipped by the strip with no ellipsis to say so.
    assert.deepEqual(Object.keys(BAR_PROSE_ITEMS).sort(), ["current-item", "plan", "service-type"]);
  });

  test("and every id in it is a real bar item", () => {
    for (const [id, reading] of Object.entries(BAR_PROSE_ITEMS)) {
      assert.ok(id in BAR_ITEMS, `${id} is named as prose but is not a bar item`);
      // The name has to read as a thing inside a sentence, because that is where
      // the configurator puts it: "… and <reading> will be cut short."
      assert.match(reading, /^the /, `${id}'s prose name does not read in a sentence: ${reading}`);
    }
  });
});
