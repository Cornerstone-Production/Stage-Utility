import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attentionInput, mic } from "../test-input.js";
import { wirelessBattery } from "./wireless-battery.js";

const assigned = new Map([["rx::1", "Worship lead"]]);
const run = (over: Parameters<typeof attentionInput>[0], ch = mic("rx::1")) =>
  wirelessBattery.items(attentionInput({ assigned, wireless: [ch], ...over }));

describe("wireless-battery source", () => {
  it("fires when the runtime is less than the time left, critical while live", () => {
    const [item] = run({ mood: "live", minutesLeft: 52 }, mic("rx::1", { name: "Handheld 3", battery: 19, batteryMinutes: 40 }));
    assert.equal(item.severity, "critical");
    assert.equal(item.key, "wireless-battery:rx::1");
    assert.equal(item.title, "Handheld 3 at 19%");
    assert.equal(item.detail, "Worship lead · about 40 min left, service has 52 to go");
    assert.deepEqual(item.fix, { label: "Open slots", route: "/mic-slots" });
  });

  it("is a warn when not live", () => {
    assert.equal(run({ mood: "idle", minutesLeft: 52 }, mic("rx::1", { batteryMinutes: 40 }))[0].severity, "warn");
  });

  it("boundary: minutes left EQUAL to the time left does not fire; one less does", () => {
    assert.deepEqual(run({ mood: "live", minutesLeft: 40 }, mic("rx::1", { batteryMinutes: 40, battery: 50 })), []);
    assert.equal(run({ mood: "live", minutesLeft: 40 }, mic("rx::1", { batteryMinutes: 39, battery: 50 })).length, 1);
  });

  it("falls back to 20% when the receiver reports no runtime, and at exactly 20 fires, at 21 does not", () => {
    assert.equal(run({ mood: "live", minutesLeft: 52 }, mic("rx::1", { batteryMinutes: null, battery: 20 })).length, 1);
    assert.deepEqual(run({ mood: "live", minutesLeft: 52 }, mic("rx::1", { batteryMinutes: null, battery: 21 })), []);
  });

  it("falls back to 20% when the time left is not known, ignoring a long runtime", () => {
    assert.equal(run({ minutesLeft: null }, mic("rx::1", { batteryMinutes: 600, battery: 15 })).length, 1);
    assert.deepEqual(run({ minutesLeft: null }, mic("rx::1", { batteryMinutes: 5, battery: 80 })), []);
  });

  it("ignores a channel in no slot, a pack on a charger, and an offline one", () => {
    const low = { battery: 5, batteryMinutes: 3 };
    assert.deepEqual(run({ minutesLeft: 60, assigned: new Map() }, mic("rx::1", low)), []);
    assert.deepEqual(run({ minutesLeft: 60 }, mic("rx::1", { ...low, charging: true })), []);
    assert.deepEqual(run({ minutesLeft: 60 }, mic("rx::1", { ...low, online: false })), []);
  });

  it("unknown contributes nothing", () => {
    assert.deepEqual(run({ wirelessKnown: false, minutesLeft: 60 }, mic("rx::1", { battery: 1, batteryMinutes: 1 })), []);
  });
});
