// A plan's date in Theme photos is named on the app's calendar, never UTC's and
// never this browser's: a 7pm Sunday service in Chicago is 01:00 Monday in UTC,
// and was once shown as Monday. Host-independent: every zone is passed, and the
// suite is run under TZ=UTC and TZ=America/Chicago alike.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ThemeDTO, ThemePersonDTO } from "@main/types/photo-themes";

import { cardView } from "./person-card.js";
import { keptDay, usedBy } from "./photo-format.js";

const CHICAGO = "America/Chicago";
/** Sunday 20 December 2026, 7pm in Chicago: Monday 21 December, 01:00, in UTC. */
const SUNDAY_7PM = "2026-12-21T01:00:00Z";

const theme = (sortDates: (string | null)[]): ThemeDTO => ({
  id: "th-aaaaaaaaaaaa",
  name: "Christmas",
  prompt: "p",
  promptChanged: false,
  createdAt: "2026-11-01T00:00:00Z",
  lastUsedDate: "2026-12-20",
  keptUntil: "2027-03-20",
  plans: sortDates.map((sortDate, i) => ({ planId: String(7001 + i), serviceTypeId: "100", sortDate })),
  people: [],
});

describe("photo dates", () => {
  test("a 7pm Sunday service in Chicago is used on Sunday", () => {
    assert.deepEqual(usedBy(theme([SUNDAY_7PM]), CHICAGO), ["Sun, Dec 20"]);
  });

  test("soonest first, and a plan with no date says so", () => {
    assert.deepEqual(usedBy(theme([null, "2026-12-28T01:00:00Z", SUNDAY_7PM]), CHICAGO), ["Sun, Dec 20", "Sun, Dec 27", "a plan with no date"]);
  });

  test("an approved photo made for a 7pm Sunday service is From that Sunday", () => {
    const p: ThemePersonDTO = {
      personId: "9001",
      name: "Alex R.",
      status: "approved",
      promptChanged: false,
      approved: { url: "/api/photo-themes/images/0123456789abcdef.webp", fromPlanId: "7001", fromDate: SUNDAY_7PM, approvedAt: "", stale: false },
      pending: null,
      originalUrl: null,
    };
    assert.equal(cardView(p, { planId: "7002", timeZone: CHICAGO }).note, "From Sun, Dec 20");
    assert.equal(cardView(p, { timeZone: CHICAGO }).note, "From Sun, Dec 20", "Manage, across every plan");
  });

  test("a keep date is a day already worked out in the app's zone, and stays that day", () => {
    assert.equal(keptDay("2027-03-20"), "Mar 20, 2027");
  });
});
