// Two writers, one message on the Companion integration row.
//
// The row's message is set from two places that know nothing about each other: a
// Companion module opening or closing its SSE stream, and the hourly reconcile's
// connection-health read. Each used to be the whole message, so whichever ran
// last erased the other — a module reconnecting five minutes after a reconcile
// wiped "12 of 52 connection(s) in error" with nothing to bring it back for an
// hour, and a reconcile on a box with two Stream Decks attached wiped the count
// that is the row's whole reason to say "connected".
//
// Driven through the REAL integrationManager, not a re-implementation of the
// joining, because the bug is the two entry points and a pure helper would be
// green with one of them writing the row directly again.
//
// The row's CONNECTION STATE is asserted to follow the client count alone.
// Companion answering while a bulb in an office is unplugged is not this
// integration being down, and a red row for that is a red row an operator learns
// to ignore.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "companion-row-"));

const { integrationManager } = await import("./integration-manager.js");

/**
 * Seed the one row under test rather than running the manager's init().
 *
 * init() is the whole appliance coming up — Planning Center, wireless, OSC,
 * SenSource — and none of it is what is under test. The row it would create for
 * Companion is exactly this one, and setConnectionState is a no-op for a row
 * that does not exist, so without the seed every assertion here would read the
 * same `undefined`.
 */
const states = (
  integrationManager as unknown as {
    states: Map<string, { id: string; enabled: boolean; connection: string; message: string | null; config: Record<string, unknown> }>;
  }
).states;

const row = () => {
  const s = integrationManager.getStates().find((x) => x.id === "companion");
  assert.ok(s, "no companion row — the seed below is looking at the wrong id");
  return s;
};

beforeEach(() => {
  states.set("companion", {
    id: "companion",
    enabled: true,
    connection: "disconnected",
    message: null,
    config: {},
  });
  integrationManager.setCompanionClients(0);
  integrationManager.setCompanionHealth(null);
});

describe("the Companion row's message", () => {
  test("with neither, it is empty rather than an empty sentence", () => {
    assert.equal(row().message, null);
    assert.equal(row().connection, "disconnected");
  });

  test("clients alone read as they always did", () => {
    integrationManager.setCompanionClients(2);
    assert.equal(row().message, "2 Companion client(s) connected");
    assert.equal(row().connection, "connected");
  });

  test("health alone is the whole message, with no leading full stop", () => {
    integrationManager.setCompanionHealth("12 of 52 connection(s) in error, 10 not reporting");
    assert.equal(row().message, "12 of 52 connection(s) in error, 10 not reporting");
  });

  test("both, in the order an operator reads them", () => {
    integrationManager.setCompanionClients(1);
    integrationManager.setCompanionHealth("52 connection(s) ok");
    assert.equal(row().message, "1 Companion client(s) connected. 52 connection(s) ok");
  });

  // The bug this file exists for, in both directions.
  test("a module connecting does NOT erase the health", () => {
    integrationManager.setCompanionHealth("12 of 52 connection(s) in error");
    integrationManager.setCompanionClients(3);
    assert.match(row().message ?? "", /12 of 52 connection\(s\) in error/);
  });

  test("a health read does NOT erase the client count", () => {
    integrationManager.setCompanionClients(3);
    integrationManager.setCompanionHealth("52 connection(s) ok");
    assert.match(row().message ?? "", /3 Companion client\(s\) connected/);
  });

  test("a module dropping to zero keeps the health and loses only the count", () => {
    integrationManager.setCompanionClients(3);
    integrationManager.setCompanionHealth("52 connection(s) ok");
    integrationManager.setCompanionClients(0);
    assert.equal(row().message, "52 connection(s) ok");
    assert.equal(row().connection, "disconnected");
  });

  test("null clears the health without touching the count — a host that changed", () => {
    integrationManager.setCompanionClients(2);
    integrationManager.setCompanionHealth("12 of 52 connection(s) in error");
    integrationManager.setCompanionHealth(null);
    assert.equal(row().message, "2 Companion client(s) connected");
  });

  // Gear behind Companion being down is a fact about the building, not about
  // whether this integration works.
  test("connections in error do NOT put the row in error", () => {
    integrationManager.setCompanionClients(1);
    integrationManager.setCompanionHealth("12 of 52 connection(s) in error");
    assert.equal(row().connection, "connected");
  });
});
