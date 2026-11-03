import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectAttention } from "./collect.js";
import { attentionInput, integration, mic } from "./test-input.js";

describe("collectAttention", () => {
  it("orders critical before warn, then by source in table order, then by subject name", () => {
    const input = attentionInput({
      mood: "live",
      now: 1_000_000_000_000,
      minutesLeft: 60,
      state: { pcoConfigured: false, planId: "p", views: [{ id: "home" }, { id: "a" }, { id: "b" }], outputs: [{ id: "o", name: "Zed TV", viewId: "v" }, { id: "p2", name: "Alpha TV", viewId: "v" }] } as unknown as StageState,
      assigned: new Map([["rx::1", "Lead"], ["rx::2", "Host"]]),
      wireless: [mic("rx::1", { name: "Zeta", batteryMinutes: 10 }), mic("rx::2", { name: "Alpha", batteryMinutes: 10 })],
      integrations: [integration("propresenter", { connection: "error" })],
      downSince: new Map([["propresenter", 0]]),
      integrationLabels: { propresenter: "ProPresenter" },
    });
    assert.deepEqual(
      collectAttention(input).map((i) => `${i.severity}:${i.title}`),
      [
        // critical: wireless-battery (by name), then screen-offline (by name)
        "critical:Alpha at 90%",
        "critical:Zeta at 90%",
        "critical:Alpha TV is offline",
        "critical:Zed TV is offline",
        // warn: readiness (its own order), then integration-down
        "warn:Planning Center is not connected",
        "warn:ProPresenter has an error",
      ],
    );
  });

  it("is empty when nothing is wrong", () => {
    assert.deepEqual(collectAttention(attentionInput({
      state: { pcoConfigured: true, planId: "p", views: [{ id: "home" }, { id: "a" }, { id: "b" }], outputs: [{ id: "o", name: "T", viewId: "v" }] } as unknown as StageState,
      onlineOutputIds: ["o"],
    })), []);
  });
});
