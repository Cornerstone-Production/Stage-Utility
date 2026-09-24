// A WebSocket that opens, heartbeats, and delivers no transcript at all.
//
// The incident (18–20 Sep 2026): prod's captions were empty for two days while
// the ProdCom integration card read connected. The socket opened seven times,
// got `{"type":"welcome"}` listing the transcript stream, sent the documented
// `{"type":"subscribe","events":["transcript"]}`, and received not one transcript
// frame — `handleWsFrame` logs the envelope once per connection and warns once on
// an unrecognised frame, and NEITHER line is anywhere in prod's log. Meanwhile
// `GET /api/v1/transcript` had the lines all along.
//
// Nothing noticed, because every liveness check in the service treats ANY frame
// as proof of life and ProdCom's heartbeat kept arriving. So the SSE fallback —
// which had carried captions for months — never engaged: from the client's view
// nothing had dropped.
//
// Everything here runs the real client against fixtures/prodcom-stub.ts: real
// sockets, real RFC 6455 frames, a real refused/accepted handshake, a real REST
// API. Nothing on the network is contacted. The three intervals are overridden
// through the service's own seams rather than with t.mock.timers, because faking
// setTimeout underneath undici's WebSocket breaks the client itself — the same
// reason prodcom-websocket.test.ts overrides its constants.
//
// NOT COVERED HERE, and deliberately: how the two new card messages LOOK. What is
// asserted below is that the service reports them, which is the half that was
// wrong — the row said `Streaming from host:port` over a transport carrying
// nothing. What happens to them afterwards is CSS: ConnectionBadge caps the
// message at `max-w-[14rem] sm:max-w-md` with `truncate` and puts the full text
// in a hover tooltip, and both of those are invisible to jsdom, which loads no
// stylesheet and measures every element as zero. An assertion about either would
// pass whatever the stylesheet said. `Fallback stream — the websocket carried no
// transcript` is 51 characters and will ellipsis on a narrow card; it leads with
// the word that matters for that reason.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService, PROBE_USER_AGENT } from "./prodcom-service.js";
import { startProdComStub, type ProdComStub, type StubEntry, type StubOptions } from "./fixtures/prodcom-stub.js";
import { addBroadcastListener } from "./broadcaster.js";
import type { ConnState } from "./integration-base.js";
import { DEFAULT_RECONNECT_SCHEDULE, serviceWindow } from "./service-window.js";

const NOW = Date.parse("2026-09-20T13:22:28Z");

/** The card message the service reports while captions are on the fallback
 *  because the socket carried nothing. Written out rather than imported, so a
 *  change to the string is a change to this file too. */
const FALLBACK_CARD_MESSAGE = "Fallback stream — the websocket carried no transcript";
/** And what it says for the minute a known-silent box's socket is re-tested. */
const RETESTING_CARD_MESSAGE = "Re-testing the websocket that carried no transcript";

class TestProdCom extends ProdComService {
  public readonly reports: { state: ConnState; message: string | null }[] = [];

  constructor() {
    super();
    this.setConnectionListener((state, message) => this.reports.push({ state, message }));
  }

  /**
   * A fixed wall clock that nevertheless MOVES, in real time from the moment
   * this service was constructed.
   *
   * Fixed so `?since=` and the four-hour horizon are deterministic against the
   * stub's fixtures. Moving because OutageLog measures its settle window with
   * this clock, and a frozen one makes every failure zero milliseconds old — so
   * nothing ever settles, no recovery is ever reported, and the guard below on
   * "a doomed re-test was announced as a recovery" could not go red either way.
   */
  private readonly startedAt = Date.now();
  protected override now(): number {
    return NOW + (Date.now() - this.startedAt);
  }
  /** Long: no case here is about the heartbeat, and the stub is deliberately
   *  silent, so a short one would reconnect underneath every assertion. */
  protected override get heartbeatTimeoutMs(): number {
    return 30_000;
  }
  protected override get reconnectMs(): number {
    return 25;
  }
  /** The real sixty seconds, in milliseconds. */
  protected override get wsSilenceCheckMs(): number {
    return 150;
  }
  /** The real five minutes. */
  protected override get wsRetryIntervalMs(): number {
    return 60;
  }
  /** The real half hour — 25x the narrow one, as 30 min is 6x 5 min, so
   *  "the widened interval did not fire" is a statement about the widening. */
  protected override get wsSilentRetryIntervalMs(): number {
    return 1_500;
  }
  /**
   * The outage log's real two-minute settle window, scaled to sit BELOW the
   * re-test interval above exactly as two minutes sits below half an hour.
   *
   * Left at its default it would swallow the whole test: every failure and
   * success here happens inside two minutes of the last, so `ok()` would never
   * report a recovery and "the re-test was announced as a recovery" could not
   * be observed either way.
   */
  protected override get wsOutageSettleMs(): number {
    return 200;
  }

  /** Whether the WebSocket has been PROMOTED: it delivered a transcript entry
   *  and the SSE fallback closed in its favour. None of the silence-check
   *  machinery below needs this — it works entirely on OPEN, unproven sockets —
   *  so most cases in this file want `wsOpenNow`, not this. */
  public get onWebSocketNow(): boolean {
    return this.onWebSocketTransport;
  }
  /** Whether a WebSocket attempt is currently open (handshake complete),
   *  proven or not — true throughout probation and every re-test. */
  public get wsOpenNow(): boolean {
    return this.wsAttemptOpen;
  }
  public get knownSilent(): boolean {
    return this.boxKnownSilent;
  }
  public get retryArmed(): boolean {
    return this.wsRetryArmed;
  }
  public get sseUpNow(): boolean {
    return this.sseStreamUp;
  }
  /** The SSE stream's own priming (channels, keywords, backfill). */
  public settled(): Promise<void> {
    return this.priming;
  }
  /** The CURRENT WebSocket attempt's own priming — just the silence check's
   *  baseline row count, which is all a WebSocket attempt reads for itself now
   *  that the SSE stream owns keeping the buffer caught up. This is what
   *  `speaks()` below needs: the baseline has to be captured before a test adds
   *  rows that must count as "since this socket opened". */
  public wsSettled(): Promise<void> {
    return this.wsBaselinePriming;
  }
  public texts(): string[] {
    return this.getBuffer().map((l) => l.text);
  }
}

