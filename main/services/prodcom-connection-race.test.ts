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
import { startProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";

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
