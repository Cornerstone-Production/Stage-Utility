// A websocket attempt's row-count baseline belongs to that attempt alone.
//
// The silence check measures a socket against how many transcript rows ProdCom
// held when it opened. The read that fetches that count is async, and an attempt
// can close before it returns. ProdCom answers with the count at the moment it
// serves the request, and its transcript only grows, so a late answer for a
// closed attempt is inflated: applied to the attempt that replaced it, the check
// would page from past rows spoken since, and miss a socket that carries none.
//
// Driven against the real client and fixtures/prodcom-stub.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");

class TestProdCom extends ProdComService {
  protected override now(): number {
    return NOW;
  }
  protected override get reconnectMs(): number {
    return 20;
  }
  /** Reopens the websocket almost at once after an attempt gives up, so the
   *  next attempt opens while the first one's baseline read is still out. */
  protected override get wsRetryIntervalMs(): number {
    return 30;
  }
  public get baselineRows(): number | null {
    return this.wsBaseline;
  }
  public get wsOpenNow(): boolean {
    return this.wsAttemptOpen;
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

async function eventually(ready: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("a websocket attempt's baseline", () => {
  it("is not overwritten by a late read from the attempt it replaced", async (t) => {
    let baselineReads = 0;
    const stub = await startProdComStub({
      channels: CHANNELS,
      // The baseline read is the only limit=1 request. Hold the first one (the
      // first attempt's) for 800ms; answer every later one at once.
      delayTranscriptMs: (url) => (url.searchParams.get("limit") === "1" && baselineReads++ === 0 ? 800 : 0),
    });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.wsOpenNow, "the first attempt to open");
    stub.wsDropAll();
    await eventually(() => !svc.wsOpenNow, "the first attempt to close");

    await eventually(() => svc.wsOpenNow, "the second attempt to open");
    await eventually(() => svc.baselineRows === 0, "the second attempt's baseline of 0 rows");

    // Rows spoken after the second attempt opened. The held read is answered
    // after these land, so it reports 3.
    stub.addEntry(spoken("after-1"));
    stub.addEntry(spoken("after-2"));
    stub.addEntry(spoken("after-3"));
    await new Promise((r) => setTimeout(r, 950));

    assert.equal(svc.baselineRows, 0, "the first attempt's late read replaced the second attempt's baseline");
  });
});