const CHANNELS = [{ id: "CH-A", name: "Lead TB", color: "#00F900" }];

/** A spoken line, dated AFTER the socket opens — which is the whole question the
 *  check asks REST. */
const spoken = (id: string, offsetMs = 30_000): StubEntry => ({
  id,
  channelId: "CH-A",
  channelName: "Lead TB",
  text: id,
  source: "audio",
  inProgress: false,
  date: new Date(NOW + offsetMs).toISOString(),
});

/** A line that is NOT somebody speaking. An operator typing into a comms channel
 *  is not evidence that the socket missed a caption. */
const typed = (id: string, offsetMs = 30_000): StubEntry => ({ ...spoken(id, offsetMs), source: "typed" });

async function running(t: TestContext, options: StubOptions = {}): Promise<{ stub: ProdComStub; svc: TestProdCom }> {
  const stub = await startProdComStub({ channels: CHANNELS, ...options });
  const svc = new TestProdCom();
  t.after(async () => {
    svc.stop();
    await stub.close();
  });
  svc.configure("127.0.0.1", stub.port, null);
  return { stub, svc };
}

/** `what` may be a thunk, for a message that should describe the state AT
 *  FAILURE rather than the state when the wait started. */
async function eventually(ready: () => boolean, what: string | (() => string), timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${typeof what === "function" ? what() : what}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `fn` with console.log/warn captured. console.debug is left alone: it is
 *  the level log-buffer does not capture, so nothing on it reaches `/log`. */
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

/** Real client upgrades only. The refused-upgrade probe hits the same path (see
 *  prodcom-upgrade-probe.test.ts) and counting it would make one refusal look
 *  like two attempts. */
const wsAttempts = (stub: ProdComStub): number =>
  stub.requests.filter((r) => r.url === "/api/v1/ws" && r.headers["user-agent"] !== PROBE_USER_AGENT).length;

/**
 * Reads of `GET /api/v1/transcript` made BY THE SILENCE CHECK.
 *
 * Matched on the check's own page size, which backfill cannot produce: backfill
 * asks for the spec's documented maximum of 200 and the check asks for 20. A
 * plain count of transcript reads would be satisfied by the backfill every
 * transport does on connect, and every assertion here about what the check did
 * or did not cost would then be true whether or not the check ran at all.
 */
const silenceChecks = (stub: ProdComStub): number =>
  stub.requests.filter((r) => r.url.startsWith("/api/v1/transcript?") && r.url.includes("limit=20&")).length;

/**
 * Reads the check made BEYOND its first page, on a connection whose baseline is
 * zero.
 *
 * `running()` seeds no history, so the first socket's baseline row count is 0 and
 * the check's pages fall at offset 0, 20, 40. `offset=20` is therefore a read the
 * paging loop can only have made by paging, and a client that reads one page per
 * attempt never produces it however many attempts it makes — which a count of
 * reads would not distinguish.
 */
const pagedReads = (stub: ProdComStub): number =>
  stub.requests.filter((r) => {
    if (!r.url.startsWith("/api/v1/transcript?")) return false;
    const params = new URL(r.url, "http://stub").searchParams;
    return params.get("limit") === "20" && params.get("offset") === "20";
  }).length;

const subscribeFrames = (stub: ProdComStub): number =>
  stub.wsReceived.filter((f) => f.includes('"subscribe"')).length;

/** What the integration card has been told, in order, for the states that claim
 *  captions are flowing. Position in this list is not asserted beyond the last
 *  entry: report() is driven by a transport coming up, so a slow machine can put
 *  one more or one fewer transition in the middle. */
const cardMessages = (svc: TestProdCom): (string | null)[] =>
  svc.reports.filter((r) => r.state === "connected").map((r) => r.message);

/**
 * Collects every "prodcom:transcript" broadcast fired while a test runs, the
 * same seam prodcom-redaction.test.ts and prodcom-duplicate-broadcast.test.ts
 * use.
 *
 * The headline guards below drove svc.texts() — the internal buffer — instead
 * of this, so a defect that withheld every broadcast during probation and
 * every re-test (while still applying lines to the buffer underneath) left
 * both tests green: they never once asked whether a DISPLAY would have seen
 * anything.
 */
function spyOnTranscriptBroadcasts(): unknown[] {
  const seen: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "prodcom:transcript") seen.push(payload);
  });
  return seen;
}

/** Whether any captured "prodcom:transcript" broadcast carried a line with
 *  this text. */
function broadcastCarried(broadcasts: unknown[], text: string): boolean {
  return broadcasts.some((payload) => Array.isArray(payload) && payload.some((l: { text?: unknown }) => l.text === text));
}

/**
 * Somebody speaks while the socket is up.
 *
 * The rows appear on ProdCom AFTER this connection took its baseline, which is
 * what "a line the socket never delivered" means. Seeding them through
 * `entries` instead puts them in the history the connection started from, where
 * they are not missed lines at all — and a guard built that way would pass on a
 * client that never noticed anything.
 */
