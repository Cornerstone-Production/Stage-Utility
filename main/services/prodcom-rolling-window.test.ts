// ProdCom's transcript is a ROLLING WINDOW, not append-only.
//
// Measured on the live box (24 Sep, 21:08–21:10Z): `GET
// /api/v1/transcript?limit=1&offset=0` reported `meta.totalCount: 3001` at
// 21:08:18, at 21:09:39 and again at 21:09:54 — unmoving — while rows dated
// 21:09:20 and 21:09:46/47 kept arriving at the top of the range, and the
// oldest rows dropped off the bottom. The silence check used to measure a
// socket against a row COUNT taken when it opened: on a box that has filled
// its window, that count never grows again, so "are there rows past the count
// we saw" answers "no" for ever — a socket that has delivered nothing is
// trusted permanently, and a promoted one that goes quiet is never demoted.
// This is the defect prodcom-silent-websocket.test.ts and
// prodcom-promoted-goes-silent.test.ts could not see, because neither ever ran
// their stub past the point where its history stopped growing.
//
// The fix compares entry IDS on ProdCom's newest page instead of a count — see
// prodcom-service.ts's wsBaselineIds, wsDeliveredIds and readNewestPage.
// Everything here runs the real client against a stub already FULL
// (fixtures/prodcom-stub.ts's rollingWindowCap), the exact shape that broke
// the old design.
//
// Manually proven red in this session: with prodcom-service.ts reverted to the
// offset/count baseline it replaced (`git show <pre-fix commit>` restored over
// the file for one run, restored back afterward), the two "gives up" /
// "demotes" cases below time out — the reverted code never notices a full
// box's silent socket at all. See the commit for the exact commands and
// output.
//
// Driven against the real client and fixtures/prodcom-stub.ts.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService } from "./prodcom-service.js";
import { startProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";
import type { ConnState } from "./integration-base.js";

const NOW = Date.parse("2026-09-24T21:08:00Z");

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
  // Long: no case here is about the heartbeat, and it must not fire inside
  // the window a case runs in.
  protected override get heartbeatTimeoutMs(): number {
    return 10_000;
  }
  protected override get wsSilenceCheckMs(): number {
    return 100;
  }
  // Long: this file is not about the fallback retry cadence.
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
  /** The CURRENT websocket attempt's own priming — awaited so a test can add
   *  rows that must count as "since THIS attempt opened", the same seam
   *  prodcom-silent-websocket.test.ts uses. */
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

/** A box already holding exactly `cap` historical rows — a full rolling
 *  window from the moment this service ever connects to it. */
const fullHistory = (cap: number): StubEntry[] => Array.from({ length: cap }, (_, i) => typed(`history-${i}`, i * 1000));

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

describe("the silence check on a box whose transcript is already a full rolling window", () => {
  it("gives up on a silent unproven socket within a bounded number of checks", async (t: TestContext) => {
    // Below WS_SILENCE_CHECK_PAGE_SIZE (100): readNewestPage answers in one
    // request the whole time, since the capped history already fits on it.
    const CAP = 20;
    const stub = await startProdComStub({ channels: CHANNELS, rollingWindowCap: CAP, entries: fullHistory(CAP) });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.wsOpenNow, "the websocket to open");
    await svc.wsSettled();
    // Rolls the window forward — the oldest historical row drops as this one
    // lands, so totalCount stays pinned at CAP from here on, exactly like the
    // live box this bug was found on.
    stub.addEntry(spoken("said-while-subscribed", 10_000));

    await eventually(() => stub.wsUpgrades >= 2, "the socket to be reopened unsubscribed", 3000);

    // Added AFTER the reopened socket's own baseline settles — otherwise it
    // is old news to THIS socket, not evidence it missed anything. The stub
    // counts an upgrade before the client's onopen has run, and until it does
    // wsSettled() is still the old socket's settled priming; the old socket was
    // closed first, so wsOpenNow is what says the new one is up.
    await eventually(() => svc.wsOpenNow, "the reopened socket to open");
    await svc.wsSettled();
    stub.addEntry(spoken("said-while-unsubscribed", 20_000));

    await eventually(() => svc.knownSilent, "the box to be marked silent", 3000);
    assert.equal(svc.onWebSocketNow, false, "a socket that never delivered was promoted anyway");
  });

  it("demotes a promoted socket that stops delivering while a full window keeps turning over", async (t: TestContext) => {
    // Above WS_SILENCE_CHECK_PAGE_SIZE (100): readNewestPage needs its second
    // request (the tail read) to reach the newest rows on every check here.
    const CAP = 150;
    const stub = await startProdComStub({ channels: CHANNELS, rollingWindowCap: CAP, entries: fullHistory(CAP) });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.wsOpenNow, "the websocket to open");
    stub.wsTranscript(spoken("promotes-the-socket", 200_000));
    await eventually(() => svc.onWebSocketNow, "promotion");
    await eventually(() => svc.texts().includes("promotes-the-socket"), "the promoting line to land");

    // One healthy window: the promoting delivery satisfies it with no
    // verdict needed, and re-syncs the baseline to the newest page's ids for
    // free (see runPromotedSilenceCheck's deliveredThisWindow branch).
    stub.wsPing();
    await sleep(150);

    // Then it goes quiet for good while the window keeps rolling forward —
    // totalCount stays pinned at CAP the entire time.
    stub.addEntry(spoken("missed-while-promoted", 210_000));
    stub.wsPing();

    await eventually(() => svc.onWebSocketNow === false, "the socket to be demoted", 3000);
    assert.equal(svc.knownSilent, true, "the box was not latched as known-silent after demotion");
  });

  it("does not condemn a full box merely because REST could not be asked", async (t: TestContext) => {
    const CAP = 150;
    const stub = await startProdComStub({ channels: CHANNELS, rollingWindowCap: CAP, entries: fullHistory(CAP) });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.wsOpenNow, "the websocket to open");
    await svc.wsSettled();
    stub.setFailTranscript(true);

    // Several check intervals, all of them unable to reach REST.
    await sleep(400);

    assert.equal(svc.wsOpenNow, true, "a REST failure on a full box tore down a socket nothing was known about");
    assert.equal(svc.knownSilent, false, "a REST failure on a full box was recorded as a verdict about it");
  });
});

