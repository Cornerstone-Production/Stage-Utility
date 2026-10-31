import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attentionInput, integration } from "../test-input.js";
import { DOWN_FOR_MS, integrationDown } from "./integration-down.js";

const NOW = 1_000_000_000_000;
const run = (over: Parameters<typeof attentionInput>[0]) =>
  integrationDown.items(
    attentionInput({
      now: NOW,
      integrationLabels: { propresenter: "ProPresenter", "planning-center": "Planning Center" },
      ...over,
    }),
  );

describe("integration-down source", () => {
  const down = (id: string, conn: "error" | "disconnected" = "disconnected") => integration(id, { connection: conn, message: "refused" });

  it("fires for an enabled integration down for MORE than 30 s; exactly 30 s does not", () => {
    const states = [down("propresenter")];
    assert.deepEqual(run({ integrations: states, downSince: new Map([["propresenter", NOW - DOWN_FOR_MS]]) }), []);
    const [item] = run({ integrations: states, downSince: new Map([["propresenter", NOW - DOWN_FOR_MS - 1]]) });
    assert.equal(item.key, "integration-down:propresenter");
    assert.equal(item.severity, "warn");
    assert.equal(item.title, "ProPresenter is not connected");
    assert.equal(item.detail, "refused");
    assert.deepEqual(item.fix, { label: "Open integration", route: "/settings/integrations", flash: "integration-propresenter" });
  });

  it("an error reads as an error", () => {
    const [item] = run({ integrations: [down("propresenter", "error")], downSince: new Map([["propresenter", 0]]) });
    assert.equal(item.title, "ProPresenter has an error");
  });

  it("Planning Center is critical while live and only a warn otherwise", () => {
    const since = new Map([["planning-center", 0]]);
    assert.equal(run({ mood: "live", integrations: [down("planning-center")], downSince: since })[0].severity, "critical");
    assert.equal(run({ mood: "idle", integrations: [down("planning-center")], downSince: since })[0].severity, "warn");
    assert.equal(run({ mood: "live", integrations: [down("propresenter")], downSince: new Map([["propresenter", 0]]) })[0].severity, "warn");
  });

  it("does not fire for a connected, disabled, not-set-up or inbound-only integration", () => {
    const since = new Map(["a", "b", "c", "d"].map((id) => [id, 0]));
    const states = [
      integration("a"),
      integration("b", { connection: "error", enabled: false }),
      integration("c", { connection: "error", configured: false }),
      integration("d", { connection: "disconnected", inbound: true }),
    ];
    assert.deepEqual(run({ integrations: states, downSince: since }), []);
  });

  it("does not fire for one this browser has not yet seen down", () => {
    assert.deepEqual(run({ integrations: [down("propresenter")], downSince: new Map() }), []);
  });

  it("unknown contributes nothing", () => {
    assert.deepEqual(run({ integrationsKnown: false, integrations: [down("propresenter")], downSince: new Map([["propresenter", 0]]) }), []);
  });
});
