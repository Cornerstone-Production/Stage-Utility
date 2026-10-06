// A REST read started for one connection must not apply to whatever replaced
// it.
//
// backfill(), fetchChannels() and fetchKeywords() all await a REST read and
// then apply the result unconditionally: a backfilled line, a channel's name
// and colour, a keyword's redaction pattern. A reconfigure to a different
// ProdCom box, or a stop(), while one of those reads is in flight lets the OLD
// box's answer land on the NEW connection once it finally resolves — the old
// box's history in the caption buffer, its channel list overwriting the new
// box's, or its sensitive keywords redacting (or failing to redact) lines that
// have nothing to do with it.
//
// Each case here holds one read open past a reconfigure using the stub's delay
// hooks, then proves the stale answer never reached state that now belongs to
// the second box.
//
// Driven against the real client and fixtures/prodcom-stub.ts.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { eventually, startProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

class TestProdCom extends ProdComService {
  protected override now(): number {
    return NOW;
  }
  protected override get reconnectMs(): number {
    return 25;
  }
  public get sseUpNow(): boolean {
    return this.sseStreamUp;
  }
  public texts(): string[] {
    return this.getBuffer().map((l) => l.text);
  }
  public channelNames(): (string | null)[] {
    return this.getChannels().map((c) => c.name);
  }
}

const spoken = (id: string, offsetMs = 0): StubEntry => ({
  id,
  channelId: "CH-A",
  channelName: "Lead TB",
  text: id,
  source: "audio",
  inProgress: false,
  date: new Date(NOW + offsetMs).toISOString(),
});

const CHANNELS_B = [{ id: "CH-A", name: "Box B Channel", color: "#00F900" }];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `fn` with console.log/warn/debug captured — the drop notes this file
 *  checks for are debug-level, so this one also captures console.debug. */
async function withLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  const dbg = console.debug;
  console.log = (...a: unknown[]) => lines.push(String(a[0]));
  console.warn = (...a: unknown[]) => lines.push(String(a[0]));
  console.debug = (...a: unknown[]) => lines.push(String(a[0]));
  try {
    await fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.debug = dbg;
  }
  return lines;
}

describe("a REST read started for one connection must not apply to whatever replaced it", () => {
  it("drops a backfill that lands after the connection was reconfigured to a different box", async (t: TestContext) => {
    const stubA = await startProdComStub({
      channels: [{ id: "CH-OLD", name: "Old Box Channel" }],
      entries: [spoken("from-box-a")],
      // Backfill is the only /api/v1/transcript read with limit=200.
      delayTranscriptMs: (url) => (url.searchParams.get("limit") === "200" ? 700 : 0),
    });
    const stubB = await startProdComStub({ channels: CHANNELS_B });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stubA.close();
      await stubB.close();
    });

    const lines = await withLogs(async () => {
      svc.configure("127.0.0.1", stubA.port, null);
      await eventually(
        () => stubA.requests.some((r) => r.url.includes("limit=200")),
        "box A's backfill read to be in flight",
      );

      svc.configure("127.0.0.1", stubB.port, null); // reconfigure mid-flight
      await eventually(() => svc.sseUpNow, "the new SSE stream (box B) to come up");
      await sleep(900); // past box A's held backfill answer
    });

    assert.equal(
      svc.texts().includes("from-box-a"),
      false,
      "box A's backfilled line landed on the connection that was reconfigured to box B",
    );
    assert.ok(
      lines.some((l) => l.includes("dropped a backfill") && l.includes("after this connection was replaced")),
      `expected the drop to be logged, got: ${JSON.stringify(lines)}`,
    );
  });

  it("drops a channel list that lands after the connection was reconfigured to a different box", async (t: TestContext) => {
    const stubA = await startProdComStub({
      channels: [{ id: "CH-OLD", name: "Old Box Channel", color: "#FF0000" }],
      delayRequestMs: (url) => (url.pathname === "/api/v1/channels" ? 700 : 0),
    });
    const stubB = await startProdComStub({ channels: CHANNELS_B });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stubA.close();
      await stubB.close();
    });

    const lines = await withLogs(async () => {
      svc.configure("127.0.0.1", stubA.port, null);
      await eventually(
        () => stubA.requests.some((r) => r.url === "/api/v1/channels"),
        "box A's channel read to be in flight",
      );

      svc.configure("127.0.0.1", stubB.port, null); // reconfigure mid-flight
      await eventually(() => svc.sseUpNow, "the new SSE stream (box B) to come up");
      // Box B's own (undelayed) channel read lands well before this.
      await eventually(() => svc.channelNames().includes("Box B Channel"), "box B's channel list to land");
      await sleep(900); // past box A's held channel-list answer
    });

    assert.deepEqual(
      svc.channelNames(),
      ["Box B Channel"],
      "box A's channel list overwrote box B's after landing late",
    );
    assert.ok(
      lines.some((l) => l.includes("dropped a channel list read") && l.includes("after this connection was replaced")),
      `expected the drop to be logged, got: ${JSON.stringify(lines)}`,
    );
  });

  it("drops a keyword list that lands after the connection was reconfigured to a different box", async (t: TestContext) => {
    const stubA = await startProdComStub({
      channels: [{ id: "CH-OLD", name: "Old Box Channel" }],
      keywords: [{ id: "kw-1", text: "secret", isSensitive: true }],
      delayRequestMs: (url) => (url.pathname === "/api/v1/keywords" ? 700 : 0),
    });
    const stubB = await startProdComStub({ channels: CHANNELS_B }); // no keywords at all
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stubA.close();
      await stubB.close();
    });

    const lines = await withLogs(async () => {
      svc.configure("127.0.0.1", stubA.port, null);
      await eventually(
        () => stubA.requests.some((r) => r.url === "/api/v1/keywords"),
        "box A's keyword read to be in flight",
      );

      svc.configure("127.0.0.1", stubB.port, null); // reconfigure mid-flight
      await eventually(() => svc.sseUpNow, "the new SSE stream (box B) to come up");
      await sleep(900); // past box A's held keyword-list answer

      stubB.sseSend(spoken("this-is-a-secret-message"));
      await eventually(() => svc.texts().length > 0, "the line from box B to land");
    });

    assert.equal(
      svc.texts()[0],
      "this-is-a-secret-message",
      "box A's sensitive keyword redacted a line on the connection that was reconfigured to box B",
    );
    assert.ok(
      lines.some((l) => l.includes("dropped a keyword read") && l.includes("after this connection was replaced")),
      `expected the drop to be logged, got: ${JSON.stringify(lines)}`,
    );
  });
});

