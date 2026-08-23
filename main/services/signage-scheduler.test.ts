// When the scheduler talks, and when it wakes up.
//
// Both halves are about not being noisy. Broadcast-on-change is the standing
// rule for anything new here: an identical map pushed on a timer wakes every
// display for nothing, on a network that also carries the countdown and the
// slot telemetry.
//
// The wake-up half is the reason the horizon exists at all. The scheduler arms
// ONE timeout at the next instant any window could change its answer, rather
// than polling every second and diffing. The two failure modes worth pinning are
// a timer that never fires (a boundary hours away with no safety net) and one
// that fires immediately forever (a boundary already in the past).

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageHorizon } from "../types/signage.js";
import type { SignageHorizonEntry } from "../types/signage.js";
import { SAFETY_TICK_MS, carryStartedAt, nextWakeMs, shouldBroadcast } from "./signage-scheduler.js";

const NOW = 1_000_000;
const entry = (from: number, until: number, reasonLabel = "") =>
  ({ from, until, reason: "blank", reasonLabel }) as never;

describe("when the scheduler talks", () => {
  test("stays quiet when nothing changed", () => {
    const a: Record<string, SignageHorizon> = { "out-1": [entry(1, 2)] };
    const b: Record<string, SignageHorizon> = { "out-1": [entry(1, 2)] };
    assert.equal(shouldBroadcast(a, b), false);
  });

  test("talks when an output's horizon differs", () => {
    assert.equal(
      shouldBroadcast({ "out-1": [entry(1, 2)] }, { "out-1": [entry(1, 3)] }),
      true,
    );
  });

  test("talks when only the REASON changed", () => {
    // Same playlist, different winning schedule. The board says why, so this is
    // a real change even though the wall looks identical.
    assert.equal(
      shouldBroadcast({ "out-1": [entry(1, 2, "Weekend")] }, { "out-1": [entry(1, 2, "Office")] }),
      true,
    );
  });

  test("talks when an output appears or disappears", () => {
    assert.equal(shouldBroadcast({}, { "out-1": [] }), true);
    assert.equal(shouldBroadcast({ "out-1": [] }, {}), true);
  });

  test("does not talk merely because the object identity changed", () => {
    // Every recompute builds a fresh map; comparing by reference would broadcast
    // on every tick forever.
    const shape = () => ({ "out-1": [entry(1, 2, "Weekend")] });
    assert.equal(shouldBroadcast(shape(), shape()), false);
  });

  test("talks on the very first computation", () => {
    assert.equal(shouldBroadcast(null, { "out-1": [entry(1, 2)] }), true);
  });
});

describe("when the scheduler wakes up", () => {
  test("at the earliest boundary across every output", () => {
    const h: Record<string, SignageHorizon> = {
      "out-1": [entry(NOW, NOW + 90_000)],
      "out-2": [entry(NOW, NOW + 30_000)],
    };
    assert.equal(nextWakeMs(h, NOW), 30_000);
  });

  test("never later than the safety tick", () => {
    // A horizon whose first boundary is hours away must still be re-checked: PCO
    // windows and the live state change outside this module, and a wall stale
    // all afternoon is worse than a wake-up a minute.
    const h: Record<string, SignageHorizon> = { "out-1": [entry(NOW, NOW + 8 * 3600_000)] };
    assert.equal(nextWakeMs(h, NOW), SAFETY_TICK_MS);
  });

  test("never zero or negative, however stale the horizon is", () => {
    // A boundary already in the past would arm a zero-delay timer that re-arms
    // itself immediately - a busy loop on a Pi.
    const h: Record<string, SignageHorizon> = { "out-1": [entry(NOW - 10_000, NOW - 5_000)] };
    const wake = nextWakeMs(h, NOW);
    assert.ok(wake > 0, `the scheduler would spin: ${wake}`);
  });

  test("with no outputs at all, still the safety tick", () => {
    assert.equal(nextWakeMs({}, NOW), SAFETY_TICK_MS);
  });

  test("with an empty horizon for an output, still the safety tick", () => {
    assert.equal(nextWakeMs({ "out-1": [] }, NOW), SAFETY_TICK_MS);
  });

  test("looks past an entry that has already ended", () => {
    // The first entry is stale; the real next boundary is the second one's end.
    const h: Record<string, SignageHorizon> = {
      "out-1": [entry(NOW - 10_000, NOW - 5_000), entry(NOW - 5_000, NOW + 20_000)],
    };
    assert.equal(nextWakeMs(h, NOW), 20_000);
  });
});

