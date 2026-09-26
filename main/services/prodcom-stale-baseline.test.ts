// A websocket attempt's entry-id baseline belongs to that attempt alone.
//
// The silence check measures a socket against the ids on ProdCom's newest
// transcript page when it opened. The read that fetches that page is async, and
// an attempt can close before it returns. A late answer for a closed attempt
// reflects rows added after the attempt that asked for it already died: applied
// to the attempt that replaced it, the check would treat those rows as already
// accounted for and miss a socket that carries none of them.
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
    const baseline = this.wsBaseline;
    return baseline === null ? null : baseline.size;
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
      // The baseline read is the only limit=100 request while the box holds
      // fewer rows than that (readNewestPage's single-request fast path — see
      // its own doc comment). Hold the first one (the first attempt's) for
      // 800ms; answer every later one at once.
      delayTranscriptMs: (url) => (url.searchParams.get("limit") === "100" && baselineReads++ === 0 ? 800 : 0),
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
