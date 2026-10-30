// The words a target is called by: a plan's short date, "the Weekend", and the
// save message. A wrong date points a save at the wrong week and the formatting is
// where that would come from.
//
// The target controls themselves are tested where they live, with the page:
// mic-slots-page.test.tsx.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { planLabel, savedMessage, namedType } = await import("./slots-target-pill.js");

describe("labelling", () => {
  test("a plan's sort date becomes a short weekday date", () => {
    // A fixed zone, so the assertion does not depend on where the box is.
    assert.equal(planLabel("2026-09-13T14:00:00Z", "September 13, 2026", "UTC"), "Sun, Sep 13");
  });

  test("falls back to Planning Center's own words with no sort date", () => {
    assert.equal(
      planLabel(null, "September 13-14, 2026", "UTC"),
      "September 13-14, 2026",
      "parsing what somebody typed into a weekday would be guessing, and a wrong date here points a save at the wrong week",
    );
  });

  test("falls back again with neither", () => {
    assert.equal(planLabel(null, null, null), "This plan");
  });

  test("an unparseable sort date does not become Invalid Date", () => {
    assert.equal(planLabel("not-a-date", "September 13, 2026", "UTC"), "September 13, 2026");
  });

  test("the save message names which board it landed on", () => {
    assert.equal(
      savedMessage("plan", "Wed Sep 13", "Youth Night"),
      "Saved slots for Wed Sep 13 · Youth Night",
    );
    assert.equal(savedMessage("default", "Wed Sep 13", "Youth Night"), "Saved the Youth Night default");
  });

  test("and still says something without a service type name", () => {
    assert.equal(savedMessage("plan", "Wed Sep 13", null), "Saved slots for Wed Sep 13");
    assert.equal(savedMessage("default", "Wed Sep 13", null), "Saved the default");
  });

  // A service type's name is whatever somebody typed into Planning Center, and
  // "The Gathering" is a real one — five strings that named a default board
  // read "the The Gathering default".
  test("a type name that already opens with an article does not get a second one", () => {
    assert.equal(namedType("The Gathering"), "The Gathering");
    assert.equal(namedType("Weekend"), "the Weekend");
    assert.equal(namedType(null), "the service type");
    assert.equal(
      savedMessage("default", "Wed Sep 13", "The Gathering"),
      "Saved The Gathering default",
    );
  });

  test("and it capitalises for a sentence that opens with it", () => {
    assert.equal(namedType("Weekend", true), "The Weekend");
    assert.equal(namedType("the midweek", true), "The midweek");
    assert.equal(namedType(null, true), "The service type");
  });
});