async function speaks(stub: ProdComStub, svc: TestProdCom, ...rows: StubEntry[]): Promise<void> {
  await eventually(() => svc.wsOpenNow, "the websocket to open");
  await svc.wsSettled();
  for (const row of rows) stub.addEntry(row);
}

describe("a websocket that delivers nothing is not a healthy connection", () => {
  it("asks REST whether anything was missed, and does nothing when nobody has spoken", async (t) => {
    // The quiet-room case, and the one that must not act: the socket has
    // delivered nothing because there is nothing to deliver. ProdCom's history
    // holds only a line from before the socket opened.
    const { stub, svc } = await running(t, { entries: [spoken("said-before-we-connected", -120_000)] });
    await eventually(() => svc.wsOpenNow, "the websocket to open");
    await svc.wsSettled();

    // Three check intervals, with heartbeats throughout, exactly as a quiet
    // weeknight looks.
    for (let i = 0; i < 6; i++) {
      stub.wsPing();
      await sleep(80);
    }

    assert.ok(
      silenceChecks(stub) > 0,
      "the check never asked REST anything — a socket delivering nothing was simply trusted",
    );
    assert.equal(svc.wsOpenNow, true, "a socket with nothing to deliver was torn down anyway");
    assert.equal(stub.sseOpens, 1, "the fallback reconnected over a quiet room instead of staying as it was");
    assert.equal(svc.knownSilent, false, "a quiet room was recorded as a broken box");
  });

  it("does not count a typed line as somebody speaking", async (t) => {
    // `typed` and `automation` entries never become captions, so a socket that
    // did not deliver one has missed nothing. Counting them would tear down a
    // working transport every time an operator typed into a comms channel.
    const { stub, svc } = await running(t);
    await speaks(stub, svc, typed("cam-2-go-wide"));

    await sleep(500);
    assert.equal(svc.wsOpenNow, true, "a typed comms message was treated as a missed caption");
    assert.equal(stub.sseOpens, 1, "the fallback reconnected because an operator typed something");
  });

  it("does not tear down a healthy socket because ProdCom's clock runs fast", async (t) => {
    // A ProdCom is an appliance and its clock is its own — the Ultritouch panel
    // on this network is about seven hours fast with no NTP. So any question of
    // the form "is there a row newer than <a time from OUR clock>" is decided on
    // the difference between two clocks, not on whether anybody spoke.
    //
    // Here: one line genuinely spoken two minutes BEFORE the socket opened, on a
    // box stamping ten minutes fast, and silence afterwards. Nothing was missed.
    const skew = 10 * 60_000;
    const { stub, svc } = await running(t, {
      now: () => NOW + skew,
      entries: [spoken("said-before-we-connected-on-a-fast-box", -120_000 + skew)],
    });
    await eventually(() => svc.wsOpenNow, "the websocket to open");
    await svc.wsSettled();

    await eventually(() => silenceChecks(stub) >= 2, "the check to run twice");
    assert.equal(svc.wsOpenNow, true, "a healthy socket was torn down by a clock difference");
    assert.equal(stub.sseOpens, 1, "captions were moved off the initial fallback by a clock difference");
    assert.equal(svc.knownSilent, false, "a fast appliance clock was recorded as a broken ProdCom");
  });

  it("still catches a silent socket when ProdCom's clock runs slow", async (t) => {
    // The mirror, and the worse half: a box stamping ten minutes SLOW makes every
    // row look older than the socket, so a time-based question answers "nobody
    // spoke" for ever and the bug this whole check exists for goes undetected
    // with the suite green.
    const skew = -10 * 60_000;
    const { stub, svc } = await running(t, { now: () => NOW + skew });
    await speaks(stub, svc, spoken("said-while-the-socket-was-quiet-on-a-slow-box", 30_000 + skew));
    // Once for the subscribed socket, once for the unsubscribed one it is
    // reopened as — each has to be shown silent while somebody is speaking.
    await eventually(() => stub.wsUpgrades >= 2, "the socket to be reopened unsubscribed", 6000);
    await speaks(stub, svc, spoken("and-again-on-the-unsubscribed-socket", 60_000 + skew));

    // The verdict, not stub.sseOpens — the SSE stream has been live since
    // connect() and this box's silence never touches it.
    await eventually(() => svc.knownSilent, "the box to be marked silent", 6000);
  });

  it("does not apply a slow REST answer to the socket that replaced the one it was about", async (t) => {
    // connectionEpoch is bumped only by teardown(), and an ordinary drop does
    // not tear down — ws.onclose schedules a reconnect and the next socket opens
    // without touching it. So the epoch check passes, `this.ws !== null` passes,
    // and a verdict computed over socket A's window lands on socket B seconds
    // into its life. In production the read has four seconds and the reconnect
    // floor is one, so one slow transcript read during one drop is enough.
    const { stub, svc } = await running(t, {
      // Only the CHECK's reads are held, by its page size — priming stays fast,
      // so the line below is spoken before the first check even fires. 1400 ms
      // because the answer has to land AFTER the replacement socket is up, and
      // service-window.ts floors every reconnect delay at one second: a shorter
      // hold returns while `this.ws` is still null and no verdict is reachable,
      // which is a test that proves nothing.
      delayTranscriptMs: (url) => (url.searchParams.get("limit") === "20" ? 1400 : 0),
    });
    await speaks(stub, svc, spoken("said-while-the-first-socket-was-up"));

    await eventually(() => silenceChecks(stub) >= 1, "the check to put a read in flight");
    stub.wsDropAll();
    await eventually(() => stub.wsUpgrades >= 2, "the replacement socket to open", 6000);
    await sleep(1200); // past the held answer

    assert.equal(
      subscribeFrames(stub),
      stub.wsUpgrades,
      "a verdict about a socket that had already gone was applied to its replacement, " +
        "which stopped sending the frame ProdCom's own specification defines",
    );
    assert.equal(svc.knownSilent, false, "a box was condemned on a window that was not its socket's");
  });

  it("finds speech sitting behind a full page of typed lines", async (t) => {
    // `GET /api/v1/transcript` is ascending from the OLDEST row, so the check's
    // first page is the first twenty rows added since the socket opened — not
    // the most recent. The baseline never advances, so a run of typed rows
    // longer than a page at the head of that window would pin the check on
    // "nobody spoke" for the life of the connection, however much was said
    // afterwards.
    const said = [
      ...Array.from({ length: 22 }, (_, i) => typed(`typed-${i}`, 10_000 + i)),
      spoken("said-behind-the-typed-run", 40_000),
    ];
    const { stub, svc } = await running(t);
    await speaks(stub, svc, ...said);

    // That the check reads BEYOND its first page, asserted before any outcome
    // and on the request the paging loop can only make by paging. The outcome
    // assertions below cannot stand in for this: in the single-page world they
    // are never reached, because the `eventually` for the fallback times out
    // first — so an assertion after them is decoration whatever it says.
    await eventually(
      () => pagedReads(stub) >= 1,
      "the check to read past its first page — a single-page read can never see behind the typed run",
    );

    await eventually(() => stub.wsUpgrades >= 2, "the socket to be reopened unsubscribed", 6000);
    await speaks(stub, svc, ...said.map((e) => ({ ...e, id: `${e.id}-again` })));

    // The verdict, not stub.sseOpens — the SSE stream has been live since
    // connect() and finding the speech never touches it.
    await eventually(() => svc.knownSilent, "the box to be marked silent once the speech is found", 6000);
  });

  it("reopens the socket without the subscribe frame when REST has lines it never delivered", async (t) => {
    // The prod failure, and the hypothesis the fix tests first: ProdCom's
    // `subscribe` acts as a filter and the filter is broken, so asking for
    // ["transcript"] yields nothing while sending nothing yields everything.
    let stub: ProdComStub | null = null;
    let svc: TestProdCom | null = null;
    const lines = await withLogs(async () => {
      const c = await running(t, { subscribeFilterBroken: true });
      stub = c.stub;
      svc = c.svc;
      await speaks(c.stub, c.svc, spoken("said-while-the-socket-was-quiet"));
      assert.equal(subscribeFrames(c.stub), 1, "the first attempt must send the documented subscribe frame");

      // The vendor bug: this goes to nobody, because the only open socket asked
      // for the transcript stream.
      c.stub.wsTranscript(spoken("swallowed-by-the-filter"));
      await eventually(() => stub!.wsUpgrades >= 2, "the socket to be reopened");
      await c.svc.wsSettled();
      // The reopened socket sent no subscribe frame, so the stub delivers to it.
      c.stub.wsTranscript(spoken("arrived-with-no-filter"));
      await eventually(() => c.svc.texts().includes("arrived-with-no-filter"), "the entry to land on the buffer");
    });

    assert.equal(subscribeFrames(stub!), 1, "the reopened socket sent the subscribe frame again");
    assert.equal(svc!.onWebSocketNow, true, "the working socket was abandoned");
    assert.equal(stub!.sseOpens, 1, "the fallback reconnected instead of just closing once the socket proved itself");
    assert.ok(
      lines.some((l) => l.startsWith("[prodcom] websocket delivered no transcript in ")),
      `expected the silent-socket line naming the missed lines, got: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((l) =>
        l.startsWith("[prodcom] the websocket delivers the transcript with no subscribe frame sent"),
      ),
      `expected the line naming which subscription worked, got: ${JSON.stringify(lines)}`,
    );
  });

  it("falls back to SSE when the socket is silent with and without the subscribe frame, and the card says so", async (t) => {
    // The box accepts every upgrade and carries nothing on any of them. After
    // both subscription modes have been tried, captions belong on the transport
    // that works — and the integration row must stop claiming a healthy socket.
    let stub: ProdComStub | null = null;
    let svc: TestProdCom | null = null;
    const lines = await withLogs(async () => {
      const c = await running(t);
      stub = c.stub;
      svc = c.svc;
      await speaks(c.stub, c.svc, spoken("nobody-ever-saw-this-over-the-socket"));
      await eventually(() => c.stub.wsUpgrades >= 2, "the socket to be reopened unsubscribed", 6000);
      await speaks(c.stub, c.svc, spoken("nor-this-one-over-the-unsubscribed-socket", 60_000));
      // The verdict, not stub.sseOpens — the SSE stream has been live since
      // connect() and this box's silence never touches it.
      await eventually(() => c.svc.knownSilent, "the box to be marked silent", 6000);
    });

    assert.equal(svc!.onWebSocketNow, false, "a socket that never proved itself was promoted anyway");
    assert.equal(svc!.knownSilent, true, "the box was not recorded as one whose socket carries nothing");
    assert.ok(
      lines.some((l) =>
        l.startsWith("[prodcom] websocket delivered no transcript with or without the subscribe frame"),
      ),
      `expected the fallback decision line, got: ${JSON.stringify(lines)}`,
    );
    // Waited for, not asserted on the spot: sseOpens above counts the SERVER
    // accepting the stream, and the card is told when the CLIENT sees the 200.
    await eventually(
      () => cardMessages(svc!).at(-1) === FALLBACK_CARD_MESSAGE,
      `the integration card to stop reporting a plain healthy stream while the socket is the reason ` +
        `captions moved — it says ${JSON.stringify(cardMessages(svc!).at(-1))}`,
    );
    // The socket is SHUT, not just dropped on the floor — giveUpOnUnprovenWebSocket
    // closes it before doing anything else. Nulling the reference alone would
    // leave an open connection to the box for the life of the process, one per
    // re-test, every half hour.
    await eventually(() => stub!.openWebSockets === 0, "the silent socket to be closed");

    // The fallback was never a placeholder — it was already carrying whatever
    // was said the whole time this ran, and still is.
    stub!.sseSend(spoken("spoken-on-the-fallback"));
    await eventually(() => svc!.texts().includes("spoken-on-the-fallback"), "an SSE event to land");
  });

  it("keeps checking a delivering socket, but does not tear it down over a quiet room", async (t) => {
    // The controller's ruling: promotion is not permanent on the strength of
    // one frame, so the check must keep running rather than go silent for
    // good the moment a socket first proves itself — see
    // prodcom-idle-after-promotion.test.ts's sibling concern for the SSE side
    // of the same principle. What it must NOT do is act on a quiet room:
    // ProdCom's history holds nothing beyond this connection's baseline the
    // whole time, so every window after the one delivery has nothing to
    // demote over.
    const { stub, svc } = await running(t, { entries: [spoken("in-prodcoms-history")] });
    await eventually(() => svc.wsOpenNow, "the websocket to open");
    await svc.wsSettled();

    stub.wsTranscript(spoken("delivered-over-the-socket"));
    await eventually(() => svc.texts().includes("delivered-over-the-socket"), "the entry to land");

    for (let i = 0; i < 8; i++) {
      stub.wsPing();
      await sleep(60);
    }
    assert.ok(silenceChecks(stub) > 0, "the check stopped running after the socket's first delivery");
    assert.equal(svc.onWebSocketNow, true, "a delivering socket sitting in a quiet room was torn down");
    assert.equal(stub.sseOpens, 1, "a quiet room reopened the fallback that promotion had already closed");
  });

  it("leaves the socket alone when REST cannot be asked, and says so", async (t) => {
    // "No lines" and "could not ask" are indistinguishable from the client, and
    // acting on the second is how a transport that is working gets torn down.
    let stub: ProdComStub | null = null;
    let svc: TestProdCom | null = null;
    const lines = await withLogs(async () => {
      const c = await running(t);
      stub = c.stub;
      svc = c.svc;
      // Primed first, so this connection HAS a baseline and the check genuinely
      // asks — then the endpoint goes away under it. Starting with it broken
      // would exercise the no-baseline path instead, which is a different thing.
      await speaks(c.stub, c.svc, spoken("said-while-the-socket-was-quiet"));
      c.stub.setFailTranscript(true);
      await eventually(() => silenceChecks(c.stub) >= 1, "the check to ask REST");
      await sleep(200);
    });

    assert.equal(svc!.wsOpenNow, true, "a REST failure tore down a socket nothing was known about");
    assert.equal(stub!.sseOpens, 1, "a REST failure reconnected the fallback that was already carrying captions");
    assert.equal(svc!.knownSilent, false, "a REST failure was recorded as a verdict about the box");
    const couldNotAsk = lines.filter((l) =>
      l.startsWith("[prodcom] could not check whether the websocket is missing transcript lines"),
    );
    assert.ok(couldNotAsk.length >= 1, `expected the could-not-ask line, got: ${JSON.stringify(lines)}`);
    // Once per outage, not once per interval. The check re-arms every interval,
    // so an unreachable REST endpoint under a socket that is up wrote this line
    // 1440 times a day into a 10,000-line ring, burying everything else an
    // operator opened /log to read. Every other repeated failure in this service
    // goes through OutageLog; this one did not.
    assert.equal(
      couldNotAsk.length,
      1,
      `the could-not-ask line repeats per check rather than per outage: ${JSON.stringify(couldNotAsk)}`,
    );
  });

  it("broadcasts a line spoken during the websocket's probation minute immediately, via SSE", async (t) => {
    // The defect this whole fix exists for: withholding captions while an
    // unproven socket is tested. The socket above never delivers anything in
    // this window — that is what "probation" means — so a caption spoken right
    // now must reach a display over the SSE stream, which has to already be
    // live for that to be possible.
    //
    // Asserted on the BROADCAST, not svc.texts(): a version that applies the
    // line to the buffer but withholds every broadcast during probation is a
    // version where no display ever sees it, and the buffer alone cannot tell
    // the two apart.
    const broadcasts = spyOnTranscriptBroadcasts();
    const { stub, svc } = await running(t);
    await eventually(() => svc.wsOpenNow, "the websocket to open (unproven, on probation)");
    assert.equal(svc.onWebSocketNow, false, "promoted before it ever delivered anything");

    stub.sseSend(spoken("live-during-probation"));
    await eventually(
      () => broadcastCarried(broadcasts, "live-during-probation"),
      "the SSE line to be broadcast during probation",
    );
  });
});

describe("a box whose socket carries nothing stops being preferred", () => {
  /** Drive a box to the point where both subscription modes have been tried and
   *  captions are on the fallback. */
  async function silenced(
    t: TestContext,
    options: StubOptions = {},
  ): Promise<{ stub: ProdComStub; svc: TestProdCom }> {
    const { stub, svc } = await running(t, options);
    await speaks(stub, svc, spoken("never-delivered-over-a-socket"));
    await eventually(() => stub.wsUpgrades >= 2, "the socket to be reopened unsubscribed", 6000);
    await speaks(stub, svc, spoken("nor-over-the-unsubscribed-one", 60_000));
    await eventually(() => svc.knownSilent, "the box to be known silent", 6000);
    // The CLIENT's signal, not the stub's: the retry is armed once the give-up
    // completes, a tick or two after the server saw it. Waiting on the server's
    // side and then asserting on the client's is a race that only shows up under
    // load.
    await eventually(() => svc.retryArmed, "the widened retry to be armed on the fallback");
    return { stub, svc };
  }

  it("widens the retry so re-testing it does not cost a REST call and a closed socket every few minutes", async (t) => {
    // The trap in the naive fix. A five-minute retry against a box known to carry
    // nothing on its socket still costs a REST call and a closed socket every
    // time it fires — free against a box that only REFUSES, not against one that
    // opens and says nothing.
    const { stub, svc } = await silenced(t);
    const attempts = wsAttempts(stub);
    const sseOpensAtStart = stub.sseOpens;

    // Eight narrow intervals (60 ms) — the old timer would have made several
    // attempts in this window. That SOMETHING still re-tests it is the next
    // case, which waits for the re-test itself.
    await sleep(500);
    assert.equal(
      wsAttempts(stub),
      attempts,
      "the narrow retry is still running against a box already known to carry nothing on its socket",
    );
    assert.equal(
      stub.sseOpens,
      sseOpensAtStart,
      "the fallback reconnected to re-test a socket already known to be silent, though it was never touched",
    );
    assert.equal(svc.onWebSocketNow, false, "a socket that never proved itself was promoted anyway");
  });

  it("widens the reconnect counter too, so a flapping fallback does not re-test it every few seconds", async (t) => {
    // There are TWO rules that come back to the WebSocket — the clock above and
    // a count of SSE reconnects — and widening one while leaving the other is
    // how the copies drift. A box that is dropping its fallback reconnects every
    // few seconds, so the counter alone would re-open a known-silent socket, and
    // cost a caption gap, several times a minute.
    const stub = await startProdComStub({
      channels: CHANNELS,
      // The fallback opens and ends at once, so reconnects are what this box
      // does — which is exactly when the counter fires.
      sseCloseImmediately: true,
    });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);
    await speaks(stub, svc, spoken("never-delivered-over-a-socket"));
    await eventually(() => stub.wsUpgrades >= 2, "the socket to be reopened unsubscribed", 6000);
    await speaks(stub, svc, spoken("nor-over-the-unsubscribed-one", 60_000));

    await eventually(() => svc.knownSilent, "the box to be known silent", 6000);
    const attempts = wsAttempts(stub);
    // Five: past the every-third rule, short of the widened every-twentieth one.
    // It takes about five seconds, because service-window.ts floors every
    // reconnect delay at one second and the reconnectMs seam cannot go under it.
    await eventually(() => stub.sseOpens >= 5, "the fallback to reconnect several times", 12_000);

    assert.equal(
      wsAttempts(stub),
      attempts,
      "the every-third-reconnect rule is still re-opening a socket already known to carry nothing",
    );
  });

  it("re-tests it eventually, and drops it again without a REST call when it is still silent", async (t) => {
    // Widened, not removed: useWebSocket is only ever turned back on by the two
    // retry rules, so dropping them would leave a ProdCom fixed in place
    // undiscovered until this server restarts. The re-test is on probation —
    // the question has already been answered for this box, so no REST call is
    // spent asking it again.
    const { stub, svc } = await silenced(t);
    const checksBefore = silenceChecks(stub);
    const sseOpensBefore = stub.sseOpens;

    const lines = await withLogs(async () => {
      await eventually(() => svc.wsOpenNow, "the widened retry to re-test the socket", 6000);
      await eventually(() => !svc.wsOpenNow, "the re-tested socket to be dropped again", 6000);
    });

    // The fallback was never touched to run this re-test at all — it is what
    // was carrying captions throughout the minute the socket was on probation.
    assert.equal(stub.sseOpens, sseOpensBefore, "the fallback reconnected to run a re-test that never touches it");
    assert.ok(
      lines.some((l) => l.startsWith("[prodcom] the websocket has carried no transcript in ")),
      `expected the probation line, got: ${JSON.stringify(lines)}`,
    );
    // A socket that opens on a box known to carry nothing has not recovered.
    // Without this, every re-test prints "websocket is back" and then a fallback
    // line, half an hour apart, for ever — the outage log's two-minute settle
    // window cannot see a flap that slow.
    assert.deepEqual(
      lines.filter((l) => l.startsWith("[prodcom] websocket is back")),
      [],
      "a re-test that was dropped a minute later was announced as a recovery",
    );
    assert.ok(
      cardMessages(svc).includes(RETESTING_CARD_MESSAGE),
      `the card claimed a healthy stream for the minute the known-silent socket was being re-tested: ` +
        `${JSON.stringify(cardMessages(svc))}`,
    );
    assert.equal(
      silenceChecks(stub),
      checksBefore,
      "the probation re-test spent a REST call re-asking a question already answered for this box",
    );
  });

  it("broadcasts a line spoken during a re-test immediately, via SSE", async (t) => {
    // The other half of the defect: a re-test is exactly where the old design's
    // besideFallback.onopen tore the SSE stream down to adopt the unproven
    // socket, cutting captions for the length of the check. The re-test must
    // never take over the live transport — a line spoken during it has to keep
    // arriving over SSE.
    //
    // Asserted on the BROADCAST, not svc.texts() — see the probation case
    // above for why the buffer alone cannot catch a withheld broadcast.
    const broadcasts = spyOnTranscriptBroadcasts();
    const { stub, svc } = await silenced(t);
    await eventually(() => svc.wsOpenNow, "the widened retry to re-test the socket", 6000);
    assert.equal(svc.onWebSocketNow, false, "the re-test took over the live transport merely by opening");

    stub.sseSend(spoken("live-during-the-re-test"));
    await eventually(
      () => broadcastCarried(broadcasts, "live-during-the-re-test"),
      "the SSE line to be broadcast during the re-test",
    );
  });

  it("promoting the retry's socket does not open a second one beside it", async (t) => {
    // promoteWebSocket()'s dropFallbackStream() destroys the SSE request to
    // close it once the retry's socket has PROVEN itself. That destroy reaches
    // connectSse's own error handler, which — without the `this.req !== req`
    // guard nulling the field first — would read it as the stream dropping:
    // countSseReconnect(), then scheduleReconnect(), then connect() assigning
    // over `this.ws` while the promoted socket is still live. closeSocket()
    // could then no longer reach it, leaking it for the life of the process.
    // This runs every half hour for ever on a box whose socket carries nothing,
    // so a leak here is not a one-off.
    //
    // This case alone no longer needs the `this.req !== req` guard to pass:
    // connect()'s own `!this.onWebSocket` and `!this.ws` checks (see
    // prodcom-transport-invariants.test.ts) already block a second SSE stream
    // or a second socket while promoted, on their own. See the reconfigure
    // case below for the scenario that guard is actually load-bearing for.
    const stub = await startProdComStub({ channels: CHANNELS, refuseWebSocket: true });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);
    await eventually(() => svc.retryArmed, "the retry to be armed on the fallback");

    stub.setRefuseWebSocket(false); // ProdCom is back
    await eventually(() => svc.wsOpenNow, "the retry's socket to open");
    // Delivering promotes it and disarms the check, so nothing else in this file
    // can drop it.
    stub.wsTranscript(spoken("proof-the-box-works"));
    await eventually(() => svc.texts().includes("proof-the-box-works"), "the entry to land");
    assert.equal(svc.onWebSocketNow, true, "delivering a transcript entry did not promote the retry's socket");

    const attempts = wsAttempts(stub);
    // Past the reconnect floor, which service-window.ts holds at one second.
    await sleep(1500);
    // Two assertions because there are two halves, and each is separately
    // reachable: the deliberate destroy must not be READ as a drop (no further
    // attempt at all), and connectWebSocket must not assign over a live socket
    // if one ever does happen (nothing leaked). Asserting only the second passes
    // on a client that still churns a socket a second after every promotion.
    assert.equal(
      wsAttempts(stub),
      attempts,
      "destroying our own SSE request to close it once promoted was read as the stream dropping, " +
        "and the reconnect it scheduled dialled the box again",
    );
    assert.equal(stub.openWebSockets, 1, "a second socket was opened beside the promoted one and leaked");
    assert.equal(svc.onWebSocketNow, true, "the promoted socket was lost");
  });

  it("a reconfigure while the old SSE request is being torn down does not corrupt the new one", async (t) => {
    // The scenario the `this.req !== req` guard actually exists for: teardown()
    // (configure() calling restart() calling stop()) runs dropFallbackStream()
    // on the OLD request the instant a reconfigure happens, and connectSse()
    // for the NEW box can already be under way by the time that destroy's
    // belated 'error' fires. Without the identity check, that stale handler
    // would null `this.req` out from under the NEW request and schedule a
    // reconnect that has nothing to do with it — every future event for the
    // NEW request then sees `this.req !== req` (true, now pointing at nothing)
    // and bails, leaking an open SSE connection to the new box that nothing
    // ever watches, reconnects, or reports on again.
    const stubA = await startProdComStub({ channels: CHANNELS });
    const stubB = await startProdComStub({ channels: CHANNELS });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stubA.close();
      await stubB.close();
    });

    svc.configure("127.0.0.1", stubA.port, null);
    await eventually(() => svc.sseUpNow, "the first SSE stream to come up");

    svc.configure("127.0.0.1", stubB.port, null); // reconfigure mid-flight
    await eventually(() => stubB.sseOpens >= 1, "the new SSE stream to open against the new box");
    await eventually(() => svc.sseUpNow, "the new SSE stream to come up");
    // A corrupted this.req does not fail cleanly — it storms: each stale
    // handler nulls this.req, connect() reads that as room for a fresh
    // attempt, and the fresh attempt's own handlers are just as vulnerable to
    // the NEXT stale event. A momentary "connected" is not evidence of health
    // on its own; a settled connection count is.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(stubB.sseOpens, 1, `reconfiguring caused a reconnect storm against the new box: ${stubB.sseOpens} open(s)`);
    assert.equal(svc.sseUpNow, true, "the new connection did not stay up");

    // And the transport actually works: a line the old request's stale
    // teardown would have silently dropped by nulling this.req out from
    // under the new one.
    stubB.sseSend(spoken("after-reconfigure"));
    await eventually(() => svc.texts().includes("after-reconfigure"), "a line on the NEW box to land");
  });

  it("names the refusal, not silence, when a known-silent box then refuses the upgrade", async (t) => {
    // Two different failures reach the fallback and the card described both as
    // the first, because the message was keyed on what was known about the BOX
    // rather than on why captions moved THIS time. A refused upgrade arrives
    // through probeThenGiveUp, and the row then read "the websocket carried no
    // transcript" about a socket that never opened.
    //
    // Reaching it needs the reconnect counter rather than the clock: either way
    // the fallback is never touched by the attempt itself, but the counter's
    // attempt is what actually runs while this box is refusing outright, so its
    // refusal is the one that re-reports the card.
    //
    // service-window.ts floors every reconnect at one second, which would make
    // twenty of them a twenty-second test. Switched off for this case only, and
    // restored after — the floor is not what is under test here.
    const schedule = { ...DEFAULT_RECONNECT_SCHEDULE, enabled: false };
    serviceWindow.setSchedule(schedule);
    t.after(() => serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE }));

    const { stub, svc } = await silenced(t, { sseCloseImmediately: true });
    stub.setRefuseWebSocket(true);

    await eventually(
      () => cardMessages(svc).at(-1) !== FALLBACK_CARD_MESSAGE,
      () =>
        `the card to stop blaming a silent socket for an upgrade that was refused — ` +
        `it says ${JSON.stringify(cardMessages(svc).at(-1))}`,
      15_000,
    );
  });

  it("SSE's own reconnect message also stops blaming silence once a re-test is refused", async (t) => {
    // The other half of the case above: giveUpOnUnprovenWebSocket's own report
    // was already keyed on THIS attempt's reason, not on wsSilentBox — but
    // connectSse's OWN card message, printed on every SSE (re)connect, read
    // wsSilentBox directly, which the refusal does not clear. With SSE
    // cycling constantly (sseCloseImmediately), its message is the one that
    // keeps overwriting the card, and a refusal must not have it revert to
    // blaming the box's earlier silence.
    const schedule = { ...DEFAULT_RECONNECT_SCHEDULE, enabled: false };
    serviceWindow.setSchedule(schedule);
    t.after(() => serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE }));

    const { stub, svc } = await silenced(t, { sseCloseImmediately: true });
    stub.setRefuseWebSocket(true);

    // A socket that opened moments before setRefuseWebSocket(true) can still
    // be mid-probation, and correctly concludes silent for that ALREADY-OPEN
    // attempt — that is not the bug, it is truthful about an attempt that
    // really did open before the box started refusing. Once THAT settles, it
    // arms the box's own widened silent-retry cadence (1_500 ms here) before
    // trying again, so the fresh, definitely-refused attempt this test is
    // actually about is not guaranteed to exist for a while. Wait past that
    // cadence, then require the fallback message to be gone AND stay gone —
    // catching a version that still flips back to it on some later SSE cycle,
    // not just one that is slow to leave it the first time.
    await eventually(
      () => cardMessages(svc).at(-1) !== FALLBACK_CARD_MESSAGE,
      () => `the refusal to stop the card blaming silence — it says ${JSON.stringify(cardMessages(svc).at(-1))}`,
      15_000,
    );
    await new Promise((r) => setTimeout(r, 2_000));
    await eventually(
      () => cardMessages(svc).at(-1) !== FALLBACK_CARD_MESSAGE,
      () => `the refusal to stop the card blaming silence, past the widened retry cadence too — it says ${JSON.stringify(cardMessages(svc).at(-1))}`,
    );
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 30));
      assert.notEqual(
        cardMessages(svc).at(-1),
        FALLBACK_CARD_MESSAGE,
        "SSE's own reconnect message reverted to blaming silence after the box started refusing the upgrade outright",
      );
    }
  });

  it("alternates the subscription on consecutive re-tests", async (t) => {
    // The mode used to latch: once a filtered socket had been shown silent,
    // every re-test for the life of the process connected unsubscribed. A
    // ProdCom build that fixes the subscription and makes the frame mandatory —
    // what its own specification implies is the intent — would then be re-tested
    // wrongly for ever, dropped by probation each time, and cost a caption gap
    // every thirty minutes on a box that had been FIXED.
    const { stub } = await silenced(t);
    const before = subscribeFrames(stub);

    // Two more re-tests, each dropped again by probation.
    await eventually(() => stub.wsUpgrades >= 4, "two further re-tests", 12_000);

    assert.ok(
      subscribeFrames(stub) > before,
      `every re-test connected unsubscribed, so a box that requires the frame can never come back ` +
        `(${subscribeFrames(stub)} subscribe frames across ${stub.wsUpgrades} sockets)`,
    );
  });

  it("keeps the socket the moment a re-test delivers", async (t) => {
    // ProdCom fixed, upgraded or restarted. Nothing about the verdict is
    // permanent: one transcript entry over a socket clears it.
    const { stub, svc } = await silenced(t);
    const lines = await withLogs(async () => {
      await eventually(() => svc.wsOpenNow, "the widened retry to re-test the socket", 6000);
      stub.wsTranscript(spoken("the-box-was-fixed"));
      await eventually(() => svc.texts().includes("the-box-was-fixed"), "the entry to land");
      // Past the one-second reconnect floor, not merely past the probation
      // interval. At 300 ms this passed while the beside-retry was opening a
      // second socket over the adopted one about a second later — the guard
      // looked before the damage, which is why that leak survived a whole review.
      await sleep(1500);
    });

    assert.equal(svc.onWebSocketNow, true, "a socket that delivered was dropped anyway");
    assert.equal(svc.knownSilent, false, "the box is still recorded as silent after its socket delivered");
    assert.ok(
      lines.some((l) => l.startsWith("[prodcom] the websocket is carrying the transcript again")),
      `expected the recovery line, got: ${JSON.stringify(lines)}`,
    );
  });

  it("forgets everything it learned when the integration is reconfigured", async (t) => {
    // A different box, a different key, or an operator who has just upgraded
    // ProdCom is on the other end now. configure() runs on enable too, so this
    // is also what a disable/enable does.
    const { stub, svc } = await silenced(t);
    svc.configure("127.0.0.1", stub.port, null);

    assert.equal(svc.knownSilent, false, "a verdict about the old box survived a reconfigure");
    await eventually(() => svc.wsOpenNow, "the fresh attempt to open a socket");
    await eventually(() => subscribeFrames(stub) >= 2, "the fresh attempt to send the documented subscribe frame");
  });
});
