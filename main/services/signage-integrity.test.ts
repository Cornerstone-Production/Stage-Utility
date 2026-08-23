// What is using this, before it is deleted.
//
// The rule the repo already applies to views screens are showing: a delete that
// would break something is REFUSED and names what it would break. Naming matters
// as much as refusing — "in use by 1 schedule" leaves the operator hunting, and
// the thing they are hunting for is why their screens went blank.
//
// The case most easily missed is a playlist used only as a group's DEFAULT.
// Nothing points at it from the schedule list, so a usage check that only walked
// schedules would report it free and deleting it would silently blank that group
// — including, per the offline design, on a Pi that boots with no server.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { groupUsage, mediaUsage, playlistUsage } from "./signage-integrity.js";

const schedules = [
  { id: "s1", name: "Weekend mornings", groupIds: ["g1"], playlistId: "p1" },
  { id: "s2", name: "Office hours", groupIds: ["g2", "g3"], playlistId: "p2" },
] as never;

const groups = [
  { id: "g1", name: "Foyer", defaultPlaylistId: "p3" },
  { id: "g2", name: "Hallways" },
] as never;

const playlists = [
  { id: "p1", name: "Weekend", items: [{ mediaId: "m1" }, { mediaId: "m2" }] },
  { id: "p2", name: "Office", items: [{ mediaId: "m1" }] },
] as never;

describe("what is using a playlist", () => {
  test("names the schedules holding it, not just a count", () => {
    assert.deepEqual(playlistUsage("p1", schedules, groups).schedules, ["Weekend mornings"]);
  });

  test("a playlist used only as a group DEFAULT is still in use", () => {
    const u = playlistUsage("p3", schedules, groups);
    assert.deepEqual(u.schedules, []);
    assert.deepEqual(u.groups, ["Foyer"], "deleting it would have silently blanked that group");
  });

  test("counts both at once", () => {
    const both = [...groups, { id: "g9", name: "Cafe", defaultPlaylistId: "p1" }] as never;
    const u = playlistUsage("p1", schedules, both);
    assert.deepEqual(u.schedules, ["Weekend mornings"]);
    assert.deepEqual(u.groups, ["Cafe"]);
  });

  test("something unused is genuinely unused", () => {
    assert.deepEqual(playlistUsage("nope", schedules, groups), { schedules: [], groups: [] });
  });

  test("a group with no default does not count as using anything", () => {
    // `defaultPlaylistId` is optional and may be null. Treating absent as a
    // match would make every playlist permanently undeletable.
    assert.deepEqual(playlistUsage("", schedules, groups), { schedules: [], groups: [] });
  });
});

describe("what is using a group", () => {
  test("names the schedules targeting it", () => {
    assert.deepEqual(groupUsage("g2", schedules), ["Office hours"]);
  });

  test("a schedule targeting several groups counts for each", () => {
    assert.deepEqual(groupUsage("g3", schedules), ["Office hours"]);
  });

  test("an unused group is free", () => {
    assert.deepEqual(groupUsage("g9", schedules), []);
  });
});

describe("what is using a media item", () => {
  test("names the playlists holding it", () => {
    assert.deepEqual(mediaUsage("m1", playlists), ["Weekend", "Office"]);
  });

  test("names each playlist once, however many times it appears", () => {
    // The same graphic twice in one playlist is legitimate - a bumper at the
    // start and the end - and listing it twice reads as two playlists.
    const twice = [{ id: "p1", name: "Weekend", items: [{ mediaId: "m1" }, { mediaId: "m1" }] }] as never;
    assert.deepEqual(mediaUsage("m1", twice), ["Weekend"]);
  });

  test("unused media is free", () => {
    assert.deepEqual(mediaUsage("m9", playlists), []);
  });
});
