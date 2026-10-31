// When an output last reported in -- the half of displays:presence that tells an
// operator "Lobby TV dropped 4 minutes ago" rather than only "Lobby TV is not
// connected".

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

const { displayHeartbeat, displayLeaving, presenceSnapshot, setKnownOutputIds, sweepPresence } = await import("./display-presence.js");
const { addBroadcastListener } = await import("./broadcaster.js");
type PresenceSnapshot = import("./display-presence.js").PresenceSnapshot;

const sent: PresenceSnapshot[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "displays:presence") sent.push(payload as PresenceSnapshot);
});

const seenAt = (snap: PresenceSnapshot, id: string) => snap.lastSeen.find(([k]) => k === id)?.[1];

describe("displays:presence lastSeen", () => {
  it("is on the snapshot, as [outputId, epochMs] pairs, and on the change that carries it", () => {
    const t0 = Date.now();
    displayHeartbeat("out-a");
    const snap = presenceSnapshot();
    assert.deepEqual(snap.connected.includes("out-a"), true);
    const at = seenAt(snap, "out-a");
    assert.ok(at !== undefined && at >= t0 && at <= Date.now(), "a pair stamped with the heartbeat's time");
    const frame = sent.at(-1);
    assert.equal(seenAt(frame!, "out-a"), at, "the broadcast the change produced carries it too");
    assert.equal(frame!.rev, snap.rev);
  });

  it("an output with no heartbeat has no entry", () => {
    assert.equal(seenAt(presenceSnapshot(), "never-reported"), undefined);
  });

  it("survives the output leaving: gone from connected, still remembered", () => {
    displayHeartbeat("out-b");
    const at = seenAt(presenceSnapshot(), "out-b");
    displayLeaving("out-b");
    const snap = presenceSnapshot();
    assert.ok(!snap.connected.includes("out-b"));
    assert.equal(seenAt(snap, "out-b"), at, "the time it dropped is what Home reports");
    assert.equal(seenAt(sent.at(-1)!, "out-b"), at, "and the broadcast of it says so");
  });

  it("a returning output is connected again with a fresh time", () => {
    displayHeartbeat("out-b");
    assert.ok(presenceSnapshot().connected.includes("out-b"));
    assert.equal(presenceSnapshot().lastSeen.filter(([k]) => k === "out-b").length, 1, "one entry per output");
  });

  it("is sorted by id", () => {
    const ids = presenceSnapshot().lastSeen.map(([k]) => k);
    assert.deepEqual(ids, [...ids].sort());
  });
});

describe("what is published is bounded", () => {
  it("with 1000 random ids posted, the payload carries only the known outputs", () => {
    setKnownOutputIds(() => new Set(["out-a", "out-b"]));
    try {
      for (let i = 0; i < 1000; i++) displayHeartbeat(`rand-${Math.random().toString(36).slice(2)}-${i}`);
      const ids = presenceSnapshot().lastSeen.map(([k]) => k);
      assert.ok(ids.length <= 2, `${ids.length} pairs published`);
      assert.ok(ids.every((k) => k === "out-a" || k === "out-b"));
      assert.equal(seenAt(sent.at(-1)!, "rand-x"), undefined);
      assert.ok(sent.at(-1)!.lastSeen.length <= 2, "the broadcast is bounded too");
    } finally {
      setKnownOutputIds(null);
    }
  });

  it("an id longer than 128 characters is ignored", () => {
    displayHeartbeat("x".repeat(129));
    assert.equal(seenAt(presenceSnapshot(), "x".repeat(129)), undefined);
    displayHeartbeat("x".repeat(128));
    assert.ok(seenAt(presenceSnapshot(), "x".repeat(128)) !== undefined);
  });

  it("the sweep forgets an output not heard from in 30 days", () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000_000_000 });
    try {
      displayHeartbeat("old-one");
      mock.timers.tick(31 * 24 * 60 * 60 * 1000);
      sweepPresence();
      assert.equal(seenAt(presenceSnapshot(), "old-one"), undefined);
    } finally {
      mock.timers.reset();
    }
  });
});
