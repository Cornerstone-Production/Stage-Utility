// The silence check's page cap must not blind it for the rest of a connection.
//
// spokenLinesBeyond() pages forward from the socket's row-count baseline,
// WS_SILENCE_CHECK_MAX_PAGES pages at a time, looking for a spoken row. Before
// this fix, a run of `typed`/`automation` rows longer than that cap made every
// later check re-read the exact same first pages and answer "nothing missed"
// forever — the baseline never moved, so real speech sitting past the cap was
// never reached, however many checks ran. That keeps a silent websocket
// trusted and captions stop, which is exactly the failure this whole file
// exists to catch (see prodcom-silent-websocket.test.ts's own header).
//
// Both call sites share the bug: the probation check (runSilenceCheck, before
// a socket has ever delivered) and the post-promotion check
// (runPromotedSilenceCheck, once it has). Each is proven here.
//
// Driven against the real client and fixtures/prodcom-stub.ts.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub, type ProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";
import type { ConnState } from "./integration-base.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

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
  // Long: no case here is about the heartbeat, and it must not fire inside the
  // window this test runs in.
  protected override get heartbeatTimeoutMs(): number {
    return 10_000;
  }
  // The real sixty seconds, in milliseconds — short enough that "a bounded
  // number of checks" is a fast test, long enough that consecutive checks
  // don't race the stub's own event loop.
  protected override get wsSilenceCheckMs(): number {
    return 100;
  }
  // Long: this file is not about the fallback retry cadence, and it must not
  // fire and reopen a second socket while one is already being driven.
  protected override get wsRetryIntervalMs(): number {
    return 10_000;
  }
  protected override get wsSilentRetryIntervalMs(): number {
    return 10_000;
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
  public get baselineRows(): number | null {
    return this.wsBaseline;
  }
  /** The CURRENT websocket attempt's own priming (just the baseline read) —
   *  awaited so a test can add rows that must count as "since THIS attempt
   *  opened", the same seam prodcom-silent-websocket.test.ts uses. */
  public wsSettled(): Promise<void> {
    return this.wsBaselinePriming;
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

const typed = (id: string, offsetMs = 0): StubEntry => ({ ...spoken(id, offsetMs), source: "typed" });

/** More non-speech rows than a single check can page through
 *  (WS_SILENCE_CHECK_MAX_PAGES * WS_SILENCE_CHECK_PAGE_SIZE = 5 * 20 = 100). A
 *  single check that starts at `baseline` can only ever see the first 100 of
 *  these — finding the run's own tail needs the baseline to have moved. */
function addLongNonSpeechRun(stub: ProdComStub, prefix: string, baseOffsetMs: number): void {
  for (let i = 0; i < 100; i++) stub.addEntry(typed(`${prefix}-${i}`, baseOffsetMs + i));
}

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

/** Run `fn` with console.log/warn captured, the same seam
 *  prodcom-silent-websocket.test.ts uses. console.debug is left alone: it is
 *  the level log-buffer does not capture, so it never reaches `/log`. */
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

const capHitLines = (lines: string[]): string[] =>
  lines.filter((l) => l.includes("scanned") && l.includes("continuing from row"));

describe("the silence check's page cap does not blind it for the rest of the connection", () => {
  it("catches a socket on probation within a bounded number of checks, past a run longer than the cap", async (t: TestContext) => {
    const stub = await startProdComStub({ channels: CHANNELS });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    const lines = await withLogs(async () => {
      await eventually(() => svc.wsOpenNow, "the websocket to open");
      await svc.wsSettled();
      assert.equal(svc.baselineRows, 0, "the first attempt's baseline was not zero");

      // Exactly the cap's worth of non-speech, then one spoken row the socket
      // never delivered. Only reachable if the check's baseline moves past the
      // first 100 rows on its own.
      addLongNonSpeechRun(stub, "typed-a", 10_000);
      stub.addEntry(spoken("said-behind-the-cap", 20_000));

      // Bounded: two check intervals to find it (one to hit the cap and
      // advance, one to read the row that was hiding behind it), plus slack —
      // not the long, effectively-open-ended waits this suite uses elsewhere.
      // Before this fix this check timed out every time: the baseline never
      // moved past row 0, so the spoken row at index 100 was never read.
      await eventually(
        () => stub.wsUpgrades >= 2,
        "the socket to be reopened unsubscribed once the missed line is found",
        1500,
      );
    });

    assert.equal(
      capHitLines(lines).length,
      1,
      `expected exactly one cap-hit line for this connection, got: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      capHitLines(lines)[0]?.includes("continuing from row 100 next time"),
      `expected the line to name row 100, got: ${JSON.stringify(capHitLines(lines))}`,
    );
  });

  it("still reaches the silent-box verdict once the reopened socket is tested the same way", async (t: TestContext) => {
    const stub = await startProdComStub({ channels: CHANNELS });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.wsOpenNow, "the websocket to open");
    await svc.wsSettled();
    addLongNonSpeechRun(stub, "typed-a", 10_000);
    stub.addEntry(spoken("said-behind-the-cap", 20_000));
    await eventually(() => stub.wsUpgrades >= 2, "the socket to be reopened unsubscribed", 1500);

    // The reopened (unsubscribed) socket's own fresh baseline — everything
    // added above is already history to it, so the second run has to be new
    // rows past THIS attempt's baseline to mean anything.
    await svc.wsSettled();
    addLongNonSpeechRun(stub, "typed-b", 30_000);
    stub.addEntry(spoken("said-behind-the-cap-again", 40_000));

    // The verdict, not stub.sseOpens — the SSE stream has been live since
    // connect() and finding the speech never touches it.
    await eventually(() => svc.knownSilent, "the box to be marked silent", 1500);
  });

  it("catches a promoted socket the same way, past the same cap", async (t: TestContext) => {
    const stub = await startProdComStub({ channels: CHANNELS });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    const lines = await withLogs(async () => {
      await eventually(() => svc.wsOpenNow, "the websocket to open");
      stub.wsTranscript(spoken("promotes-the-socket"));
      await eventually(() => svc.onWebSocketNow, "promotion");
      await eventually(() => svc.texts().includes("promotes-the-socket"), "the promoting line to land");

      // One healthy window: the promoting delivery satisfies it with no
      // paging (see prodcom-silent-websocket.test.ts's "keeps checking a
      // delivering socket" case), and re-syncs the baseline via a plain row
      // count. REST has nothing yet, so that baseline is 0.
      stub.wsPing();
      await sleep(150);

      // Then it goes quiet for good — still answering heartbeats — while
      // ProdCom accumulates more than a check's worth of non-speech, then one
      // spoken line the socket does not carry.
      addLongNonSpeechRun(stub, "typed-promoted", 30_000);
      stub.addEntry(spoken("missed-behind-the-cap-while-promoted", 40_000));

      // Bounded, same reasoning as the probation case: before this fix the
      // promoted check's own copy of the same paging loop never advanced
      // either, so this timed out every time.
      await eventually(() => svc.onWebSocketNow === false, "the socket to be demoted", 1500);
    });

    assert.equal(svc.knownSilent, true, "the box was not latched as known-silent after demotion");
    assert.equal(
      capHitLines(lines).length,
      1,
      `expected exactly one cap-hit line from the promoted check, got: ${JSON.stringify(lines)}`,
    );
  });
});
