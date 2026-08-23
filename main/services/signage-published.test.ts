// The gate between what an operator edits and what a wall is running.
//
// The reason it exists is a service: building next week's schedule while this
// week's is on the screens used to change the screens as you typed. So the
// interesting cases are not "does it copy" — they are what is gated, what is
// deliberately NOT, and what happens the first time an install meets this.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageGroup, SignagePlaylist, SignageSchedule } from "../types/signage.js";
import { EMPTY_PUBLISHED, isPublished, pendingChanges } from "./signage-published-store.js";

const pl = (id: string, name = id): SignagePlaylist => ({
  id,
  name,
  items: [],
  defaultDurationMs: 8000,
  fit: "contain",
  transition: { kind: "cut", ms: 0 },
  createdAt: "",
});
const gr = (id: string, outputIds: string[] = []): SignageGroup => ({
  id,
  name: id,
  outputIds,
  createdAt: "",
});
const sc = (id: string): SignageSchedule => ({
  id,
  name: id,
  enabled: true,
  groupIds: [],
  playlistId: "p1",
  window: { kind: "always" },
  createdAt: "",
});

const live = (over: Partial<{ playlists: SignagePlaylist[]; groups: SignageGroup[]; schedules: SignageSchedule[] }> = {}) => ({
  playlists: over.playlists ?? [pl("p1")],
  groups: over.groups ?? [gr("g1")],
  schedules: over.schedules ?? [sc("s1")],
});
const publishedOf = (l: ReturnType<typeof live>) => ({ publishedAt: 1000, ...structuredClone(l) });

describe("what is waiting to be pushed", () => {
  test("nothing, when the walls run exactly what the editor holds", () => {
    const l = live();
    assert.equal(pendingChanges(l, publishedOf(l)).total, 0);
    assert.equal(isPublished(l, publishedOf(l)), true);
  });

  test("an edited playlist counts once, as a playlist", () => {
    // Counted per KIND, because "3 changes" tells an operator nothing about
    // whether they are about to change what is on a wall.
    const before = live();
    const after = live({ playlists: [{ ...pl("p1"), name: "renamed" }] });
    const p = pendingChanges(after, publishedOf(before));
    assert.deepEqual(p, { playlists: 1, groups: 0, schedules: 0, total: 1 });
  });

  test("an added record counts, and so does a removed one", () => {
    const before = live();
    assert.equal(pendingChanges(live({ groups: [gr("g1"), gr("g2")] }), publishedOf(before)).groups, 1);
    assert.equal(pendingChanges(live({ groups: [] }), publishedOf(before)).groups, 1);
  });

  test("REORDERING schedules is a change, even with every record identical", () => {
    // Order is the priority rule. A reorder that did not register as pending
    // would be an operator moving a row, seeing nothing to push, and assuming
    // the walls had it.
    const before = live({ schedules: [sc("s1"), sc("s2")] });
    const after = live({ schedules: [sc("s2"), sc("s1")] });
    assert.equal(pendingChanges(after, publishedOf(before)).schedules, 1);
  });

  test("and a reorder counts ONCE, not once per row that moved", () => {
    const before = live({ schedules: [sc("s1"), sc("s2"), sc("s3")] });
    const after = live({ schedules: [sc("s3"), sc("s1"), sc("s2")] });
    assert.equal(pendingChanges(after, publishedOf(before)).schedules, 1);
  });

  test("changes in two stores are counted separately and summed", () => {
    const before = live();
    const after = live({ playlists: [pl("p1", "x")], groups: [gr("g1"), gr("g2")] });
    const p = pendingChanges(after, publishedOf(before));
    assert.deepEqual(p, { playlists: 1, groups: 1, schedules: 0, total: 2 });
  });
});

describe("the first time an install meets this", () => {
  test("an empty snapshot is not the same as an empty configuration", () => {
    // The upgrade path. Every wall ran the live stores before this existed, so
    // treating "never published" as "publish nothing" would take a building to
    // black until somebody found a button they had never seen. publishedOrLive
    // is what prevents that; this pins the flag it keys on.
    assert.equal(EMPTY_PUBLISHED.publishedAt, null);
  });

  test("everything reads as pending against a snapshot that was never written", () => {
    // Which is correct: the operator has never pushed, so nothing is confirmed.
    // publishedOrLive still RUNS the live config in the meantime.
    assert.equal(pendingChanges(live(), EMPTY_PUBLISHED).total, 3);
  });
});
