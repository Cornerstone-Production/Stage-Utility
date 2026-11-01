import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectAttention } from "./collect.js";
import { healthyLine } from "./healthy.js";
import { attentionInput, integration, mic } from "./test-input.js";

const outputs = [
  { id: "a", name: "A", viewId: "v" },
  { id: "b", name: "B", viewId: "v" },
  { id: "bare", name: "Bare", viewId: null },
];

describe("healthyLine", () => {
  it("counts the screens that are up, the mics that are fine, and names each healthy integration", () => {
    const input = attentionInput({
      mood: "live",
      minutesLeft: 60,
      state: { pcoConfigured: true, planId: "p", views: [{ id: "home" }, { id: "x" }, { id: "y" }], outputs } as unknown as StageState,
      onlineOutputIds: ["a"],
      assigned: new Map([["rx::1", "Lead"], ["rx::2", "Host"]]),
      wireless: [mic("rx::1", { batteryMinutes: 5 }), mic("rx::2")],
      integrations: [integration("propresenter"), integration("obs", { connection: "error" }), integration("companion", { inbound: true })],
      downSince: new Map([["obs", 0]]),
      integrationLabels: { propresenter: "ProPresenter", obs: "OBS", companion: "Companion" },
    });
    assert.deepEqual(healthyLine(input, collectAttention(input)), ["1 of 2 screens", "1 of 2 mics", "ProPresenter"]);
  });

  it("a source that has not answered says nothing", () => {
    const input = attentionInput({ onlineKnown: false, wirelessKnown: false, integrationsKnown: false, state: { outputs } as unknown as StageState });
    assert.deepEqual(healthyLine(input, []), []);
  });

  it("a count of none is not called healthy: no '0 of 2 screens', no '0 of 1 mics'", () => {
    const input = attentionInput({
      state: { outputs: outputs.slice(0, 2), pcoConfigured: true } as unknown as StageState,
      onlineOutputIds: [],
      assigned: new Map([["rx::1", "Lead"]]),
      wireless: [mic("rx::1", { online: false })],
    });
    assert.deepEqual(healthyLine(input, []), []);
  });

  it("streaming platforms say what they are doing, once their status has answered", () => {
    const base = {
      integrations: [integration("resi"), integration("youtube")],
      integrationLabels: { resi: "Resi", youtube: "YouTube" },
    };
    const st = (live: boolean) => ({ connected: true, live, startedAt: null, detail: null });
    assert.deepEqual(healthyLine(attentionInput({ ...base, resi: st(true), youtube: st(false) }), []), ["Resi streaming", "YouTube idle"]);
    assert.deepEqual(healthyLine(attentionInput({ ...base, resi: null, resiKnown: false, youtube: st(false) }), []), ["YouTube idle"]);
  });
});
