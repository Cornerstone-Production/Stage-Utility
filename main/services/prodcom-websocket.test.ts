// The transcript arrives over ProdCom's WebSocket, and its heartbeat — not a
// silence timer — is what notices when the box dies.
//
// `GET /api/v1/transcript/stream` sends NO keepalive. Held open against the live
// box through a quiet evening it delivered zero bytes in 25 minutes. The only
// thing that ever detected a dead ProdCom was therefore an application-level
// "no transcript data for 900s" timer, whose own comment claimed it was "a last
// resort, not the mechanism" and was "set far beyond any plausible silence so it
// cannot flap through a service". Prod's log carried 140 of those lines between
// 1 August and 8 September, firing back to back overnight on the quarter hour.
// It was the mechanism, and the panel flapped roughly 140 times a month.
//
// `GET /api/v1/ws` carries `{"type":"ping"}` every 30 s whether or not anyone is
// speaking, so silence there means the peer is gone rather than that the room is
// quiet.
//
// Everything below runs the real client — Node's WebSocket, real sockets, real
// frames — against a local stub that speaks ProdCom 2.3.2's actual framing
// (fixtures/prodcom-stub.ts). The two timing constants are overridden through
// the service's own seams rather than with t.mock.timers, because faking
// setTimeout underneath undici's WebSocket breaks the client itself.
//
// NOT COVERED HERE, deliberately: the exact envelope a transcript event arrives
// in. ProdCom's published spec documents the control frames and the stream names
// but not the event shape, and a 25-minute capture of the live box during a quiet
// evening produced only heartbeats — nobody spoke. So the client looks for the
// entry by its two spec-required fields at the top level or one level down, and
// both shapes are exercised below; whichever the box really uses is logged once
// per connection so it can be pinned from a real service and the other deleted.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub, type ProdComStub, type StubEntry, type StubOptions } from "./fixtures/prodcom-stub.js";

const NOW = Date.parse("2026-09-11T12:00:00Z");

class TestProdCom extends ProdComService {
  protected override now(): number {
    return NOW;
  }
  protected override get heartbeatTimeoutMs(): number {
    return 200;
  }
  protected override get reconnectMs(): number {
    return 25;
  }
  public settled(): Promise<void> {
    return this.priming;
  }
  public get onWebSocketNow(): boolean {
    return this.onWebSocketTransport;
  }
  public texts(): string[] {
    return this.getBuffer().map((l) => l.text);
  }
}

const entry = (id: string, extra: Partial<StubEntry> = {}): StubEntry => ({
  id,
  channelId: "CH-A",
  channelName: "Lead TB",
  text: id,
  source: "audio",
  inProgress: false,
  date: new Date(NOW - 60_000).toISOString(),
  ...extra,
});

const CHANNELS = [{ id: "CH-A", name: "Lead TB", color: "#00F900" }];

async function connected(
  t: TestContext,
  options: StubOptions = {},
  apiKey: string | null = null,
): Promise<{ stub: ProdComStub; svc: TestProdCom }> {
  const stub = await startProdComStub({ channels: CHANNELS, ...options });
  const svc = new TestProdCom();
  t.after(async () => {
    svc.stop();
    await stub.close();
  });
  svc.configure("127.0.0.1", stub.port, apiKey);
  return { stub, svc };
}

/** Run `fn` with console.log/warn captured. */
async function withLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a: unknown[]) => lines.push(String(a[0]));
  console.warn = (...a: unknown[]) => lines.push(String(a[0]));
  try {
    await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines;
}

/** Poll until `ready()` or give up — for the handful of assertions that observe
 *  the SERVICE rather than the stub and so have nothing to await on. */
