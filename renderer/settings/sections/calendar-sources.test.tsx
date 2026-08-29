// What this file guards.
//
// A CHOICE PCO NO LONGER OFFERS STAYS IN THE PICKER, MARKED. Dropping it would
// silently unselect the operator's choice and widen the filter to everything,
// with nothing on screen to explain it — and because Planning Center filters by
// ID, the stored NAME is the only thing that makes such a choice readable at
// all. Without it a deleted tag shows as a hex string or as nothing.
//
// Proven red in the session that wrote it: the `missing` branch was removed from
// optionsFor and the first two tests failed.
//
// Every id and name below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installDom } from "../../test-dom.js";
import type { CalendarSelection } from "@main/types/calendar";

// The module is a .tsx and pulls the UI tree in with it, so a document has to
// exist before it is imported even though only pure functions are called here.
const teardown = installDom();
const { optionsFor, toSelections } = await import("./calendar-sources.js");
teardown();

const OFFERED = [
  { id: "tag-1", name: "Alpha Ministry", groupName: "Departments" },
  { id: "tag-2", name: "Beta Ministry", groupName: "Departments" },
];

describe("a choice Planning Center no longer offers", () => {
  it("stays in the list rather than disappearing", () => {
    const chosen: CalendarSelection[] = [{ id: "tag-gone", name: "Gamma Ministry" }];
    const values = optionsFor(OFFERED, chosen).map((o) => o.value);
    assert.ok(values.includes("tag-gone"), "the operator's choice vanished from the picker");
  });

  it("is labelled with the name it had, and marked", () => {
    // The id is what PCO filters on and is unreadable. The stored name is the
    // only reason this row says anything at all.
    const chosen: CalendarSelection[] = [{ id: "tag-gone", name: "Gamma Ministry" }];
    const row = optionsFor(OFFERED, chosen).find((o) => o.value === "tag-gone");
    assert.equal(row?.label, "Gamma Ministry (not in Planning Center)");
  });

  it("falls back to the id when even the name was never stored", () => {
    const row = optionsFor(OFFERED, [{ id: "tag-gone", name: "" }]).find((o) => o.value === "tag-gone");
    assert.equal(row?.label, "tag-gone (not in Planning Center)");
  });

  it("does not double up a choice PCO still offers", () => {
    const values = optionsFor(OFFERED, [{ id: "tag-1", name: "Alpha Ministry" }]).map((o) => o.value);
    assert.deepEqual(values, ["tag-1", "tag-2"]);
  });
});

describe("what the picker offers", () => {
  it("names the tag group, because PCO's ANDing across groups is invisible otherwise", () => {
    assert.equal(optionsFor(OFFERED, []).find((o) => o.value === "tag-1")?.label, "Departments · Alpha Ministry");
  });

  it("leaves a calendar, which has no group, as its bare name", () => {
    assert.equal(optionsFor([{ id: "cal-1", name: "Main" }], [])[0].label, "Main");
  });
});

describe("turning the picker's ids back into stored choices", () => {
  it("takes the CURRENT name from PCO, so a rename is picked up on the next save", () => {
    const stored: CalendarSelection[] = [{ id: "tag-1", name: "Old Name" }];
    assert.deepEqual(toSelections(["tag-1"], OFFERED, stored), [{ id: "tag-1", name: "Alpha Ministry" }]);
  });

  it("keeps the stored name for a choice PCO no longer offers", () => {
    // Otherwise the label degrades to an id the moment anything else on the view
    // is saved — the choice survives one round trip and then stops being
    // readable, which is worse than dropping it outright.
    const stored: CalendarSelection[] = [{ id: "tag-gone", name: "Gamma Ministry" }];
    assert.deepEqual(toSelections(["tag-gone"], OFFERED, stored), [{ id: "tag-gone", name: "Gamma Ministry" }]);
  });

  it("preserves the order the picker gave", () => {
    assert.deepEqual(
      toSelections(["tag-2", "tag-1"], OFFERED, []).map((s) => s.id),
      ["tag-2", "tag-1"],
    );
  });
});
