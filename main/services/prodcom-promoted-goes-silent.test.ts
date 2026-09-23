// A promoted WebSocket must not be trusted forever on the strength of one
// delivered frame.
//
// ProdCom 2.3.2's websocket is known-broken: a socket that delivers once and
// then goes quiet, while still answering heartbeats, is exactly what caused
// the original incident this file's sibling (prodcom-silent-websocket.test.ts)
// guards against for the PRE-promotion case. This is the same failure a
// connection minute — or an hour — into being promoted: nothing before this
// fix ever asked again once wsDelivered latched true.
//
// The controller's ruling: after promotion, keep the existing REST-backed
// silence check running rather than retire it. If ProdCom reports spoken
// lines the promoted socket did not deliver within a check window, demote to
// SSE (whose own reconnect backfills the gap) and latch the box as silent —
// the same treatment a socket that never proved itself gets.
//
// Driven against the real client and fixtures/prodcom-stub.ts.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";
import type { ConnState } from "./integration-base.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const FALLBACK_CARD_MESSAGE = "Fallback stream — the websocket carried no transcript";

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
  // Long: this test is not about the heartbeat, and it must not fire (and
  // demote by ITS path) inside the window this test runs in.
  protected override get heartbeatTimeoutMs(): number {
    return 5_000;
  }
  protected override get wsSilenceCheckMs(): number {
    return 100;
  }
  protected override get wsRetryIntervalMs(): number {
    return 60;
  }
  public get onWebSocketNow(): boolean {
    return this.onWebSocketTransport;
  }
  public get wsOpenNow(): boolean {
    return this.wsAttemptOpen;
  }
  public get knownSilent(): boolean {
    return this.boxKnownSilent;
  }
  public texts(): string[] {
    return this.getBuffer().map((l) => l.text);
  }
}

const CHANNELS = [{ id: "CH-A", name: "Lead TB", color: "#00F900" }];

const spoken = (id: string, offsetMs = 0): StubEntry => ({
  id,
  channelId: "CH-A",
  channelName: "Lead TB",
  text: id,
  source: "audio",
  inProgress: false,
  date: new Date(NOW + offsetMs).toISOString(),
});

async function eventually(
  ready: () => boolean,
  what: string | (() => string),
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${typeof what === "function" ? what() : what}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("a promoted websocket that stops delivering demotes rather than staying trusted", () => {
  it("falls back to SSE, backfills the missed line, and latches the box silent", async (t: TestContext) => {
    const stub = await startProdComStub({ channels: CHANNELS });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.wsOpenNow, "the websocket to open");
    stub.wsTranscript(spoken("first-line"));
    await eventually(() => svc.onWebSocketNow, "promotion");
    await eventually(() => svc.texts().includes("first-line"), "the promoting line to land");

    // One healthy window: the promoting delivery already satisfies it, so the
    // baseline advances with no REST paging (see prodcom-silent-websocket.test.ts's
    // "keeps checking a delivering socket" case for that half). Then the socket
    // goes quiet for good — still answering heartbeats, exactly like the box on
    // the LAN — while something is said that only REST will ever see.
    stub.wsPing();
    await sleep(150);
    stub.addEntry(spoken("missed-while-promoted"));
    stub.wsPing();

    await eventually(() => svc.onWebSocketNow === false, "the socket to be demoted");
    assert.equal(svc.knownSilent, true, "the box was not latched as known-silent");
    await eventually(
      () => stub.sseOpens >= 2,
      () => `expected SSE to reopen after demotion, got ${stub.sseOpens} open(s)`,
    );

    await eventually(
      () => svc.texts().includes("missed-while-promoted"),
      "the missed line to be backfilled once SSE reopens",
    );
    await eventually(
      () => svc.reports.some((r) => r.state === "connected" && r.message === FALLBACK_CARD_MESSAGE),
      "the card to say the fallback is carrying captions because the websocket did not",
    );
  });
});
