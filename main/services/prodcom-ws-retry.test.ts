// While stuck on the SSE fallback, the WebSocket is retried on a CLOCK as well
// as on every third reconnect.
//
// The incident (18 Sep 2026): ProdCom refused every WebSocket upgrade from the
// moment 1.18.0 shipped the WebSocket path until ProdCom itself restarted at
// 00:38Z. The client then stayed on the SSE fallback for another 34 minutes,
// because the only retry rule counted SSE reconnects and a quiet, healthy SSE
// stream never reconnects. Nothing counted, so nothing asked again.
//
// Driven against the real client and the real ProdCom stub (a real socket, a
// real refused upgrade, a real SSE stream) with the retry interval overridden
// through the service's own seam. t.mock.timers is not an option here: faking
// setTimeout underneath undici's WebSocket breaks the client itself, which is
// why prodcom-websocket.test.ts overrides the constants too.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService, PROBE_USER_AGENT } from "./prodcom-service.js";
import { startProdComStub, type ProdComStub, type StubOptions } from "./fixtures/prodcom-stub.js";

const NOW = Date.parse("2026-09-18T23:50:00Z");

class TestProdCom extends ProdComService {
  protected override now(): number {
    return NOW;
  }
  protected override get heartbeatTimeoutMs(): number {
    return 5_000; // long: nothing here is testing the heartbeat
  }
  protected override get reconnectMs(): number {
    return 25;
  }
  /** The five-minute clock, in milliseconds, so the test takes one. */
  protected override get wsRetryIntervalMs(): number {
    return 120;
  }
  public get retryArmed(): boolean {
    return this.wsRetryArmed;
  }
  public get onWebSocketNow(): boolean {
    return this.onWebSocketTransport;
  }
  public settled(): Promise<void> {
    return this.priming;
  }
}

const CHANNELS = [{ id: "CH-A", name: "Lead TB", color: "#00F900" }];

async function connected(t: TestContext, options: StubOptions = {}): Promise<{ stub: ProdComStub; svc: TestProdCom }> {
  const stub = await startProdComStub({ channels: CHANNELS, ...options });
  const svc = new TestProdCom();
  t.after(async () => {
    svc.stop();
    await stub.close();
  });
  svc.configure("127.0.0.1", stub.port, null);
  return { stub, svc };
}

async function eventually(ready: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Real client upgrades only. The refused-upgrade probe (see
 *  prodcom-upgrade-probe.test.ts) hits the same path, and counting it here would
 *  make every refusal look like two attempts. */
const wsAttempts = (stub: ProdComStub): number =>
  stub.requests.filter((r) => r.url === "/api/v1/ws" && r.headers["user-agent"] !== PROBE_USER_AGENT).length;

describe("the fallback retries the websocket on a timer", () => {
  it("attempts the websocket again while the SSE stream is quiet and healthy", async (t) => {
    // The exact shape of the incident: the upgrade is refused, the SSE stream
    // opens and STAYS open with nothing to say. No reconnect ever happens, so
    // the every-third-reconnect rule can never fire.
    const { stub, svc } = await connected(t, { refuseWebSocket: true });
    // sseOpens counts the SERVER accepting the stream; the client arms the retry
    // when it sees the 200, which is a tick or two later.
    await eventually(() => svc.retryArmed, "the retry to be armed on the fallback");
    await svc.settled();
    assert.equal(wsAttempts(stub), 1, "only the first, refused upgrade so far");

    await eventually(() => wsAttempts(stub) >= 2, "a second websocket attempt on the timer");
    // The retry goes through the normal reconnect path rather than opening a
    // socket beside the live stream: the fallback is dropped, the upgrade is
    // refused again, and the fallback is reopened.
    await eventually(() => stub.sseOpens >= 2, "the fallback to be dropped and reopened");
  });

  it("does not arm the retry while the websocket is up", async (t) => {
    const { stub, svc } = await connected(t);
    // waitForUpgrades resolves when the SERVER accepted; the client's onopen is
    // what makes the WebSocket the live transport.
    await eventually(() => svc.onWebSocketNow, "the websocket to become the live transport");
    await svc.settled();
    assert.equal(svc.retryArmed, false, "a retry timer is ticking while the websocket is already up");

    // Well past the interval: nothing re-dials a transport that is working.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(wsAttempts(stub), 1, `expected no further upgrade attempts, saw ${wsAttempts(stub)}`);
  });

  it("comes back to the websocket when the box starts accepting it again", async (t) => {
    // ProdCom restarting is the case this exists for: the fallback is healthy
    // and quiet, so only the clock can notice the box will now upgrade.
    const stub = await startProdComStub({ channels: CHANNELS, refuseWebSocket: true });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);
    await eventually(() => stub.sseOpens === 1, "the fallback stream to open");

    stub.setRefuseWebSocket(false); // ProdCom is back
    await eventually(() => svc.onWebSocketNow, "the websocket to become the live transport");
    assert.equal(svc.retryArmed, false, "the retry must be disarmed once the websocket is up");
  });

  it("stop() clears the retry", async (t) => {
    const { stub, svc } = await connected(t, { refuseWebSocket: true });
    await eventually(() => svc.retryArmed, "the retry to be armed on the fallback");
    await svc.settled();

    svc.stop();
    assert.equal(svc.retryArmed, false, "a stopped service left a timer that will re-dial a box it has let go");
    const attempts = wsAttempts(stub);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(wsAttempts(stub), attempts, "a stopped service dialled the box again");
  });

});

// The every-third-reconnect rule is NOT re-tested here. It is covered by
// prodcom-websocket.test.ts "comes back to the websocket rather than staying on
// the fallback for ever", which leaves wsRetryIntervalMs at its real five
// minutes — so the second attempt it observes can only have come from the
// counter. A copy of that case in this file, where the interval is 120 ms, could
// be satisfied by the timer and would prove nothing about the counter.
