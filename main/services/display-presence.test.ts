// When an output last reported in -- the half of displays:presence that tells an
// operator "Lobby TV dropped 4 minutes ago" rather than only "Lobby TV is not
// connected".

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { displayHeartbeat, displayLeaving, presenceSnapshot } = await import("./display-presence.js");
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
