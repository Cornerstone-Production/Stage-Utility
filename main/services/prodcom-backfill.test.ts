// Backfill has to ask ProdCom the right question, and colour has to come from
// the right endpoint.
//
// Two production bugs, both of which left every check in this repo green:
//
//   1. backfill() called `GET /api/v1/transcript` with NO parameters. That
//      endpoint is paginated, mandatory-paginated, and ascending FROM THE OLDEST
//      ENTRY — so unparameterised it returned the oldest 50 rows of about 3000,
//      dated five days back. applyBackfillRows() then dropped every row older
//      than four hours, which was all fifty. A display opened mid-service showed
//      an empty caption feed until somebody spoke.
//
//   2. normalizeLine() probed `color`, `channelColor`, `channel_color`,
//      `hexColor` and `hex` on each transcript ENTRY. No such field exists —
//      not in ProdCom's published OpenAPI schema and not on any of the 3001 rows
//      in the live box's history. Colour lives on the CHANNEL
//      (`GET /api/v1/channels`). Every channel fell through to the display's
//      deterministic colour while the docs claimed per-speaker colours worked.
//
// Both are driven here through the real code path — configure() → connect() →
// backfill() over real sockets against a local stub that behaves the way
// ProdCom 2.3.2 behaves, including the trap that makes bug 1 easy to
// re-introduce: a `since` timestamp carrying milliseconds is SILENTLY IGNORED,
// so the fix is only a fix if the client formats it to whole seconds. See
// fixtures/prodcom-stub.ts.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub, type ProdComStub, type StubEntry, type StubOptions } from "./fixtures/prodcom-stub.js";

/** A fixed "now" so the four-hour horizon and the stub's rows line up exactly. */
const NOW = Date.parse("2026-09-11T12:00:00Z");

class TestProdCom extends ProdComService {
  protected override now(): number {
    return NOW;
  }
  protected override get reconnectMs(): number {
    return 25;
  }
  /** Await the channel + backfill work the live connection kicked off. */
  public settled(): Promise<void> {
    return this.priming;
  }
  /** Drive applyBackfillRows() directly, without a host. */
  public backfillRows(rows: unknown[]): void {
    this.applyBackfillRows(rows);
  }
  /** Snapshot of the buffer as the display would receive it. */
  public captions(): { text: string; color: string | null; channelName: string | null }[] {
    return this.getBuffer().map((l) => ({ text: l.text, color: l.color, channelName: l.channelName }));
  }
}

const row = (id: string, minutesAgo: number, extra: Partial<StubEntry> = {}): StubEntry => ({
  id,
  channelId: "CH-A",
  channelName: "Stale Name From Write Time",
  text: id,
  source: "audio",
  inProgress: false,
  date: new Date(NOW - minutesAgo * 60_000).toISOString(),
  ...extra,
});

const CHANNELS = [
  { id: "CH-A", name: "Lead TB", color: "#00F900" },
  { id: "CH-B", name: "Drum TB", color: "0696C1" },
  { id: "CH-C", name: "No Colour Set", color: null },
];

/** A stub plus a service pointed at it, both torn down when the test ends. */
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

const isTranscriptPage = (r: { url: string }) => r.url.startsWith("/api/v1/transcript?");
const pageParams = (stub: ProdComStub, name: string) =>
  stub.requests.filter(isTranscriptPage).map((r) => new URL(r.url, "http://stub").searchParams.get(name));

