// The integration card must never claim "connected" from a transport that is
// not actually carrying anything.
//
// Reproduced on a real ProdCom 2.3.2 box: the card read "connected — Streaming
// from host:port" for 36 of 61 seconds with ProdCom entirely off, and again
// while the SSE endpoint answered 500 and an unproven WebSocket's handshake
// alone was enough to flip the card back. Both giveUpOnUnprovenWebSocket() and
// the unproven socket's own onopen called report("connected", ...)
// unconditionally, with no check on whether the SSE fallback was actually up —
// `this.req` being non-null is not that check, since it is set the instant the
// GET is issued, well before any response.
//
// Everything here runs the real client against fixtures/prodcom-stub.ts: real
// sockets, a real refused-or-failing SSE response, a real WebSocket handshake.
// Nothing on the network is contacted.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub } from "./fixtures/prodcom-stub.js";
import type { ConnState } from "./integration-base.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");

class TestProdCom extends ProdComService {
  public readonly reports: { state: ConnState; message: string | null }[] = [];

  constructor() {
    super();
    this.setConnectionListener((state, message) => this.reports.push({ state, message }));
  }

  protected override now(): number {
    return NOW;
  }
  protected override get reconnectMs(): number {
    return 20;
  }
  protected override get wsRetryIntervalMs(): number {
    return 30;
  }
  protected override get heartbeatTimeoutMs(): number {
    return 80;
  }
  /** Test seam: whether the SSE fallback is actually streaming right now. */
  public get sseUpNow(): boolean {
    return this.sseStreamUp;
  }
  /** Test seam: whether a WebSocket attempt is currently open, proven or not. */
  public get wsOpenNow(): boolean {
    return this.wsAttemptOpen;
  }
}

const CHANNELS = [{ id: "CH-A", name: "Lead TB", color: "#00F900" }];

async function eventually(ready: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function everReportedConnected(svc: TestProdCom): boolean {
  return svc.reports.some((r) => r.state === "connected");
}

describe('the card never reports "connected" from a transport that is not up', () => {
  it("stays off \"connected\" with ProdCom entirely off", async (t: TestContext) => {
    // A stub started and immediately closed: both the SSE GET and the
    // WebSocket upgrade land on a port nothing is listening on, exactly like
    // ProdCom powered off — not merely refusing one of the two endpoints.
    const stub = await startProdComStub({ channels: CHANNELS });
    const port = stub.port;
    await stub.close();

    const svc = new TestProdCom();
    t.after(() => svc.stop());
    svc.configure("127.0.0.1", port, null);

    // Long enough for several WebSocket connect-and-give-up cycles (30ms
    // apart) and several SSE reconnect attempts (20ms apart) on the closed
    // port — the real incident was a standing state over 61 seconds, not a
    // one-shot race, so this must hold across repeated retries too.
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(
      everReportedConnected(svc),
      false,
      `expected no "connected" report with ProdCom off, got ${JSON.stringify(svc.reports)}`,
    );
  });

  it('stays off "connected" when SSE answers 500 while the socket opens', async (t: TestContext) => {
    const stub = await startProdComStub({ channels: CHANNELS, failSseStream: true });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    // The handshake alone — before any transcript, before any give-up — is
    // the exact moment the old ws.onopen bug fired.
    await eventually(() => svc.wsOpenNow, "the websocket to report open");
    // A beat for onopen's report call and at least one heartbeat-timeout
    // give-up cycle (heartbeatTimeoutMs is 80ms; the stub sends no frames).
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(svc.sseUpNow, false, "the stub answers 500 — sseUp must not be true");
    assert.equal(
      everReportedConnected(svc),
      false,
      `expected no "connected" report while SSE answers 500, got ${JSON.stringify(svc.reports)}`,
    );
  });

  it('reports "connected" once SSE is genuinely streaming', async (t: TestContext) => {
    // A single deterministic transport: the websocket refused, so only SSE
    // can possibly report anything — the positive control proving the fix
    // does not just make the card permanently silent.
    const stub = await startProdComStub({ channels: CHANNELS, refuseWebSocket: true });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.sseUpNow, "SSE to come up");
    await eventually(
      () =>
        svc.reports.some(
          (r) => r.state === "connected" && r.message === `Streaming from 127.0.0.1:${stub.port}`,
        ),
      "the card to report the live stream",
    );
  });
});
