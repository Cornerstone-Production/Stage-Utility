// Where a playlist is, right now, derived from nothing but the clock.
//
// This is what keeps two TVs in a foyer showing the same graphic without a
// single byte of traffic between them: both compute the position from the same
// startedAt and the same durations, so they cannot disagree. Every property
// below exists to protect that.
//
// The one that is easy to break by accident is the cycle length. A transition
// occupies the FIRST N ms of the incoming item's own slot rather than being
// added between items, precisely so the cycle stays the plain sum of durations.
// Making a transition lengthen the cycle would put screens out of step by the
// transition duration per revolution, which drifts visibly within an hour.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { cycleMs, itemAt, entryAt } from "./signage-cycle.js";

const ITEMS = [{ durationMs: 8000 }, { durationMs: 8000 }, { durationMs: 12000 }];

describe("where a playlist is in its cycle", () => {
  test("the cycle is the plain sum of durations", () => {
    assert.equal(cycleMs(ITEMS), 28000);
  });

  test("the same elapsed time always gives the same answer", () => {
    assert.deepEqual(itemAt(ITEMS, 0), { index: 0, offsetMs: 0 });
    assert.deepEqual(itemAt(ITEMS, 7999), { index: 0, offsetMs: 7999 });
    assert.deepEqual(itemAt(ITEMS, 8000), { index: 1, offsetMs: 0 });
    assert.deepEqual(itemAt(ITEMS, 9000), { index: 1, offsetMs: 1000 });
    assert.deepEqual(itemAt(ITEMS, 20000), { index: 2, offsetMs: 4000 });
  });

  test("a boundary belongs to the item starting there, not the one ending", () => {
    // Half-open, like the horizon's entries. If both sides claimed 8000 a
    // display could show either, and two displays could show different ones.
    assert.equal(itemAt(ITEMS, 8000)?.index, 1);
    assert.equal(itemAt(ITEMS, 16000)?.index, 2);
  });

  test("it wraps, and is still right days later", () => {
    assert.deepEqual(itemAt(ITEMS, 28000), { index: 0, offsetMs: 0 });
    assert.deepEqual(itemAt(ITEMS, 28000 * 1000 + 9000), { index: 1, offsetMs: 1000 });
    // A week of continuous play, which a foyer screen genuinely does.
    const week = 7 * 24 * 3600 * 1000;
    assert.ok(itemAt(ITEMS, week) !== null);
  });

  test("a single item is a static graphic", () => {
    assert.deepEqual(itemAt([{ durationMs: 8000 }], 100000), { index: 0, offsetMs: 4000 });
  });

  test("an empty playlist yields null rather than dividing by zero", () => {
    assert.equal(cycleMs([]), 0);
    assert.equal(itemAt([], 5000), null);
  });

  test("items of zero length cannot make the cycle zero-length either", () => {
    // Belt and braces: the resolver rejects these upstream, but a modulo by zero
    // here would crash a wall screen rather than degrade.
    assert.equal(itemAt([{ durationMs: 0 }, { durationMs: 0 }], 5000), null);
  });

  test("a negative duration is treated as zero, not as time running backwards", () => {
    assert.equal(cycleMs([{ durationMs: -5000 }, { durationMs: 8000 }]), 8000);
  });

  test("a clock behind startedAt still lands inside the cycle", () => {
    // A display whose clock is a little behind the server's would otherwise
    // compute a negative position and fall out of the walk entirely.
    const r = itemAt(ITEMS, -1000);
    assert.ok(r && r.index >= 0 && r.index < ITEMS.length, "a clock behind startedAt fell outside the cycle");
    assert.deepEqual(r, { index: 2, offsetMs: 11000 });
  });
});

describe("which horizon entry is current", () => {
  const H = [
    { from: 100, until: 200, reason: "schedule", reasonLabel: "A" },
    { from: 200, until: 300, reason: "blank", reasonLabel: "" },
  ] as never;

  test("boundaries are half-open, so no instant belongs to two entries", () => {
    assert.equal((entryAt(H, 199) as { reasonLabel: string } | null)?.reasonLabel, "A");
    assert.equal((entryAt(H, 200) as { reason: string } | null)?.reason, "blank");
  });

  test("the start of the horizon is inside it", () => {
    assert.equal((entryAt(H, 100) as { reasonLabel: string } | null)?.reasonLabel, "A");
  });

  test("outside the horizon is null, not the nearest entry", () => {
    // Guessing here is how a stale horizon keeps a display on last week's
    // content believing it is current.
    assert.equal(entryAt(H, 99), null);
    assert.equal(entryAt(H, 300), null);
  });

  test("an empty horizon is null", () => {
    assert.equal(entryAt([], 150), null);
  });
});

