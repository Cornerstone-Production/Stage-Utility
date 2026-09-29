// renderer/main/video/playback-reports.test.ts — the registry the presence
// heartbeat drains: registration, unregistration, anyPlaying(), and
// drainReports() isolating one widget's failure from the rest.
//
// Not in the brief's own file list — playback-stats.test.ts is the only test
// file it names — but registerPlayback/anyPlaying/drainReports are exact
// registry behaviour with real edge cases (a stale unregister, a rejecting
// sampler), and this repo's own guard-must-fail-red rule applies to a new
// module whether or not a plan remembered to list its test file.

import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { __resetPlaybackRegistryForTests, anyPlaying, drainReports, registerPlayback } from "./playback-reports.js";

// The registry is module-level state, shared across every test in the file —
// each test cleans up its own registrations, but a leaked one from a FAILED
// test would still bleed into the next.
beforeEach(() => {
  __resetPlaybackRegistryForTests();
});

const report = (feedId: string) => ({ feedId, via: "hls" as const, decoded: 1, dropped: 0, stalls: 0, width: 1920, height: 1080 });

test("nothing registered: anyPlaying is false and drainReports is empty", async () => {
  assert.equal(anyPlaying(), false);
  assert.deepEqual(await drainReports(), []);
});

test("registerPlayback: anyPlaying flips true, and drainReports returns that widget's report", async () => {
  const unregister = registerPlayback("obj-1", async () => report("feed-1"));
  try {
    assert.equal(anyPlaying(), true);
    assert.deepEqual(await drainReports(), [report("feed-1")]);
  } finally {
    unregister();
  }
});

test("unregister drops it: anyPlaying returns to false, drainReports to empty", async () => {
  const unregister = registerPlayback("obj-1", async () => report("feed-1"));
  unregister();
  assert.equal(anyPlaying(), false);
  assert.deepEqual(await drainReports(), []);
});

test("two widget instances playing the same feed are two keys — both reported", async () => {
  const u1 = registerPlayback("obj-1", async () => report("feed-1"));
  const u2 = registerPlayback("obj-2", async () => report("feed-1"));
  try {
    const reports = await drainReports();
    assert.equal(reports.length, 2, "expected one report per WIDGET, not one per feed");
    assert.deepEqual(
      reports.map((r) => r.feedId).sort(),
      ["feed-1", "feed-1"],
    );
  } finally {
    u1();
    u2();
  }
});

test("a sampler returning null contributes nothing, without dropping other widgets' reports", async () => {
  const u1 = registerPlayback("obj-1", async () => null);
  const u2 = registerPlayback("obj-2", async () => report("feed-2"));
  try {
    assert.deepEqual(await drainReports(), [report("feed-2")]);
  } finally {
    u1();
    u2();
  }
});

test("a sampler whose promise rejects drops only that widget's report, not the whole heartbeat", async () => {
  const u1 = registerPlayback("obj-1", async () => {
    throw new Error("boom");
  });
  const u2 = registerPlayback("obj-2", async () => report("feed-2"));
  try {
    const reports = await drainReports();
    assert.deepEqual(reports, [report("feed-2")], "one widget's broken sampler must not take the others down with it");
  } finally {
    u1();
    u2();
  }
});

// ── the stale-unregister guard ────────────────────────────────────────────
//
// A fast remount re-registers the SAME key before the outgoing instance's own
// cleanup has run. Proof this repo's rule (guards ship proven red) can act
// on: reintroducing the bug means making unregister() an unconditional
// `registry.delete(key)`, with no check that it is still the same entry.

test("re-registering the same key replaces it; the OLD registration's unregister is a no-op afterward", async () => {
  const first = registerPlayback("obj-1", async () => report("first"));
  const second = registerPlayback("obj-1", async () => report("second"));
  try {
    // The stale (first) unregister must not evict the newer registration
    // that has already taken its place under the same key.
    first();
    assert.equal(anyPlaying(), true, "the newer registration was evicted by an older instance's own unregister");
    assert.deepEqual(await drainReports(), [report("second")]);
  } finally {
    second();
  }
});
