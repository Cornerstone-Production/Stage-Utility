// A card that changes group slides there; a card that changed nothing sits still.
//
// useSlideOnMove re-runs its FLIP whenever the signature it is handed changes,
// so the signature has to answer exactly one question: has any integration
// crossed between the two grids? Carry more — a connection state, a message —
// and every SSE push slides sixteen cards that never moved. Carry less and a
// real move teleports.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { moveSignature } from "./integrations-panel.js";

const state = (id: string, over: Partial<IntegrationState> = {}): IntegrationState =>
  ({
    id,
    enabled: false,
    connection: "disconnected",
    message: null,
    config: {},
    configured: false,
    ...over,
  }) as IntegrationState;

const BASE = [state("obs"), state("reaper"), state("resi")];

describe("the move signature", () => {
  test("changes when an integration is enabled into the other grid", () => {
    const after = [state("obs", { enabled: true }), state("reaper"), state("resi")];
    assert.notEqual(moveSignature(BASE), moveSignature(after));
  });

  test("changes when one goes into an error state, which pulls it up", () => {
    // isInUse counts connection === "error", so an erroring integration leaves
    // the dormant group. That IS a move, and it has to animate like one.
    const after = [state("obs", { connection: "error", message: "unreachable" }), state("reaper"), state("resi")];
    assert.notEqual(moveSignature(BASE), moveSignature(after));
  });

  test("does not change when a connection goes up or down within the same grid", () => {
    const live = [state("obs", { enabled: true }), state("reaper"), state("resi")];
    const connected = [
      state("obs", { enabled: true, connection: "connected" }),
      state("reaper"),
      state("resi"),
    ];
    const connecting = [
      state("obs", { enabled: true, connection: "connecting", message: "dialling" }),
      state("reaper"),
      state("resi"),
    ];
    assert.equal(moveSignature(live), moveSignature(connected));
    assert.equal(moveSignature(live), moveSignature(connecting));
  });

  test("does not change when only the config does", () => {
    const edited = [state("obs", { config: { host: "192.0.2.4" } }), state("reaper"), state("resi")];
    assert.equal(moveSignature(BASE), moveSignature(edited));
  });

  test("names every integration, so a move is attributable to one of them", () => {
    assert.equal(moveSignature(BASE), "obs:0|reaper:0|resi:0");
  });
});
