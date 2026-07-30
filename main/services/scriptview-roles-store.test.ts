// Seeding runs once against whatever PCO reports. It must be lossless — one role per
// category, nothing merged — because keyword matching guesses badly enough that a
// wrong automatic merge would silently hide a department's notes.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { seedRoles } from "./scriptview-roles-store.js";

describe("seedRoles", () => {
  test("creates one role per category, named after it", () => {
    const roles = seedRoles(["Audio", "Band", "Vocals"]);
    assert.equal(roles.length, 3);
    assert.deepEqual(roles.map((r) => r.name), ["Audio", "Band", "Vocals"]);
    assert.deepEqual(roles.map((r) => r.members), [["Audio"], ["Band"], ["Vocals"]]);
  });

  test("never merges, even for names that obviously pair", () => {
    // Audio and Audio/Visual are the same role in practice, but merging is the
    // operator's call — an automatic merge that is wrong hides notes silently.
    const roles = seedRoles(["Audio", "Audio/Visual"]);
    assert.equal(roles.length, 2);
  });

  test("ids are stable for the same category name", () => {
    assert.equal(seedRoles(["Audio"])[0].id, seedRoles(["Audio"])[0].id);
  });

  test("duplicates and blanks are dropped", () => {
    const roles = seedRoles(["Audio", "Audio", "  ", ""]);
    assert.deepEqual(roles.map((r) => r.name), ["Audio"]);
  });

  test("a service type with no categories seeds nothing rather than failing", () => {
    assert.deepEqual(seedRoles([]), []);
  });

  test("names that differ only in case collapse to one role", () => {
    // "EG 1 (Lead)" and "EG 1 (LEAD)" both exist in the wild.
    assert.equal(seedRoles(["EG 1 (Lead)", "EG 1 (LEAD)"]).length, 1);
  });
});
