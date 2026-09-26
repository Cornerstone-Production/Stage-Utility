// Promotion must disarm the SSE fallback's idle watchdog.
//
// dropFallbackStream() nulls `req` and destroys it, but the timer armed by
// armSseIdleWatchdog() kept running regardless — it does not read `req` at
// all, only the wall clock since the last SSE chunk. So a WebSocket promoted
// the instant it opened, and carrying captions perfectly well ever since,
// still had a stale SSE-silence timer ticking down underneath it. Once it
// fired: "no transcript data" warning, the card flips to "Transcript stream
// went silent — reconnecting" and STAYS there, because nothing about being
// promoted makes anything report "connected" again afterwards.
//
// Driven against the real client and fixtures/prodcom-stub.ts, with
// streamIdleMs shortened so the test does not wait fifteen minutes.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";
import type { ConnState } from "./integration-base.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const SILENT_CARD_MESSAGE = "Transcript stream went silent — reconnecting";

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
  // Long: nothing here is testing the websocket's own heartbeat, and it must
  // not fire (and demote) inside this test's short window.
  protected override get heartbeatTimeoutMs(): number {
    return 10_000;
  }
  protected override get streamIdleMs(): number {
    return 100;
  }
  public get onWebSocketNow(): boolean {
    return this.onWebSocketTransport;
  }
  public get wsOpenNow(): boolean {
    return this.wsAttemptOpen;
  }
}

const CHANNELS = [{ id: "CH-A", name: "Lead TB", color: "#00F900" }];

const final = (id: string, text: string): StubEntry => ({
  id,
  channelId: "CH-A",
  channelName: "Lead TB",
  text,
  source: "audio",
  inProgress: false,
  date: new Date(NOW).toISOString(),
});

async function eventually(ready: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("a promoted websocket disarms the SSE idle watchdog", () => {
  it('does not flip to "stream went silent" after the SSE fallback is closed on purpose', async (t: TestContext) => {
    const stub = await startProdComStub({ channels: CHANNELS });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.wsOpenNow, "the websocket to open");
    stub.wsTranscript(final("promo-1", "and also with you"));
    await eventually(() => svc.onWebSocketNow, "promotion");

    // streamIdleMs is 100ms; this comfortably outlives a watchdog that was
    // left armed across the drop.
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(
      svc.reports.some((r) => r.message === SILENT_CARD_MESSAGE),
      false,
      `promotion must disarm the SSE idle watchdog, got ${JSON.stringify(svc.reports)}`,
    );
    assert.equal(svc.onWebSocketNow, true, "the promoted socket must still be the live transport");
  });
});
