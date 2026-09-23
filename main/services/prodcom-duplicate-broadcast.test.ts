// A line that arrives on both transports, while the WebSocket is open beside
// SSE and still unproven, must be applied and broadcast once — not twice.
//
// The trap this guards against, found while adding the dedupe: suppressing
// every broadcast of a final whose content is UNCHANGED from what is already
// stored is too broad. It also silences an ordinary re-send on a SINGLE live
// transport, which is exactly the shape a freshly-enabled automation rule
// needs to see (demand-gating.test.ts drives prodcomService.handleEvent() with
// the identical payload twice and expects a rule enabled in between to see the
// second one) — suppressing that second send left the rule believing nothing
// had happened. So the dedupe is scoped to the one window where "identical to
// what's stored" really does mean "the other transport just delivered this":
// while a WebSocket attempt is open beside SSE.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { addBroadcastListener } from "./broadcaster.js";
import { startProdComStub, type ProdComStub, type StubEntry, type StubOptions } from "./fixtures/prodcom-stub.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");

class TestProdCom extends ProdComService {
  protected override now(): number {
    return NOW;
  }
  protected override get reconnectMs(): number {
    return 25;
  }
  public get wsOpenNow(): boolean {
    return this.wsAttemptOpen;
  }
  public settled(): Promise<void> {
    return this.priming;
  }
  public texts(): string[] {
    return this.getBuffer().map((l) => l.text);
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

function spyOnTranscriptBroadcasts(): unknown[] {
  const seen: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "prodcom:transcript") seen.push(payload);
  });
  return seen;
}

async function eventually(ready: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("a line delivered on both transports broadcasts once, not twice", () => {
  it("is applied once when SSE and the unproven WebSocket both deliver it", async (t) => {
    const { stub, svc } = await connected(t);
    await stub.waitForSse(1);
    await eventually(() => svc.wsOpenNow, "the websocket to open");
    await svc.settled();
    const broadcasts = spyOnTranscriptBroadcasts();

    // Both transports genuinely open — see the header comment for why this
    // window specifically is what the dedupe must be scoped to.
    stub.sseSend(final("shared-line", "and all the people said amen"));
    await eventually(() => svc.texts().includes("and all the people said amen"), "the SSE copy to land");
    stub.wsTranscript(final("shared-line", "and all the people said amen"));
    // No further wait possible on an outcome that is the ABSENCE of a second
    // broadcast — settle a beat so a wrongly-fired second one would have landed.
    await new Promise((r) => setTimeout(r, 60));

    assert.deepEqual(svc.texts(), ["and all the people said amen"], "the line was applied more than once");
    const finalBroadcasts = broadcasts.filter(
      (b) => Array.isArray(b) && b.some((l: { id?: string }) => l.id === "shared-line"),
    );
    assert.equal(
      finalBroadcasts.length,
      1,
      `expected exactly one broadcast carrying the shared line, got ${finalBroadcasts.length}`,
    );
  });

  it("still broadcasts an identical re-send with only ONE transport live — the demand-gating case", async (t) => {
    // Once the WebSocket is not open (refused here, so it never is), an
    // unchanged final must broadcast again: a consumer that subscribed between
    // two otherwise-identical deliveries has seen neither.
    const { stub, svc } = await connected(t, { refuseWebSocket: true });
    await stub.waitForSse(1);
    await svc.settled();
    assert.equal(svc.wsOpenNow, false, "the websocket must not be open for this case");
    const broadcasts = spyOnTranscriptBroadcasts();

    stub.sseSend(final("repeat-me", "hello"));
    await eventually(() => broadcasts.length >= 1, "the first delivery to broadcast");

    stub.sseSend(final("repeat-me", "hello")); // byte-identical, same transport
    await eventually(() => broadcasts.length >= 2, "the identical re-send to broadcast again");
  });
});