describe("backfill asks ProdCom for the window it actually wants", () => {
  it("brings back the rows inside the four-hour horizon, out of a history five days deep", async (t) => {
    // 4100 rows five days old, then 3 from this morning — the live box held 3001
    // and grows. Ascending from the oldest, an unfiltered read reaches this
    // morning only after 21 pages, one past the paging cap, so every row it
    // does fetch is one the four-hour filter discards and the display stays
    // empty. That is the production bug, at production's scale.
    const old = Array.from({ length: 4100 }, (_, i) => row(`old-${i}`, 5 * 24 * 60 + (4100 - i) / 60));
    const recent = [row("welcome", 90), row("scripture", 40), row("closing", 5)];

    const { stub, svc } = await connected(t, { entries: [...old, ...recent] });
    await stub.waitForRequest(isTranscriptPage);
    await svc.settled();

    const texts = svc.captions().map((c) => c.text);
    assert.deepEqual(
      texts,
      ["welcome", "scripture", "closing"],
      `expected the three lines from this morning, got: ${JSON.stringify(texts)}`,
    );
    assert.deepEqual(
      pageParams(stub, "offset"),
      ["0"],
      "a server-side since is what keeps this to one page — without it the same three lines cost 20 requests, " +
        "and beyond the cap they are never reached at all",
    );
  });

  it("formats since to whole seconds, because a millisecond timestamp is silently ignored", async (t) => {
    const { stub, svc } = await connected(t, { entries: [row("recent", 10)] });
    await stub.waitForRequest(isTranscriptPage);
    await svc.settled();

    const since = pageParams(stub, "since")[0];
    assert.equal(
      since,
      "2026-09-11T08:00:00Z",
      "since must be now-4h to whole seconds — ProdCom 2.3.2 drops a timestamp carrying milliseconds " +
        "without erroring, and answers with its entire history from the oldest row",
    );
  });

  it("walks every page hasMore reports rather than assuming one is enough", async (t) => {
    // 450 rows, all inside the window: three pages at the spec's 200 maximum.
    const many = Array.from({ length: 450 }, (_, i) => row(`line-${i}`, 200 - i / 10));

    const { stub, svc } = await connected(t, { entries: many });
    await stub.waitForRequest(isTranscriptPage);
    await svc.settled();

    assert.deepEqual(
      pageParams(stub, "offset"),
      ["0", "200", "400"],
      `expected three pages, got offsets ${JSON.stringify(pageParams(stub, "offset"))}`,
    );
    assert.deepEqual(pageParams(stub, "limit"), ["200", "200", "200"], "every page asks for the spec's maximum");
    assert.equal(svc.captions().length, 100, "the buffer keeps its 100-line cap over a multi-page backfill");
  });

  it("stops after one page when hasMore is false", async (t) => {
    const { stub, svc } = await connected(t, { entries: [row("only", 3)] });
    await stub.waitForRequest(isTranscriptPage);
    await svc.settled();
    assert.equal(pageParams(stub, "offset").length, 1, "a single short page must not trigger a second request");
  });

  it("keeps the client-side age filter as a backstop and logs what it skipped", async () => {
    // Driven directly with rows a broken or clock-skewed box could return
    // despite `since`: the filter that stops Thursday's sermon reaching a Sunday
    // display must not depend on the server having honoured the parameter.
    const svc = new TestProdCom();
    const lines = await withLogs(async () => {
      svc.backfillRows([row("thursday", 64 * 60), row("this-morning", 2)]);
    });
    assert.deepEqual(svc.captions().map((c) => c.text), ["this-morning"]);
    assert.deepEqual(
      lines.filter((l) => l.startsWith("[prodcom] backfill skipped")),
      ["[prodcom] backfill skipped 1 line(s) older than 4h"],
    );
  });

  it("reports a failed page instead of swallowing it", async (t) => {
    const lines = await withLogs(async () => {
      const { stub, svc } = await connected(t, { entries: [row("never-arrives", 2)], failTranscript: true });
      await stub.waitForRequest(isTranscriptPage);
      await svc.settled();
    });
    assert.ok(
      lines.some((l) => l.startsWith("[prodcom] backfill failed after 0 page(s) (HTTP 500)")),
      `expected a backfill failure line, got: ${JSON.stringify(lines)}`,
    );
  });
});

describe("per-speaker colour comes from the channel list", () => {
  it("tints a line with its channel's colour, keyed by channel id", async (t) => {
    const { stub, svc } = await connected(t, {
      entries: [
        row("from-lead", 5, { channelId: "CH-A" }),
        row("from-drums", 4, { channelId: "CH-B" }),
        row("from-plain", 3, { channelId: "CH-C" }),
      ],
    });
    await stub.waitForRequest(isTranscriptPage);
    await svc.settled();

    assert.deepEqual(svc.captions(), [
      { text: "from-lead", color: "#00F900", channelName: "Lead TB" },
      // A bare hex with no "#" — which the live box does send — is normalised.
      { text: "from-drums", color: "#0696C1", channelName: "Drum TB" },
      { text: "from-plain", color: null, channelName: "No Colour Set" },
    ]);
  });

  it("reads the channel list before the transcript, so the first frame is already tinted", async (t) => {
    const { stub, svc } = await connected(t, { entries: [row("first", 1)] });
    await stub.waitForRequest(isTranscriptPage);
    await svc.settled();

    const paths = stub.requests.map((r) => r.url.split("?")[0]);
    assert.ok(
      paths.indexOf("/api/v1/channels") >= 0 && paths.indexOf("/api/v1/channels") < paths.indexOf("/api/v1/transcript"),
      `channels must be fetched first, got ${JSON.stringify(paths)}`,
    );
  });

  it("says so in the log when the channel list cannot be read, and still shows the captions", async (t) => {
    let svc: TestProdCom | null = null;
    const lines = await withLogs(async () => {
      const c = await connected(t, { entries: [row("still-visible", 2)], failChannels: true });
      svc = c.svc;
      await c.stub.waitForRequest(isTranscriptPage);
      await c.svc.settled();
    });
    assert.ok(
      lines.some((l) => l.startsWith("[prodcom] channel list unavailable (HTTP 500)")),
      `expected a channel-list failure line, got: ${JSON.stringify(lines)}`,
    );
    assert.deepEqual(svc!.captions(), [
      // With no channel record there is no colour and no current name, so the
      // entry's own denormalised name is all there is.
      { text: "still-visible", color: null, channelName: "Stale Name From Write Time" },
    ]);
  });
});

describe("the pre-shared key goes out under one header", () => {
  it("sends Authorization: Bearer and nothing else, on every read", async (t) => {
    const stub = await startProdComStub({ channels: CHANNELS, entries: [row("only", 3)], requireBearer: "s3cret" });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, "s3cret");
    await stub.waitForRequest(isTranscriptPage);
    await svc.settled();

    // A 401 would leave the buffer empty, so this is the read having been
    // authorised rather than merely attempted.
    assert.deepEqual(svc.captions().map((c) => c.text), ["only"]);

    const reads = stub.requests.filter((r) => r.url.startsWith("/api/v1/"));
    assert.ok(reads.length >= 2, `expected the channel and transcript reads, got ${reads.length}`);
    for (const r of reads) {
      assert.equal(r.headers["authorization"], "Bearer s3cret", `no bearer on ${r.url}`);
      assert.equal(
        r.headers["x-api-key"],
        undefined,
        "ProdCom's spec declares exactly one security scheme, bearerAuth; the invented second header sent " +
          `the operator's key a second time on every request, and it is still going out on ${r.url}`,
      );
    }
  });
});
