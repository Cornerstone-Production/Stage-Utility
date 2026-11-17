// The photo themes file: what a load or a restore accepts, and the keep date.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setAppTimeZone } from "../app-timezone.js";
import { addMonths, keptUntil, parseBook, serializeBook } from "./book.js";

const PERSON = {
  personId: "1001",
  name: "Alex R.",
  approved: {
    file: "0123456789abcdef.webp",
    madeFrom: "fedcba9876543210",
    sourceUrl: "https://avatars.planningcenteronline.com/uploads/person/1001-1/avatar.jpg",
    planId: "2001",
    serviceDate: "2026-12-24T16:00:00Z",
    approvedAt: "2026-11-18T12:00:00.000Z",
  },
};
const THEME = {
  id: "th-0123456789ab",
  name: "Christmas 2026",
  prompt: "Warm lights",
  baselinePrompt: "Warm lights",
  createdAt: "2026-11-17T12:00:00.000Z",
  lastUsedDate: "2026-12-24",
  people: [PERSON],
};
const PLAN = { planId: "2001", serviceTypeId: "100", sortDate: "2026-12-24T16:00:00Z", themeId: THEME.id, show: "themed" };
const FILE = { version: 1, themes: [THEME], plans: [PLAN] };

const withTheme = (patch: object) => ({ ...FILE, themes: [{ ...THEME, ...patch }] });
const withPerson = (patch: object) => withTheme({ people: [{ ...PERSON, ...patch }] });
const withApproved = (patch: object) => withPerson({ approved: { ...PERSON.approved, ...patch } });

describe("parseBook", () => {
  it("reads a good file back to the same file", () => {
    assert.deepEqual(serializeBook(parseBook(FILE)), FILE);
  });

  const BAD: [string, unknown, RegExp][] = [
    ["not an object", [], /must be an object/],
    ["another version", { ...FILE, version: 2 }, /version 1/],
    ["a theme id of another shape", withTheme({ id: "christmas" }), /not a theme id/],
    ["a theme listed twice", { ...FILE, themes: [THEME, THEME] }, /listed twice/],
    ["an empty name", withTheme({ name: " " }), /name must not be empty/],
    ["a prompt over the limit", withTheme({ prompt: "x".repeat(2001) }), /at most 2000/],
    ["a date that is not one", withTheme({ lastUsedDate: "2026-02-31" }), /lastUsedDate/],
    ["a person id that is not one", withPerson({ personId: "__proto__" }), /person id/],
    ["a file outside the store", withApproved({ file: "../secrets.bin" }), /stored photo/],
    ["a source that is not Planning Center", withApproved({ sourceUrl: "http://192.168.1.1/x.jpg" }), /Planning Center photo address/],
    ["a fingerprint of another shape", withApproved({ madeFrom: "abc" }), /fingerprint/],
    ["a pending photo in another state", withPerson({ pending: { ...PERSON.approved, status: "generating" } }), /"ready" or "failed"/],
    ["a plan using a theme the file lacks", { ...FILE, plans: [{ ...PLAN, themeId: "th-000000000000" }] }, /does not have/],
    ["a show that is not one", { ...FILE, plans: [{ ...PLAN, show: "both" }] }, /"original" or "themed"/],
  ];
  for (const [what, file, says] of BAD) {
    it(`refuses ${what}`, () => assert.throws(() => parseBook(file), says));
  }
});

describe("the keep date", () => {
  it("is three calendar months on, the day clamped to the month", () => {
    assert.equal(addMonths("2026-12-24", 3), "2027-03-24");
    assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
    assert.equal(addMonths("2027-11-30", 3), "2028-02-29");
    assert.equal(addMonths("2026-10-31", 3), "2027-01-31");
  });

  it("counts from the later of the day the theme was made and its last use, in the app's zone", () => {
    setAppTimeZone("America/Chicago");
    // 02:00 UTC on the 18th is the evening of the 17th in Chicago.
    assert.equal(keptUntil({ createdAt: "2026-11-18T02:00:00.000Z", lastUsedDate: null }), "2027-02-17");
    assert.equal(keptUntil({ createdAt: "2026-11-18T02:00:00.000Z", lastUsedDate: "2026-12-24" }), "2027-03-24");
    assert.equal(keptUntil({ createdAt: "2027-01-05T12:00:00.000Z", lastUsedDate: "2026-12-24" }), "2027-04-05");
  });
});