describe("the silence check on a box whose window has not filled yet", () => {
  it("still finds a spoken row when a burst adds more new rows than one page holds", async (t: TestContext) => {
    const stub = await startProdComStub({ channels: CHANNELS }); // uncapped, unbounded growth
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.wsOpenNow, "the websocket to open");
    await svc.wsSettled();

    // 121 new rows in one window: more than WS_SILENCE_CHECK_PAGE_SIZE (100).
    // No paging is needed to find the spoken one — it is the newest row, so
    // it is on the newest page whatever else arrived alongside it.
    for (let i = 0; i < 120; i++) stub.addEntry(typed(`typed-${i}`, 10_000 + i));
    stub.addEntry(spoken("said-in-the-burst", 200_000));

    await eventually(
      () => stub.wsUpgrades >= 2,
      "the socket to be reopened unsubscribed once the burst's spoken row is found",
      3000,
    );
  });
});

describe("what the check does and does not count as missed", () => {
  // The generic "REST cannot be asked" case — on an unbounded box — is
  // prodcom-silent-websocket.test.ts's "leaves the socket alone when REST
  // cannot be asked, and says so"; the capped/full variant is above, in "does
  // not condemn a full box merely because REST could not be asked".

  it("does not count a line the socket itself delivered, even once REST catches up on it later", async (t: TestContext) => {
    // The race wsDeliveredIds exists for: the socket delivers a line before
    // REST's own history knows about it (a ProdCom whose REST list lags its
    // websocket by a beat), so the very next baseline refresh cannot include
    // it — only the socket's own record of having delivered it can.
    const stub = await startProdComStub({ channels: CHANNELS });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    await eventually(() => svc.wsOpenNow, "the websocket to open");
    const line = spoken("delivered-first-rest-later", 5_000);
    stub.wsTranscript(line); // delivered over the socket ONLY, so far
    await eventually(() => svc.onWebSocketNow, "the delivery to promote the socket");
    await eventually(() => svc.texts().includes(line.text), "the line to land");

    // A healthy window passes. The "delivered this window" refresh reads
    // REST while it still knows nothing about the line — baseline is taken
    // with the line absent from it.
    await sleep(150);

    // REST catches up. If the check trusted the refreshed baseline alone,
    // this spoken row — not in a baseline taken before REST had it — would
    // read as one the socket missed.
    stub.addEntry(line);
    await sleep(300);

    assert.equal(svc.onWebSocketNow, true, "a line the socket itself delivered was later treated as one it missed");
    assert.equal(svc.knownSilent, false, "a working socket was latched as known-silent over its own delivery");
  });
});
