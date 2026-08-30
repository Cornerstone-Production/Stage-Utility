// The health strip at the top of /log.
//
// The point of it is that a problem is VISIBLE without reading, so the two things
// that must not regress are: an integration that is configured and not connected
// shows as a problem, and it shows near the front.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { IntegrationState } from "../types/integrations.js";
import { buildLogChecks, checkStateFor } from "./log-checks.js";

function state(over: Partial<IntegrationState> & { id: string }): IntegrationState {
  return {
    enabled: true,
    connection: "connected",
    message: null,
    config: {},
    configured: true,
    ...over,
  };
}

const BASE = {
  version: "9.9.9-test",
  uptimeSec: 90,
  timeZone: "America/Chicago",
  followingHost: false,
  errors: 0,
  warnings: 0,
  descriptors: [
    { id: "lighting-desk", label: "Lighting desk" },
    { id: "stream-encoder", label: "Stream encoder" },
    { id: "surface-control", label: "Surface control" },
  ],
};

describe("checkStateFor", () => {
  test("switched off beats everything else", () => {
    assert.equal(checkStateFor(state({ id: "a", enabled: false, connection: "error" })), "off");
  });

  test("connected is ok", () => {
    assert.equal(checkStateFor(state({ id: "a", connection: "connected" })), "ok");
  });

  test("an inbound integration with nobody attached is idle, not a fault", () => {
    // Nothing dials it, so having no client is its resting state. Reporting that
    // as "down" is how a health strip trains an operator to ignore it.
    assert.equal(checkStateFor(state({ id: "a", connection: "disconnected", inbound: true })), "idle");
  });

  test("configured but not connected is the case worth showing", () => {
    assert.equal(checkStateFor(state({ id: "a", connection: "disconnected" })), "warn");
    assert.equal(checkStateFor(state({ id: "a", connection: "connecting" })), "warn");
    assert.equal(checkStateFor(state({ id: "a", connection: "error" })), "down");
  });
});

describe("buildLogChecks", () => {
  test("integrations nobody has set up are left out entirely", () => {
    const out = buildLogChecks({
      ...BASE,
      states: [
        state({ id: "lighting-desk", configured: false }),
        state({ id: "stream-encoder", configured: true }),
      ],
    });
    assert.deepEqual(
      out.integrations.map((i) => i.id),
      ["stream-encoder"],
      "five grey rows for things nobody configured is noise, not health",
    );
  });

  test("the worst state comes first", () => {
    const out = buildLogChecks({
      ...BASE,
      states: [
        state({ id: "lighting-desk", connection: "connected" }),
        state({ id: "stream-encoder", connection: "error", message: "refused" }),
        state({ id: "surface-control", connection: "disconnected" }),
      ],
    });
    assert.deepEqual(
      out.integrations.map((i) => i.state),
      ["down", "warn", "ok"],
    );
    assert.equal(out.integrations[0].label, "Stream encoder", "labels come from the descriptors");
    assert.equal(out.integrations[0].detail, "refused");
  });

  test("an integration with no descriptor still appears, under its id", () => {
    // Better a row named "some-new-thing" than an integration that quietly does
    // not exist on the one page you open when something is wrong.
    const out = buildLogChecks({ ...BASE, states: [state({ id: "some-new-thing" })] });
    assert.equal(out.integrations[0].label, "some-new-thing");
  });

  test("version, zone and counts are carried through", () => {
    const out = buildLogChecks({ ...BASE, errors: 3, warnings: 7, uptimeSec: 91.6, states: [] });
    assert.equal(out.version, "9.9.9-test");
    assert.equal(out.timeZone, "America/Chicago");
    assert.equal(out.followingHost, false);
    assert.equal(out.errors, 3);
    assert.equal(out.warnings, 7);
    assert.equal(out.uptimeSec, 92);
  });
});
