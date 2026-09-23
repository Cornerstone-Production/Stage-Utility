// Structural invariants of the two-transport design, each pinned to a specific
// line the external review found no test would break without: promotion
// actually closing the SSE connection (not just flipping a flag), a demoted
// socket actually reopening it, the heartbeat-timeout handler picking the
// right one of its two branches for a promoted vs. unproven socket, connect()
// never opening a second SSE stream while promoted, and SSE recovering from
// both a bad-status period and a connection-level failure — the two different
// `this.req = null` sites that make the next connect() attempt possible at
// all.
//
// Driven against the real client and fixtures/prodcom-stub.ts.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";
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
    return 30;
  }
  protected override get heartbeatTimeoutMs(): number {
    return 150;
  }
  protected override get wsSilenceCheckMs(): number {
    return 5_000; // long: nothing here is testing the ongoing silence check
  }
  public get onWebSocketNow(): boolean {
    return this.onWebSocketTransport;
  }
  public get wsOpenNow(): boolean {
    return this.wsAttemptOpen;
  }
  public get sseUpNow(): boolean {
    return this.sseStreamUp;
  }
  /** A reconnect, exactly as scheduleReconnect() would run it. */
  public reconnectNow(): Promise<void> {
    return this.connect();
  }
}

const CHANNELS = [{ id: "CH-A", name: "Lead TB", color: "#00F900" }];

const spoken = (id: string): StubEntry => ({
  id,
  channelId: "CH-A",
  channelName: "Lead TB",
  text: id,
  source: "audio",
  inProgress: false,
  date: new Date(NOW).toISOString(),
});

async function eventually(
  ready: () => boolean,
  what: string | (() => string),
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${typeof what === "function" ? what() : what}`);
}

async function withLogs<T>(fn: () => Promise<T>): Promise<{ lines: string[]; value: T }> {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a: unknown[]) => lines.push(String(a[0]));
  console.warn = (...a: unknown[]) => lines.push(String(a[0]));
  try {
    const value = await fn();
    return { lines, value };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

describe("promotion actually closes the SSE connection", () => {
  it("drops the SSE stream to the box, not just the onWebSocket flag", async (t: TestContext) => {
    const stub = await startProdComStub({ channels: CHANNELS });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => stub.openSseStreams >= 1, "SSE to open before promotion");
    await eventually(() => svc.wsOpenNow, "the websocket to open");
    stub.wsTranscript(spoken("promote-me"));
    await eventually(() => svc.onWebSocketNow, "promotion");

    await eventually(() => stub.openSseStreams === 0, "the SSE connection to close on promotion");
    assert.equal(svc.sseUpNow, false, "sseUp stayed true after promotion");
  });
});

describe("a demoted socket reopens SSE", () => {
  it("a promoted socket's heartbeat timeout demotes to SSE rather than giving up on it", async (t: TestContext) => {
    const { lines } = await withLogs(async () => {
      const stub = await startProdComStub({ channels: CHANNELS });
      const svc = new TestProdCom();
      t.after(async () => {
        svc.stop();
        await stub.close();
      });
      svc.configure("127.0.0.1", stub.port, null);

      await eventually(() => svc.wsOpenNow, "the websocket to open");
      stub.wsTranscript(spoken("promote-me"));
      await eventually(() => svc.onWebSocketNow, "promotion");

      // No further frames: the heartbeat watchdog (150ms here) times out on a
      // socket that was the live transport.
      await eventually(() => svc.onWebSocketNow === false, "the heartbeat timeout to demote it");
      await eventually(() => stub.openSseStreams >= 1, "SSE to reopen after demotion");
    });
    assert.ok(
      lines.some((l) => l.includes("falling back to the transcript SSE stream")),
      `expected demoteToSse's wording, got: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("captions have no live transport until SSE reconnects")),
      `a promoted socket's heartbeat timeout gave up instead of demoting: ${JSON.stringify(lines)}`,
    );
  });
});

describe("connect() never opens a second SSE stream while promoted", () => {
  it("a reconnect attempt while promoted does not touch SSE at all", async (t: TestContext) => {
    const stub = await startProdComStub({ channels: CHANNELS });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.wsOpenNow, "the websocket to open");
    stub.wsTranscript(spoken("promote-me"));
    await eventually(() => svc.onWebSocketNow, "promotion");

    const before = stub.sseOpens;
    await svc.reconnectNow();
    await svc.reconnectNow();
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(stub.sseOpens, before, "connect() opened SSE while the websocket was promoted");
    assert.equal(svc.onWebSocketNow, true, "a reconnect attempt while promoted disturbed the live transport");
  });
});

describe("SSE recovers from both kinds of failure", () => {
  it("reopens once a bad-status period ends", async (t: TestContext) => {
    const stub = await startProdComStub({ channels: CHANNELS, failSseStream: true });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.reports.some((r) => r.state === "error"), "the bad status to be reported");
    assert.equal(svc.sseUpNow, false, "sseUp was true during the failure period");

    stub.setFailSseStream(false);
    await eventually(() => svc.sseUpNow, "SSE to come up once the box stops answering 500");
  });

  it("reopens once a connection-level failure clears, on the same port", async (t: TestContext) => {
    let stub = await startProdComStub({ channels: CHANNELS });
    const port = stub.port;
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", port, null);
    await eventually(() => svc.sseUpNow, "the first SSE stream to come up");

    // The box drops off the network entirely — req.on('error') is the ONLY
    // handler that ever fires for this, unlike a bad status or a clean end.
    await stub.close();
    await eventually(
      () => svc.reports.some((r) => r.state === "error" && (r.message ?? "").includes("Can't reach")),
      "the connection-level failure to be reported",
    );
    assert.equal(svc.sseUpNow, false, "sseUp was true while the box was unreachable");

    // The box comes back on the SAME port — recovery depends on this.req
    // having been nulled by req.on('error'), or connect()'s own guard
    // believes a request is still in flight and never tries again.
    stub = await startProdComStub({ channels: CHANNELS, port });
    t.after(async () => {
      await stub.close();
    });
    await eventually(() => svc.sseUpNow, "SSE to come back once the box answers again on the same port", 6000);
  });
});
