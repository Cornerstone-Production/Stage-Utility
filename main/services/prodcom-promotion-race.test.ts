// A verdict computed about an UNPROVEN websocket must not land on a socket that
// has since been PROMOTED.
//
// Two things can be out when a socket delivers its first entry and promotion
// closes the SSE fallback: the pre-promotion silence check's REST read, and the
// refused-upgrade probe about an earlier attempt that never opened. Either one,
// answered stale, used to close the promoted socket through the unproven
// give-up path, which never clears the promoted flag. What was left: no socket,
// no SSE stream, a retry timer that bails while "promoted", and a card still
// reading "Streaming from host:port" — captions gone until a reconfigure.
//
// Driven against the real client and fixtures/prodcom-stub.ts. Each case ends
// by saying something on BOTH transports and asking whether either reached the
// buffer, since the defect is that neither does.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { ProdComService, PROBE_USER_AGENT } from "./prodcom-service.js";
import { eventually, startProdComStub, type ProdComStub, type StubEntry } from "./fixtures/prodcom-stub.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");

class TestProdCom extends ProdComService {
  protected override now(): number {
    return NOW;
  }
  protected override get reconnectMs(): number {
    return 20;
  }
  // Long: neither case is about the heartbeat, and it must not drop a socket
  // inside the window these run in.
  protected override get heartbeatTimeoutMs(): number {
    return 10_000;
  }
  protected override get wsSilenceCheckMs(): number {
    return 250;
  }
  protected override get wsRetryIntervalMs(): number {
    return 100;
  }
  protected override get wsSilentRetryIntervalMs(): number {
    return 150;
  }
  public get promoted(): boolean {
    return this.onWebSocketTransport;
  }
  public get open(): boolean {
    return this.wsAttemptOpen;
  }
  public get sseUpNow(): boolean {
    return this.sseStreamUp;
  }
  public get baseline(): ReadonlySet<string> | null {
    return this.wsBaseline;
  }
  public texts(): string[] {
    return this.getBuffer().map((l) => l.text);
  }
}

const spoken = (id: string): StubEntry => ({
  id,
  channelId: "CH-A",
  channelName: "Lead",
  text: id,
  source: "audio",
  inProgress: false,
  date: new Date(NOW).toISOString(),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The silence check's own reads of `GET /api/v1/transcript` — the backfill is
 *  the only other caller, and it always sends `since`. */
const isCheckRead = (url: URL): boolean => url.pathname === "/api/v1/transcript" && !url.searchParams.has("since");

/** Say one line on each transport and report whether either reached the buffer. */
async function captionsStillFlow(stub: ProdComStub, svc: TestProdCom, tag: string): Promise<boolean> {
  stub.sseSend(spoken(`${tag}-over-sse`));
  stub.wsTranscript(spoken(`${tag}-over-ws`));
  try {
    await eventually(
      () => svc.texts().includes(`${tag}-over-sse`) || svc.texts().includes(`${tag}-over-ws`),
      "a line on either transport",
      1500,
    );
    return true;
  } catch {
    return false;
  }
}

function state(stub: ProdComStub, svc: TestProdCom): string {
  return JSON.stringify({
    promoted: svc.promoted,
    wsOpen: svc.open,
    sseUp: svc.sseUpNow,
    sseStreams: stub.openSseStreams,
    sockets: stub.openWebSockets,
  });
}

describe("a stale verdict about an unproven socket leaves a promoted one alone", () => {
  it("promotion while the pre-promotion check's REST read is out", async (t: TestContext) => {
    let hold = false;
    const stub = await startProdComStub({
      channels: [{ id: "CH-A", name: "Lead" }],
      delayTranscriptMs: (url) => (hold && isCheckRead(url) ? 400 : 0),
    });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    // Socket A, subscribed: REST shows a line it never carried, so the check
    // reopens it without the subscribe frame. That makes the NEXT verdict the
    // one that gives up on the socket outright.
    await eventually(() => svc.open && svc.baseline !== null, "socket A open with a baseline");
    stub.addEntry(spoken("said-while-A-was-open"));
    await eventually(() => stub.wsUpgrades >= 2, "the unsubscribed reopen");
    await eventually(() => svc.open && svc.baseline !== null, "socket B open with a baseline");
    stub.addEntry(spoken("said-while-B-was-open"));

    // Hold B's check read, and have B deliver its first entry while it is out.
    const before = stub.requests.filter((r) => isCheckRead(new URL(r.url, "http://stub"))).length;
    hold = true;
    await stub.waitForRequest((r) => isCheckRead(new URL(r.url, "http://stub")), before + 1, 3000);
    stub.wsTranscript(spoken("b-delivers-now"));
    await eventually(() => svc.promoted, "promotion during the held read");
    hold = false;
    await sleep(700); // the held read answers, and its verdict is about the unproven B

    const after = state(stub, svc);
    assert.equal(svc.promoted && svc.open && stub.openWebSockets === 1, true, `the promoted socket was closed: ${after}`);
    assert.ok(await captionsStillFlow(stub, svc, "after"), `captions are dead: ${after}; buffer ${JSON.stringify(svc.texts())}`);
  });

  it("promotion while the refusal probe about an earlier attempt is out", async (t: TestContext) => {
    // Past the SSE reconnect's one-second floor, so the reconnect is what opens
    // the next socket while this probe is still out.
    const PROBE_HOLD_MS = 2000;
    let holdProbe = true;
    const stub = await startProdComStub({
      channels: [{ id: "CH-A", name: "Lead" }],
      refuseWebSocket: true,
      delayUpgradeMs: (headers) => (holdProbe && headers["user-agent"] === PROBE_USER_AGENT ? PROBE_HOLD_MS : 0),
    });
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await stub.close();
    });
    svc.configure("127.0.0.1", stub.port, null);

    // Socket A is refused and never opens; its probe is now held.
    await stub.waitForRequest((r) => r.headers["user-agent"] === PROBE_USER_AGENT, 1, 3000);
    const probeAnswersAt = Date.now() + PROBE_HOLD_MS;
    holdProbe = false;
    // The box starts accepting, and the SSE stream drops: the reconnect opens
    // socket B beside a fresh stream while A's probe is still out.
    stub.setRefuseWebSocket(false);
    await stub.waitForSse(1);
    stub.sseBreakAll();
    await eventually(() => svc.open, "socket B to open while A's probe is held");
    assert.ok(Date.now() < probeAnswersAt, "precondition: B opened after A's probe had already answered");
    stub.wsTranscript(spoken("b-delivers-now"));
    await eventually(() => svc.promoted, "B's promotion");
    // A's probe answers, about an attempt that is long gone.
    await sleep(probeAnswersAt - Date.now() + 300);

    const after = state(stub, svc);
    assert.equal(svc.promoted && svc.open && stub.openWebSockets === 1, true, `the promoted socket was closed: ${after}`);
    assert.ok(await captionsStillFlow(stub, svc, "after"), `captions are dead: ${after}; buffer ${JSON.stringify(svc.texts())}`);
  });
});
