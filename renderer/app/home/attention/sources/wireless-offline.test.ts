import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attentionInput, mic } from "../test-input.js";
import { wirelessOffline } from "./wireless-offline.js";

const assigned = new Map([["rx::2", "Pastor"]]);
const run = (over: Parameters<typeof attentionInput>[0], ch = mic("rx::2", { online: false, name: "Lav 2" })) =>
  wirelessOffline.items(attentionInput({ assigned, wireless: [ch], ...over }));

describe("wireless-offline source", () => {
  it("fires for an assigned channel that is offline, while live, as critical", () => {
    const [item] = run({ mood: "live" });
    assert.equal(item.key, "wireless-offline:rx::2");
    assert.equal(item.severity, "critical");
    assert.equal(item.title, "Lav 2 is offline");
    assert.equal(item.fix.route, "/mic-slots");
  });

  it("does not fire when idle: a pack in a drawer all week is not a fault", () => {
    assert.deepEqual(run({ mood: "idle" }), []);
  });

  it("does not fire for an online channel or one in no slot", () => {
    assert.deepEqual(run({ mood: "live" }, mic("rx::2", { online: true })), []);
    assert.deepEqual(run({ mood: "live", assigned: new Map() }), []);
  });

  it("unknown contributes nothing", () => {
    assert.deepEqual(run({ mood: "live", wirelessKnown: false }), []);
  });
});