describe("keeping a playlist where it is", () => {
  // A display derives its position in the cycle from `startedAt`, and the
  // resolver stamps the entry covering NOW with the instant of the rebuild. So
  // every rebuild sent every wall back to its first graphic.
  //
  // Measured against the real server before fixing it: 60,004 ms apart with no
  // edits at all. The safety tick alone was restarting every signage screen in
  // the building once a minute, and rebroadcasting the whole map to do it.

  const entry = (o: {
    from: number;
    until: number;
    playlistId?: string;
    startedAt?: number;
    reason?: string;
    reasonId?: string;
  }): SignageHorizonEntry => ({
    from: o.from,
    until: o.until,
    reason: (o.reason ?? "schedule") as SignageHorizonEntry["reason"],
    reasonLabel: o.reasonId ?? "s1",
    ...(o.reasonId === undefined ? { reasonId: "s1" } : { reasonId: o.reasonId }),
    ...(o.playlistId
      ? {
          playlist: {
            id: o.playlistId,
            startedAt: o.startedAt ?? o.from,
            fit: "contain" as const,
            transition: { kind: "cut" as const, ms: 0 },
            items: [],
          },
        }
      : {}),
  });

  test("the same playlist keeps the start it already had", () => {
    const before = { "o1": [entry({ from: 1000, until: 9000, playlistId: "p1" })] };
    // Rebuilt a moment later: same content, `from` moved to the rebuild instant.
    const next = { "o1": [entry({ from: 5000, until: 9000, playlistId: "p1" })] };
    const out = carryStartedAt(before, next);
    assert.equal(out["o1"][0].playlist?.startedAt, 1000, "the wall was sent back to its first graphic");
    // `from` is carried BACK too, and that is the truthful value: it is when
    // this content began, not when the server last thought about it. The
    // resolver only writes the rebuild instant there because the horizon it
    // builds starts at now. Everything that reads a horizon tests
    // `from <= now < until`, which a past `from` satisfies — and leaving it
    // moving is what kept the map differing every minute.
    assert.equal(out["o1"][0].from, 1000);
    assert.equal(out["o1"][0].until, 9000, "the END is a real boundary and must not move");
  });

  test("so an unchanged config produces an identical map, and nothing is sent", () => {
    // The other half of the bug: a moved start made every rebuild differ, so the
    // safety tick broadcast a "change" every minute forever.
    const before = { "o1": [entry({ from: 1000, until: 9000, playlistId: "p1" })] };
    const next = { "o1": [entry({ from: 5000, until: 9000, playlistId: "p1" })] };
    assert.equal(shouldBroadcast(before, carryStartedAt(before, next)), false);
  });

  test("a DIFFERENT playlist starts fresh", () => {
    const before = { "o1": [entry({ from: 1000, until: 9000, playlistId: "p1" })] };
    const next = { "o1": [entry({ from: 5000, until: 9000, playlistId: "p2" })] };
    assert.equal(carryStartedAt(before, next)["o1"][0].playlist?.startedAt, 5000);
  });

  test("the same playlist for a DIFFERENT reason starts fresh", () => {
    // A take-over that happens to name the playlist a schedule was already
    // playing is still a take-over: it begins, rather than resuming.
    const before = { "o1": [entry({ from: 1000, until: 9000, playlistId: "p1", reason: "schedule" })] };
    const next = { "o1": [entry({ from: 5000, until: 9000, playlistId: "p1", reason: "override" })] };
    assert.equal(carryStartedAt(before, next)["o1"][0].playlist?.startedAt, 5000);
  });

  test("and the same playlist from a different SCHEDULE starts fresh", () => {
    const before = { "o1": [entry({ from: 1000, until: 9000, playlistId: "p1", reasonId: "s1" })] };
    const next = { "o1": [entry({ from: 5000, until: 9000, playlistId: "p1", reasonId: "s2" })] };
    assert.equal(carryStartedAt(before, next)["o1"][0].playlist?.startedAt, 5000);
  });

  test("a start is not carried across a gap", () => {
    // Matched by OVERLAP, not by identity alone. The same playlist scheduled
    // again this evening is a new showing, not the morning's still running.
    const before = { "o1": [entry({ from: 1000, until: 2000, playlistId: "p1" })] };
    const next = { "o1": [entry({ from: 50_000, until: 60_000, playlistId: "p1" })] };
    assert.equal(carryStartedAt(before, next)["o1"][0].playlist?.startedAt, 50_000);
  });

  test("an output that is new gets its horizon unchanged", () => {
    const out = carryStartedAt({}, { "o2": [entry({ from: 5000, until: 9000, playlistId: "p1" })] });
    assert.equal(out["o2"][0].playlist?.startedAt, 5000);
  });

  test("with no previous map at all, nothing is carried", () => {
    const next = { "o1": [entry({ from: 5000, until: 9000, playlistId: "p1" })] };
    assert.equal(carryStartedAt(null, next), next);
  });

  test("a blank entry survives untouched", () => {
    const next = { "o1": [entry({ from: 5000, until: 9000 })] };
    assert.deepEqual(carryStartedAt({ "o1": [entry({ from: 1000, until: 9000 })] }, next), next);
  });
});
