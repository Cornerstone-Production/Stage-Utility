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
import { eventually, startProdComStub } from "./fixtures/prodcom-stub.js";
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

  it('stays off "connected" once the stream is reset after its 200', async (t: TestContext) => {
    // A reset, not a clean end: the box crashed, or the keepalive gave up on
    // a peer that vanished. Node reports that on the REQUEST, whose handler
    // used to be the one teardown path that left sseUp true — so every
    // websocket give-up afterwards told the card "Streaming" for as long as the
    // outage lasted.
    const stub = await startProdComStub({ channels: CHANNELS, refuseWebSocket: true });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);
    await eventually(() => svc.sseUpNow, "SSE to come up");

    // From here nothing streams: the reset drops the live stream, and every
    // reconnect after it is answered 500.
    stub.setFailSseStream(true);
    stub.sseResetAll();
    await eventually(
      () => svc.reports.some((r) => r.state === "error" && (r.message ?? "").includes("Can't reach")),
      () => `the reset to reach the request's own error handler, got ${JSON.stringify(svc.reports)}`,
    );
    const mark = svc.reports.findIndex((r) => r.state === "error");
    // Several websocket retry-and-give-up cycles (30ms apart), each of which
    // reports "connected" when it believes SSE is up.
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(svc.sseUpNow, false, "sseUp was still true after the stream was reset");
    const since = svc.reports.slice(mark);
    assert.equal(
      since.some((r) => r.state === "connected"),
      false,
      `the card reported "connected" during an outage in which nothing streams: ${JSON.stringify(since)}`,
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