describe("the rest of a replaced connection's REST chain does not run either", () => {
  // Each read above drops its OWN stale answer. The chain it sits in —
  // channels, then keywords, then backfill — used to carry on regardless,
  // sending the next read to the OLD box and applying it under the NEW
  // connection, whose epoch that next read captured when it started. These
  // cases give box A the history and keywords that make that visible.
  //
  // Box A refuses the websocket in every case: an open socket reads its own
  // baseline page the moment it opens, and that request — sent before the
  // reconfigure, arriving after it — would be counted against the chain.

  /** Requests box A saw after `from`, other than websocket attempts. */
  const restAfter = (stub: { requests: { url: string }[] }, from: number): string[] =>
    stub.requests
      .slice(from)
      .map((r) => r.url)
      .filter((u) => !u.startsWith("/api/v1/ws"));

  it("a reconfigure during box A's channel read sends box A no keyword or backfill read", async (t: TestContext) => {
    const stubA = await startProdComStub({
      channels: [{ id: "CH-OLD", name: "Old Box Channel" }],
      refuseWebSocket: true,
      keywords: [{ id: "kw-1", text: "secret", isSensitive: true }],
      entries: [spoken("from-box-a")],
      delayRequestMs: (url) => (url.pathname === "/api/v1/channels" ? 700 : 0),
    });
    const stubB = await startProdComStub({ channels: CHANNELS_B }); // no keywords, no history
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stubA.close();
      await stubB.close();
    });

    svc.configure("127.0.0.1", stubA.port, null);
    await eventually(() => stubA.requests.some((r) => r.url === "/api/v1/channels"), "box A's channel read in flight");
    const mark = stubA.requests.length;
    svc.configure("127.0.0.1", stubB.port, null);
    await eventually(() => svc.sseUpNow, "box B's SSE stream to come up");
    await sleep(1000); // past box A's held channel answer, and anything it would have chained

    stubB.sseSend(spoken("this-is-a-secret-message"));
    await eventually(() => svc.texts().some((l) => l.startsWith("this-is-a-")), "box B's line to land");
    assert.deepEqual(restAfter(stubA, mark), [], "box A was sent the rest of its chain after the reconfigure");
    assert.equal(svc.texts().includes("from-box-a"), false, "box A's history landed on box B's connection");
    assert.ok(
      svc.texts().includes("this-is-a-secret-message"),
      `box A's sensitive keyword redacted box B's line: ${JSON.stringify(svc.texts())}`,
    );
  });

  it("a reconfigure during box A's keyword read sends box A no backfill read", async (t: TestContext) => {
    const stubA = await startProdComStub({
      channels: [{ id: "CH-OLD", name: "Old Box Channel" }],
      refuseWebSocket: true,
      entries: [spoken("from-box-a")],
      delayRequestMs: (url) => (url.pathname === "/api/v1/keywords" ? 700 : 0),
    });
    const stubB = await startProdComStub({ channels: CHANNELS_B });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stubA.close();
      await stubB.close();
    });

    svc.configure("127.0.0.1", stubA.port, null);
    await eventually(() => stubA.requests.some((r) => r.url === "/api/v1/keywords"), "box A's keyword read in flight");
    const mark = stubA.requests.length;
    svc.configure("127.0.0.1", stubB.port, null);
    await eventually(() => svc.sseUpNow, "box B's SSE stream to come up");
    await sleep(1000);

    assert.deepEqual(
      restAfter(stubA, mark).filter((u) => u.startsWith("/api/v1/transcript")),
      [],
      "box A was sent a backfill read after the reconfigure",
    );
    assert.equal(svc.texts().includes("from-box-a"), false, "box A's history landed on box B's connection");
  });

  it("box A's empty keyword list does not un-redact box B's sensitive word", async (t: TestContext) => {
    // The direction that matters most: box B hides "secret", box A hides
    // nothing, and box A's list used to land AFTER box B's.
    const stubA = await startProdComStub({
      channels: [{ id: "CH-OLD", name: "Old Box Channel" }],
      refuseWebSocket: true,
      delayRequestMs: (url) => (url.pathname === "/api/v1/channels" ? 500 : 0),
    });
    const stubB = await startProdComStub({
      channels: CHANNELS_B,
      keywords: [{ id: "kw-b", text: "secret", isSensitive: true }],
    });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stubA.close();
      await stubB.close();
    });

    svc.configure("127.0.0.1", stubA.port, null);
    await eventually(() => stubA.requests.some((r) => r.url === "/api/v1/channels"), "box A's channel read in flight");
    svc.configure("127.0.0.1", stubB.port, null);
    await eventually(() => svc.sseUpNow, "box B's SSE stream to come up");
    stubB.sseSend(spoken("before-a-lands-secret"));
    // Box B's keyword read is its own request and can land after the stream is
    // up and the line has arrived; on a loaded runner it did. Wait for it.
    await eventually(
      () => svc.texts()[0] === "before-a-lands-******",
      "precondition: box B's keyword list to load and redact the line",
    );

    await sleep(900); // past box A's held channel answer
    assert.equal(svc.texts()[0], "before-a-lands-******", "box A's empty keyword list un-redacted box B's sensitive word");
  });

  it("stop() during box A's channel read sends box A nothing more", async (t: TestContext) => {
    const stubA = await startProdComStub({
      channels: [{ id: "CH-OLD", name: "Old Box Channel" }],
      refuseWebSocket: true,
      entries: [spoken("from-box-a")],
      delayRequestMs: (url) => (url.pathname === "/api/v1/channels" ? 500 : 0),
    });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stubA.close();
    });

    svc.configure("127.0.0.1", stubA.port, null);
    await eventually(() => stubA.requests.some((r) => r.url === "/api/v1/channels"), "box A's channel read in flight");
    svc.stop();
    const mark = stubA.requests.length;
    await sleep(900);
    assert.deepEqual(restAfter(stubA, mark), [], "requests went to the box after stop()");
    assert.equal(svc.texts().includes("from-box-a"), false, "a backfill landed after stop()");
  });

  it("stop() during the silence check's first page read sends box A no second one", async (t: TestContext) => {
    // readNewestPage is a two-read chain of its own on a box holding more than
    // a page: the row count, then the tail. This one keeps its websocket — the
    // socket's own baseline read is the chain under test.
    let hold = true;
    const stubA = await startProdComStub({
      channels: [{ id: "CH-OLD", name: "Old Box Channel" }],
      entries: Array.from({ length: 150 }, (_, i) => spoken(`row-${i}`, -3 * 60 * 60_000)),
      delayTranscriptMs: (url) => (hold && !url.searchParams.has("since") ? 500 : 0),
    });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stubA.close();
    });

    svc.configure("127.0.0.1", stubA.port, null);
    const pageReads = (): string[] =>
      stubA.requests.map((r) => r.url).filter((u) => u.startsWith("/api/v1/transcript?") && !u.includes("since="));
    await eventually(() => pageReads().length === 1, "the socket's first page read in flight");
    svc.stop();
    hold = false;
    await sleep(800);
    assert.deepEqual(pageReads().slice(1), [], "the second page read went to the box after stop()");
  });
});
