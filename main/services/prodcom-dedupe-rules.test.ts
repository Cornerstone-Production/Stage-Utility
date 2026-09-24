// The three rules ingest() applies once a line is normalised, each pinned to
// the specific behaviour a mutation could silently drop:
//
//   1. A partial for an id already on the buffer as a FINAL is a straggler
//      from a slower transport, not a resurrection — it is dropped outright.
//   2. An unchanged partial re-send does not reset the staleness clock, or a
//      box that keeps re-sending the same interim result as a keepalive would
//      keep a genuinely stalled partial alive forever.
//   3. A final that actually CHANGED (a real correction) always broadcasts,
//      even while a second transport is open and would otherwise suppress an
//      unchanged repeat — see prodcom-duplicate-broadcast.test.ts for the
//      unchanged half of this same condition.
//
// Driven against the real client and fixtures/prodcom-stub.ts.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";
import { addBroadcastListener } from "./broadcaster.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");
/** Must match PARTIAL_TTL_MS in prodcom-service.ts — written out, not
 *  imported (it is not exported), so a change to either is a diff to this
 *  file too. */
const PARTIAL_TTL_MS = 30_000;

class TestProdCom extends ProdComService {
  private clock = NOW;
  protected override now(): number {
    return this.clock;
  }
  /** Jump the fake clock forward without a real wait — PARTIAL_TTL_MS is 30s. */
  public advanceClock(ms: number): void {
    this.clock += ms;
  }
  /** Runs the sweep directly, bypassing PARTIAL_SWEEP_MS's real setInterval. */
  public prunePartialsNow(): boolean {
    return this.pruneStalePartials();
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

const partial = (id: string, text: string): StubEntry => ({ ...final(id, text), inProgress: true });

async function connected(t: TestContext): Promise<{ stub: Awaited<ReturnType<typeof startProdComStub>>; svc: TestProdCom }> {
  const stub = await startProdComStub({ channels: CHANNELS });
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

describe("rule 1: a late partial never resurrects a finalized line", () => {
  it("drops a partial that arrives for an id already on the buffer as a final", async (t: TestContext) => {
    const { stub, svc } = await connected(t);
    await stub.waitForSse(1);
    await svc.settled();

    stub.sseSend(final("line-1", "the whole sentence"));
    await eventually(() => svc.texts().includes("the whole sentence"), "the final to land");

    // A straggler: the slower transport's copy of the same utterance, still
    // marked in-progress, arriving after the final already landed.
    stub.sseSend(partial("line-1", "the whole sen"));
    await new Promise((r) => setTimeout(r, 60));

    assert.deepEqual(svc.texts(), ["the whole sentence"], "a late partial resurrected a finalized line");
  });
});

describe("rule 2: an unchanged partial re-send does not reset its staleness clock", () => {
  it("still prunes a partial past its TTL even though it was resent unchanged since", async (t: TestContext) => {
    const { stub, svc } = await connected(t);
    await stub.waitForSse(1);
    await svc.settled();

    stub.sseSend(partial("stalls-here", "um so"));
    await eventually(() => svc.texts().includes("um so"), "the partial to land");

    // A keepalive resend of the identical interim result, comfortably before
    // the TTL — this must NOT push the clock back out.
    svc.advanceClock(PARTIAL_TTL_MS - 1_000);
    stub.sseSend(partial("stalls-here", "um so"));
    await new Promise((r) => setTimeout(r, 60));

    // Now past the ORIGINAL arrival's TTL.
    svc.advanceClock(2_000);
    const dropped = svc.prunePartialsNow();

    assert.equal(
      dropped,
      true,
      "an unchanged re-send reset the staleness clock, so a genuinely stalled partial never expires",
    );
    assert.equal(svc.texts().includes("um so"), false, "the stale partial was not pruned");
  });
});

describe("rule 3: a corrected final always broadcasts", () => {
  it("broadcasts a final whose text actually changed, even while a second transport is open", async (t: TestContext) => {
    const { stub, svc } = await connected(t);
    await stub.waitForSse(1);
    await eventually(() => svc.wsOpenNow, "the websocket to open");
    await svc.settled();

    stub.sseSend(final("correct-me", "the fisrt draft"));
    await eventually(() => svc.texts().includes("the fisrt draft"), "the first version to land");
    assert.equal(svc.wsOpenNow, true, "the websocket must still be open (unproven) for this case to mean anything");

    const broadcasts = spyOnTranscriptBroadcasts();
    stub.sseSend(final("correct-me", "the first draft"));
    await eventually(() => svc.texts().includes("the first draft"), "the corrected text to land on the buffer");
    await eventually(
      () =>
        broadcasts.some(
          (b) => Array.isArray(b) && b.some((l: { id?: string; text?: string }) => l.id === "correct-me" && l.text === "the first draft"),
        ),
      "the corrected final to be broadcast, not suppressed as though it were a duplicate",
    );
  });
});

describe("a partial never runs backwards on screen", () => {
  it("keeps the longer revision when a shorter, same-id partial arrives after it", async (t: TestContext) => {
    // Both transports can be open at once, and they do not share a clock: a
    // slower copy of the SAME utterance can land after a faster one that is
    // already further along. Modelled here as two SSE sends racing out of
    // order, which is the same shape ingest() sees regardless of which
    // transport either one came in on.
    const { stub, svc } = await connected(t);
    await stub.waitForSse(1);
    await svc.settled();

    stub.sseSend(partial("grows-then-shrinks", "the quick brown fox jum"));
    await eventually(() => svc.texts().includes("the quick brown fox jum"), "the further-along partial to land");

    // A straggler: the same utterance's EARLIER, shorter revision, arriving
    // late.
    stub.sseSend(partial("grows-then-shrinks", "the quick"));
    await new Promise((r) => setTimeout(r, 60));

    assert.deepEqual(
      svc.texts(),
      ["the quick brown fox jum"],
      "a shorter, stale partial rewound a caption that was already further along",
    );
  });
});
