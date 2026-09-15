// A kicked OBS session must stay kicked.
//
// obs-websocket documents close code 4011 (`SessionInvalidated`) as "you must not
// automatically reconnect", and it is what the **Kick** button in OBS's session
// list sends. The adapter threw the close code away and the service called
// scheduleReconnect() unconditionally, so kicking the session started a loop: the
// operator pressed Kick, the app came straight back, and the only way out was to
// turn the integration off.
//
// THIS DRIVES A REAL SOCKET. The bug lived in the handover between two files —
// obs-protocol dropping the code and obs-service not asking for it — and a unit
// test of either half passes while the loop runs. So the test below points the
// real service at the stub obs-websocket v5 server in obs-server-harness.ts
// (RFC 6455 handshake, real frames, real close codes) and counts how many times
// the service comes back. obs-record-clock.test.ts drives the same stub, which
// is why it is a shared harness rather than a copy in each file.
//
// The control case is the part that makes this a guard rather than a delay: a
// close with an ordinary code MUST produce a reconnect inside the same window, or
// "no reconnect after 4011" would be satisfied by the app simply being slow.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-obs-close-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { obsService } = await import("./obs-service.js");
const { standDownReason, OBS_STAND_DOWN_CODES } = await import("./obs-protocol.js");
const { FakeObs } = await import("./obs-server-harness.js");

const fake = new FakeObs();

/**
 * Long enough for a reconnect to have happened and be visible.
 *
 * The backoff is shortened to 100ms below so this file does not spend thirty
 * seconds waiting out the real 3-second base. `capDelayMs` puts a 1-second floor
 * under a delay when a service schedule is loaded and none is here, so the window
 * is sized to cover both — and the control test is what proves it is wide enough.
 */
const RECONNECT_WINDOW_MS = 1600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForConnected(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (obsService.getLatest().connected) return;
    await sleep(20);
  }
  assert.fail("the service never connected to the stub OBS");
}

before(async () => {
  await fake.listen();
  // The real backoff, just faster. An own accessor shadows the prototype getter,
  // so scheduleReconnect() still does exactly what it does in production.
  Object.defineProperty(obsService, "reconnectBaseMs", { get: () => 100, configurable: true });
});

after(async () => {
  obsService.stop();
  await fake.close();
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

beforeEach(() => {
  obsService.stop();
  fake.reset();
});

describe("a close the service is meant to recover from", () => {
  test("reconnects, which is what makes the 4011 test below mean something", async () => {
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    assert.equal(fake.attempts.length, 1);

    fake.closeAll(1001); // "going away" — OBS restarting, a network blip
    await sleep(RECONNECT_WINDOW_MS);

    assert.ok(
      fake.attempts.length > 1,
      `no reconnect after an ordinary close in ${RECONNECT_WINDOW_MS}ms — the window is too short for the guard below to prove anything`,
    );
  });
});

describe("a close that says do not come back", () => {
  test("4011 SessionInvalidated stands the integration down", async () => {
    // THE BUG. Pressing Kick in OBS used to start a reconnect loop.
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    assert.equal(fake.attempts.length, 1);

    fake.closeAll(4011);
    await sleep(RECONNECT_WINDOW_MS);

    assert.equal(
      fake.attempts.length,
      1,
      `the service reconnected ${fake.attempts.length - 1} time(s) after a 4011 kick — obs-websocket documents 4011 as "you must not automatically reconnect"`,
    );
    assert.equal(obsService.getLatest().connected, false, "it stood down but still reported itself connected");
  });

  test("4009 AuthenticationFailed does not retry a password that will not change", async () => {
    // This one closes BEFORE the handshake finishes, so it reaches the service
    // as a rejected connect() rather than through onClose — a separate path that
    // had the same unconditional retry on it.
    fake.refuseIdentifyWith = 4009;
    obsService.configure("127.0.0.1", fake.port, "wrong-password");
    await sleep(RECONNECT_WINDOW_MS);

    assert.equal(
      fake.attempts.length,
      1,
      `retried a rejected password ${fake.attempts.length - 1} time(s); it will be rejected every time`,
    );
  });

  test("4010 UnsupportedRpcVersion does not retry an RPC version that will not change", async () => {
    fake.refuseIdentifyWith = 4010;
    obsService.configure("127.0.0.1", fake.port, null);
    await sleep(RECONNECT_WINDOW_MS);

    assert.equal(fake.attempts.length, 1, "retried an RPC version OBS has already refused");
  });

  test("a code OBS never sends is not treated as a stand-down", async () => {
    // 4002-4008 and 4012 describe a MESSAGE this client got wrong, not a session
    // that is over. Retrying is right for them, and for anything undocumented.
    fake.refuseIdentifyWith = 4008; // AlreadyIdentified
    obsService.configure("127.0.0.1", fake.port, null);
    await sleep(RECONNECT_WINDOW_MS);

    assert.ok(fake.attempts.length > 1, "stood down on a code that only describes a bad message");
  });
});

describe("the stand-down table", () => {
  test("holds exactly the three codes a retry cannot help", () => {
    // EXACT, not a floor. Values from obs-websocket protocol.md's
    // WebSocketCloseCode enum: 4009 AuthenticationFailed, 4010
    // UnsupportedRpcVersion, 4011 SessionInvalidated.
    assert.deepEqual([...OBS_STAND_DOWN_CODES.keys()].sort(), [4009, 4010, 4011]);
  });

  test("an absent code is not a stand-down", () => {
    // Our own close() passes no code. Reading that as "OBS told us to go away"
    // would make every teardown permanent.
    for (const code of [null, undefined, 1000, 1006, 4000, 4008, 4012]) {
      assert.equal(standDownReason(code), null, `close code ${String(code)} was read as a stand-down`);
    }
  });
});
