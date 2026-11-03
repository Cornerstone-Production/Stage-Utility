import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attentionInput } from "../test-input.js";
import { readiness } from "./readiness.js";

const state = (over: Record<string, unknown>) =>
  ({ pcoConfigured: true, planId: "p", planTitle: "P", views: [{ id: "home" }, { id: "v" }, { id: "w" }], outputs: [], ...over }) as unknown as StageState;

describe("readiness source", () => {
  it("fires once per failing check, in readinessChecks' own order, as a warn", () => {
    const items = readiness.items(attentionInput({ state: state({ pcoConfigured: false, planId: null, views: [{ id: "home" }], outputs: [{ id: "o", name: "O", viewId: "v" }] }) }));
    assert.deepEqual(items.map((i) => i.key), ["readiness:pco", "readiness:plan", "readiness:views"]);
    assert.ok(items.every((i) => i.severity === "warn"));
    assert.equal(items[0].fix.route, "/settings/integrations");
    assert.equal(items[0].fix.flash, "pco-credentials");
  });

  it("does not fire when everything passes", () => {
    assert.deepEqual(readiness.items(attentionInput({ state: state({ outputs: [{ id: "o", name: "O", viewId: "v" }] }) })), []);
  });

  it("leaves 'Screens online' to the screen-offline source, so a dropped screen is listed once", () => {
    const items = readiness.items(attentionInput({ onlineOutputIds: [], state: state({ outputs: [{ id: "o", name: "Lobby", viewId: "v" }] }) }));
    assert.deepEqual(items, []);
  });

  it("with no screens at all, says so rather than blaming a screen", () => {
    const [item] = readiness.items(attentionInput({ state: state({ outputs: [] }) }));
    assert.equal(item.key, "readiness:assigned");
    assert.equal(item.title, "No screens set up yet");
  });

  it("a screen with no view is listed here", () => {
    const items = readiness.items(attentionInput({ state: state({ outputs: [{ id: "o", name: "Lobby", viewId: null }] }) }));
    assert.deepEqual(items.map((i) => i.key), ["readiness:assigned"]);
    assert.match(items[0].detail, /Lobby/);
  });
});
