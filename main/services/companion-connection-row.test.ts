// THREE writers, one message on the Companion integration row.
//
// Two independent facts share that one line: how many Companion modules are
// dialled IN, and what this app found when it last dialled OUT. Three places
// write it and none of them knew about the others — a module's SSE stream
// opening or closing, the hourly reconcile's connection-health read, and the
// Test button. Whichever ran last was the whole message:
//
//  - a module reconnecting five minutes after a reconcile wiped "12 of 52
//    connection(s) in error", with nothing to bring it back for an hour;
//  - a reconcile on a box with two Stream Decks attached wiped the count that is
//    the row's whole reason to say "connected";
//  - and a module connecting after a FAILED Test wiped "Cannot reach Companion"
//    and flipped the row from error back to connected — erasing exactly the
//    thing companion-info-panel.tsx was changed to surface.
//
// The third was missed the first time this file was written, which is why the
// header now counts them. It was found by driving the real manager, not by this
// file: the first version of it only exercised two of the three, so the model it
// asserted and the model that was wrong were the same model.
//
// Driven through the REAL integrationManager, including its `test()` entry
// point, because the bug IS the entry points — a pure helper for the joining
// would be green with any one of them writing the row directly again.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "companion-row-"));

const { integrationManager } = await import("./integration-manager.js");
const { companionDeps } = await import("./companion-api.js");

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

const realFetch = companionDeps.fetch;

/** Seed the row, optionally with an outbound host so `test()` dials. */
function seed(config: Record<string, unknown> = {}): void {
  states.set("companion", {
    id: "companion",
    enabled: true,
    connection: "disconnected",
    message: null,
    config,
  });
  integrationManager.setCompanionClients(0);
  integrationManager.setCompanionOutbound(null);
}

beforeEach(() => seed());

afterEach(() => {
  companionDeps.fetch = realFetch;
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
    integrationManager.setCompanionOutbound("12 of 52 connection(s) in error, 10 not reporting");
    assert.equal(row().message, "12 of 52 connection(s) in error, 10 not reporting");
  });

  test("both, in the order an operator reads them", () => {
    integrationManager.setCompanionClients(1);
    integrationManager.setCompanionOutbound("52 connection(s) ok");
    assert.equal(row().message, "1 Companion client(s) connected. 52 connection(s) ok");
  });

  // The bug this file exists for, in both directions.
  test("a module connecting does NOT erase the health", () => {
    integrationManager.setCompanionOutbound("12 of 52 connection(s) in error");
    integrationManager.setCompanionClients(3);
    assert.match(row().message ?? "", /12 of 52 connection\(s\) in error/);
  });

  test("a health read does NOT erase the client count", () => {
    integrationManager.setCompanionClients(3);
    integrationManager.setCompanionOutbound("52 connection(s) ok");
    assert.match(row().message ?? "", /3 Companion client\(s\) connected/);
  });

  test("a module dropping to zero keeps the health and loses only the count", () => {
    integrationManager.setCompanionClients(3);
    integrationManager.setCompanionOutbound("52 connection(s) ok");
    integrationManager.setCompanionClients(0);
    assert.equal(row().message, "52 connection(s) ok");
    assert.equal(row().connection, "disconnected");
  });

  test("null clears the health without touching the count — a host that changed", () => {
    integrationManager.setCompanionClients(2);
    integrationManager.setCompanionOutbound("12 of 52 connection(s) in error");
    integrationManager.setCompanionOutbound(null);
    assert.equal(row().message, "2 Companion client(s) connected");
  });

  // Gear behind Companion being down is a fact about the building, not about
  // whether this integration works.
  test("connections in error do NOT put the row in error", () => {
    integrationManager.setCompanionClients(1);
    integrationManager.setCompanionOutbound("12 of 52 connection(s) in error");
    assert.equal(row().connection, "connected");
  });
});

/**
 * The THIRD writer, through the manager's own `test()`.
 *
 * Every case here has a Companion host configured and a fetch that cannot
 * reach it — an operator pressing Test on a box that is switched off, which is
 * the ordinary way this row goes into error. The reconcile is not reached: the
 * manager only runs it when the outbound test SUCCEEDS.
 */
describe("a Test that could not reach Companion", () => {
  const unreachable = () => {
    seed({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => {
      throw new TypeError("fetch failed");
    };
  };

  test("puts the row in error and says why", async () => {
    unreachable();
    const r = await integrationManager.test("companion");
    assert.equal(r.ok, false);
    assert.equal(row().connection, "error");
    assert.match(row().message ?? "", /Cannot reach Companion/);
  });

  // The bug. A Stream Deck attaching has nothing to say about whether this app
  // can reach Companion, and it used to be the whole message.
  test("a module connecting afterwards does NOT erase the reason", async () => {
    unreachable();
    await integrationManager.test("companion");
    integrationManager.setCompanionClients(1);
    assert.match(row().message ?? "", /Cannot reach Companion/);
    assert.match(row().message ?? "", /1 Companion client\(s\) connected/);
  });

  test("a module connecting afterwards does NOT flip the row out of error", async () => {
    unreachable();
    await integrationManager.test("companion");
    integrationManager.setCompanionClients(1);
    assert.equal(row().connection, "error");
  });

  // The other direction: the reconcile only reaches its health read having just
  // read the export off the same Companion, so it is newer evidence than a Test
  // that failed an hour ago and the error is right to clear.
  test("a later health read supersedes it, error and all", async () => {
    unreachable();
    await integrationManager.test("companion");
    integrationManager.setCompanionOutbound("52 connection(s) ok");
    assert.equal(row().connection, "disconnected");
    assert.equal(row().message, "52 connection(s) ok");
  });

  // The returned message is the dialog footer's one-shot answer and composes
  // nothing, so it carries both halves. The ROW must not then print the client
  // count twice.
  test("the client count appears once on the row and once in the answer", async () => {
    unreachable();
    integrationManager.setCompanionClients(2);
    const r = await integrationManager.test("companion");
    assert.match(r.message ?? "", /^2 Companion client\(s\) connected\. Cannot reach Companion/);
    assert.equal((row().message ?? "").match(/Companion client\(s\) connected/g)?.length, 1);
  });

  // With no host there is nothing outbound to say, and the slot is cleared
  // rather than left holding the last host's answer.
  test("removing the host clears what the last Test said", async () => {
    unreachable();
    await integrationManager.test("companion");
    seed();
    integrationManager.setCompanionClients(1);
    const r = await integrationManager.test("companion");
    assert.equal(r.ok, true);
    assert.equal(row().connection, "connected");
    assert.equal(row().message, "1 Companion client(s) connected");
  });
});