async function eventually(ready: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("the transcript comes over the websocket", () => {
  it("upgrades, subscribes to the transcript stream, and carries the pre-shared key in the documented header", async (t) => {
    const { stub } = await connected(t, { requireBearer: "s3cret" }, "s3cret");
    await stub.waitForUpgrades(1);
    await stub.waitForRequest((r) => r.url === "/api/v1/ws" && r.headers["authorization"] === "Bearer s3cret");

    const upgrade = stub.requests.find((r) => r.url === "/api/v1/ws");
    assert.equal(
      upgrade?.headers["authorization"],
      "Bearer s3cret",
      "the spec declares exactly one security scheme, bearerAuth; if a Node release stops forwarding " +
        "headers on a WebSocket upgrade this is where it must be caught, not in production",
    );
    assert.equal(upgrade?.headers["x-api-key"], undefined, "the second, invented header is gone");

    await eventually(() => stub.wsReceived.length > 0, "a subscribe frame");
    assert.deepEqual(JSON.parse(stub.wsReceived[0]), { type: "subscribe", events: ["transcript"] });
  });

  it("puts a transcript entry on the buffer, whether the entry is the frame or nested in it", async (t) => {
    const { stub, svc } = await connected(t);
    await stub.waitForUpgrades(1);
    await svc.settled();

    stub.wsTranscript(entry("nested-in-data"), "data");
    stub.wsTranscript(entry("at-the-top-level"), "top");
    await eventually(() => svc.texts().length === 2, "both frames to land");
    assert.deepEqual(svc.texts(), ["nested-in-data", "at-the-top-level"]);
  });

  it("answers the heartbeat so ProdCom keeps the connection", async (t) => {
    const { stub } = await connected(t);
    await stub.waitForUpgrades(1);
    await eventually(() => stub.wsReceived.length >= 1, "the subscribe frame");

    stub.wsPing();
    await eventually(
      () => stub.wsReceived.some((f) => f.includes('"pong"')),
      "a pong in reply to ProdCom's ping",
    );
  });

  it("ignores a frame that is not a transcript entry, and says so once", async (t) => {
    const { stub, svc } = await connected(t);
    await stub.waitForUpgrades(1);
    await svc.settled();

    const lines = await withLogs(async () => {
      stub.wsSend(JSON.stringify({ type: "automation", data: { name: "Flash on cue" } }));
      stub.wsSend(JSON.stringify({ type: "automation", data: { name: "Flash again" } }));
      stub.wsSend(JSON.stringify({ type: "status", data: { uptime: 12 } }));
      await eventually(() => stub.wsReceived.length >= 1, "the client to still be alive");
      await new Promise((r) => setTimeout(r, 40));
    });

    assert.deepEqual(svc.texts(), [], "nothing that is not a transcript entry reaches a caption wall");
    assert.equal(
      lines.filter((l) => l.startsWith("[prodcom] websocket frame is not a transcript entry")).length,
      1,
      `expected exactly one line per connection, got: ${JSON.stringify(lines)}`,
    );
  });
});

describe("a missed heartbeat reconnects", () => {
  it("drops and reopens the connection when the heartbeat stops, and logs why", async (t) => {
    let stub: ProdComStub | null = null;
    const lines = await withLogs(async () => {
      const c = await connected(t);
      stub = c.stub;
      await c.stub.waitForUpgrades(1);
      // Say nothing at all: no heartbeat, no transcript. On the old SSE stream
      // this was indistinguishable from a quiet room and cost 15 minutes; here
      // it means the peer is gone.
      await c.stub.waitForUpgrades(2, 3000);
    });

    assert.ok(stub!.wsUpgrades >= 2, `expected a second upgrade, saw ${stub!.wsUpgrades}`);
    assert.ok(
      lines.some((l) => l.startsWith("[prodcom] no websocket frame for 0s — heartbeat missed")),
      `expected the heartbeat-missed line, got: ${JSON.stringify(lines)}`,
    );
  });

  it("does not reconnect while the heartbeat keeps arriving, even with nobody speaking", async (t) => {
    const { stub } = await connected(t);
    await stub.waitForUpgrades(1);

    // Six heartbeats at half the timeout, and not one transcript line — a quiet
    // weeknight. The old data-silence timer fired on exactly this.
    for (let i = 0; i < 6; i++) {
      stub.wsPing();
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(stub.wsUpgrades, 1, "a heartbeat is liveness; silence on the transcript is not death");
  });
});

describe("falling back to the SSE stream", () => {
  it("opens the old stream when the upgrade is refused, and captions still arrive", async (t) => {
    let stub: ProdComStub | null = null;
    let svc: TestProdCom | null = null;
    const lines = await withLogs(async () => {
      const c = await connected(t, { refuseWebSocket: true, entries: [entry("from-backfill")] });
      stub = c.stub;
      svc = c.svc;
      await c.stub.waitForRequest((r) => r.url.startsWith("/api/v1/transcript?"));
      await c.svc.settled();
    });

    assert.equal(svc!.onWebSocketNow, false, "the live transport is the fallback");
    assert.ok(
      lines.some((l) => l.startsWith("[prodcom] websocket unavailable (")),
      `expected the fallback line, got: ${JSON.stringify(lines)}`,
    );
    // The fallback is a real path, not a placeholder: backfill primed it and a
    // live event lands on it.
    assert.deepEqual(svc!.texts(), ["from-backfill"]);
    stub!.sseSend(entry("spoken-live"));
    await eventually(() => svc!.texts().includes("spoken-live"), "an SSE event to land");
  });

  it("comes back to the websocket rather than staying on the fallback for ever", async (t) => {
    // A box that refuses the upgrade AND drops its SSE stream: every reconnect
    // lands back on the fallback, and the client must keep offering the
    // WebSocket, or a ProdCom that was merely mid-restart stays on the
    // keepalive-less stream until this server is restarted.
    const { stub } = await connected(t, { refuseWebSocket: true, sseCloseImmediately: true });
    await stub.waitForSse(1);
    await eventually(
      () => stub.requests.filter((r) => r.url === "/api/v1/ws").length >= 2,
      "a second websocket attempt after a run of SSE reconnects",
      6000,
    );
  });
});
