// The duplicate-id check's schedule, with no socket and a fake clock.
//
// The socket half is driven over real UDP in kiosk-responder-duplicate.test.ts.
// Here the send is a promise this test resolves by hand and setTimeout is mocked,
// so the cases that depend on ordering (a send that resolves after a newer round
// began) can be built exactly rather than hoped for under load.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import type { DuplicateCheck } from "../types/kiosk.js";

const { startDuplicateCheck, stopDuplicateCheck, heardDuplicate, recheckFromScratch, duplicateCheckState } = await import(
  "./kiosk-duplicate-check.js"
);

const RECHECK = 60_000;
const WINDOW = 3_000;

/** Every send, in order, each resolved by the test. */
let sends: { resolve: (failure: string | null) => void }[] = [];
const reports: DuplicateCheck[] = [];
const realLog = console.log;
const realWarn = console.warn;
const logged: string[] = [];

/** Let the promise continuations run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const flagged = () => duplicateCheckState().duplicates.map((d) => d.address);

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  sends = [];
  reports.length = 0;
  logged.length = 0;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  console.warn = (...a: unknown[]) => logged.push(a.join(" "));
  startDuplicateCheck({
    send: () => new Promise((resolve) => sends.push({ resolve })),
    serverId: () => "srv",
    port: 8789,
    recheckMs: RECHECK,
    replyWindowMs: WINDOW,
    onChange: (s) => reports.push(s),
  });
});

afterEach(() => {
  stopDuplicateCheck();
  mock.timers.reset();
  console.log = realLog;
  console.warn = realWarn;
});

/** Let the round in flight go out, and its window close. */
async function round(failure: string | null = null) {
  sends[sends.length - 1].resolve(failure);
  await flush();
  if (failure === null) mock.timers.tick(WINDOW);
  await flush();
}

/** Wait for the re-check, then run that round. */
async function nextRound(failure: string | null = null) {
  const before = sends.length;
  mock.timers.tick(RECHECK);
  await flush();
  assert.equal(sends.length, before + 1, "no re-check went out");
  await round(failure);
}

describe("the schedule", () => {
  test("a round goes out at start, and with nothing heard nothing follows: no timer runs", async () => {
    assert.equal(sends.length, 1);
    await round();
    assert.equal(duplicateCheckState().check.state, "ok");
    mock.timers.tick(RECHECK * 10);
    await flush();
    assert.equal(sends.length, 1, "a healthy server kept checking on a timer");
  });

  test("evidence heard while nothing runs starts a round at once, so the flag has one to clear by", async () => {
    await round();
    heardDuplicate("192.0.2.60", "it checked for this id");
    await flush();
    assert.equal(sends.length, 2);
  });

  test("an address clears after TWO silent counted rounds, not one", async () => {
    heardDuplicate("192.0.2.60", "it answered this server's check", { url: "http://192.0.2.60:8788", name: "Other" });
    await round();
    await nextRound();
    assert.deepEqual(flagged(), ["192.0.2.60"], "cleared after one silent round: one lost datagram flickers the flag");
    await nextRound();
    assert.deepEqual(flagged(), []);
    assert.equal(logged.filter((l) => l.includes("192.0.2.60 no longer answers as this server")).length, 1);
  });

  test("a failed send while flagged retries on the same schedule, logged once", async () => {
    heardDuplicate("192.0.2.60", "it checked for this id");
    await round("192.0.2.255: EHOSTUNREACH");
    assert.equal(duplicateCheckState().check.state, "failed");
    await nextRound("192.0.2.255: EHOSTUNREACH");
    await nextRound("192.0.2.255: EHOSTUNREACH");
    assert.equal(logged.filter((l) => l.includes("could not send the duplicate-id check on udp/8789")).length, 1);
  });

  test("OVERLAPPING ROUNDS COUNT ONCE: a send that resolves after a newer round began is ignored", async () => {
    // Round 1 is still sending when the id changes and round 2 begins.
    recheckFromScratch();
    assert.equal(sends.length, 2);
    heardDuplicate("192.0.2.60", "it checked for this id");
    // Both sends resolve; only round 2's window may be counted.
    sends[0].resolve(null);
    sends[1].resolve(null);
    await flush();
    mock.timers.tick(WINDOW);
    await flush();
    // One silent round now must not clear it: a stale round counted twice would.
    await nextRound();
    assert.deepEqual(flagged(), ["192.0.2.60"], "a stale round was counted: the flag cleared after one silent round");
  });

  test("a send that resolves after stop changes nothing", async () => {
    stopDuplicateCheck();
    const after = reports.length;
    sends[0].resolve(null);
    await flush();
    mock.timers.tick(WINDOW);
    await flush();
    assert.equal(reports.length, after);
    assert.equal(duplicateCheckState().check.state, "off");
  });
});
