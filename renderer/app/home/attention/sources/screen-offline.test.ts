import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attentionInput } from "../test-input.js";
import { lastSeenText, screenOffline } from "./screen-offline.js";

const NOW = 1_000_000_000_000;
const outputs = [
  { id: "lobby", name: "Lobby TV", viewId: "v" },
  { id: "bare", name: "Bare", viewId: null },
  { id: "stage", name: "Stage", viewId: "v" },
];
const run = (over: Parameters<typeof attentionInput>[0]) =>
  screenOffline.items(attentionInput({ now: NOW, state: { outputs } as unknown as StageState, onlineOutputIds: ["stage"], ...over }));

describe("screen-offline source", () => {
  it("fires for a routed screen with no heartbeat; critical and 'dropped' while live, with last seen", () => {
    const [item] = run({ mood: "live", lastSeen: new Map([["lobby", NOW - 4 * 60_000]]) });
    assert.equal(item.key, "screen-offline:lobby");
    assert.equal(item.severity, "critical");
    assert.equal(item.title, "Lobby TV dropped");
    assert.equal(item.detail, "last seen 4 min ago");
    assert.deepEqual(item.fix, { label: "Open screen", route: "/screens", flash: "screen-lobby" });
  });

  it("is a warn and 'is offline' when idle, and 'never connected' with no entry", () => {
    const [item] = run({ mood: "idle" });
    assert.equal(item.severity, "warn");
    assert.equal(item.title, "Lobby TV is offline");
    assert.equal(item.detail, "never connected");
  });

  it("leaves a screen with no view to readiness, and an online one alone", () => {
    assert.deepEqual(run({}).map((i) => i.key), ["screen-offline:lobby"]);
  });

  it("does not fire when every routed screen is online", () => {
    assert.deepEqual(run({ onlineOutputIds: ["lobby", "stage"] }), []);
  });

  it("unknown contributes nothing", () => {
    assert.deepEqual(run({ onlineKnown: false }), []);
  });

  it("says how long ago, at each scale", () => {
    assert.equal(lastSeenText(NOW, NOW), "last seen just now");
    assert.equal(lastSeenText(NOW - 59 * 60_000, NOW), "last seen 59 min ago");
    assert.equal(lastSeenText(NOW - 3 * 3_600_000, NOW), "last seen 3 h ago");
    assert.match(lastSeenText(NOW - 30 * 3_600_000, NOW), /^last seen \w+/);
    assert.equal(lastSeenText(undefined, NOW), "never connected");
  });
});
