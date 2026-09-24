// ProdCom's reconnect back-off, and the once-per-outage WebSocket logging.
//
// No sockets and no stub server: connect() is a no-op in the subclass and
// scheduleIn() records the delay instead of arming a timer, so the back-off ramp
// is read directly rather than waited out. The clock is the service's own now()
// seam, which is what lets the outage log's settle window be crossed without a
// two-minute test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProdComService } from "./prodcom-service.js";

const T0 = Date.parse("2026-09-15T12:00:00Z");

class TestProdCom extends ProdComService {
  public delays: number[] = [];
  public lines: string[] = [];
  public clock = T0;

  /** Nothing is dialled — this suite is about what gets SCHEDULED, not what
   *  answers. */
  protected override async connect(): Promise<void> {}

  protected override scheduleIn(delayMs: number): void {
    this.delays.push(delayMs);
  }

  protected override now(): number {
    return this.clock;
  }

  public retry(): void {
    this.scheduleReconnect();
  }

  public fallBack(reason: string): void {
    this.noteWebSocketDown(reason);
  }

  public wsHealthy(): void {
    this.noteWebSocketHealthy();
  }

  /** Promotes the WebSocket — the first delivered transcript entry, in the
   *  real client. Safe to call directly in this synthetic suite: connect() is
   *  a no-op here, so there is no fallback stream or real socket for
   *  promoteWebSocket()'s teardown calls to touch. */
  public promote(): void {
    this.noteWebSocketDelivered();
  }
}

const realWarn = console.warn;
const realLog = console.log;

function started(): TestProdCom {
  const svc = new TestProdCom();
  svc.configure("127.0.0.1", 65535, null);
  svc.start();
  svc.delays = [];
  return svc;
}

/** Run `body` with console.warn/log collected onto the service. */
function capturing(svc: TestProdCom, body: () => void): void {
  const push = (...args: unknown[]) => svc.lines.push(args.map(String).join(" "));
  console.warn = push;
  console.log = push;
  try {
    body();
  } finally {
    console.warn = realWarn;
    console.log = realLog;
  }
}

describe("reconnect back-off", () => {
  it("grows across consecutive failures instead of retrying flat forever", () => {
    // GUARD. scheduleReconnect() was overridden to a flat `scheduleIn(4000)`, so
    // a box that was off all week was dialled every four seconds all week —
    // alone among the integrations in ignoring the service window.
    const svc = started();
    svc.retry();
    svc.retry();
    svc.retry();
    svc.stop();

    assert.equal(svc.delays.length, 3, "three failures must queue three retries");
    assert.equal(svc.delays[0], 4000, "the first retry must stay fast — a caption stream cannot wait");
    assert.ok(
      svc.delays[1] > svc.delays[0] && svc.delays[2] > svc.delays[1],
      `the back-off is flat: scheduled ${svc.delays.join(", ")}ms, so an unreachable box is dialled forever at one rate`,
    );
  });

  it("a promoted transport coming up clears the ramp, so the next outage starts fast again", () => {
    const svc = started();
    svc.retry();
    svc.retry();
    svc.delays = [];
    svc.promote();
    svc.wsHealthy();
    svc.retry();
    svc.stop();

    assert.equal(svc.delays[0], 4000, "resetBackoff() did not run when the PROMOTED transport came up");
  });

  it("an UNPROVEN websocket's heartbeat does not clear the SSE ramp", () => {
    // A box whose REST/SSE stack is broken but whose WebSocket still answers
    // heartbeats must not get its fallback ramp reset by that heartbeat — or
    // the fallback keeps retrying at the fastest interval forever, hammering
    // whatever is actually broken instead of backing off from it. Only SSE's
    // own success, or a PROMOTED socket's health, may reset it (see the case
    // above).
    const svc = started();
    svc.retry();
    svc.retry();
    svc.delays = [];
    svc.wsHealthy(); // unpromoted
    svc.retry();
    svc.stop();

    assert.ok(
      svc.delays[0]! > 4000,
      `an unproven websocket's heartbeat reset the SSE ramp: scheduled ${svc.delays[0]}ms, expected it to keep climbing`,
    );
  });

  it("the idle watchdog's reconnect still gets scheduled", () => {
    // The header comment at the top of prodcom-service.ts turns on this: a
    // half-open socket emits neither 'end' nor 'error', so the watchdog is the
    // only thing that reconnects. Moving to the base back-off must not lose it.
    const svc = started();
    svc.retry();
    svc.stop();
    assert.equal(svc.delays.length, 1, "the watchdog path no longer queues a reconnect");
  });
});

describe("WebSocket fallback logging", () => {
  it("says it once per outage, not once per retry", () => {
    // GUARD. The fallback line was unconditional, so a box with the API off
    // wrote it every few seconds for the length of the outage.
    const svc = started();
    capturing(svc, () => {
      svc.fallBack("closed before open (code 1006)");
      svc.clock += 5_000;
      svc.fallBack("closed before open (code 1006)");
    });
    svc.stop();

    const falling = svc.lines.filter((l) => l.includes("falling back to the transcript SSE stream"));
    assert.equal(
      falling.length,
      1,
      `two consecutive fallbacks wrote ${falling.length} lines, one per retry:\n  ${falling.join("\n  ")}`,
    );
  });

  it("announces the recovery once, and a genuinely new outage again", () => {
    const svc = started();
    capturing(svc, () => {
      svc.fallBack("code 1006");
      // A recovery that has HELD past the settle window ends the run.
      svc.clock += 5 * 60_000;
      svc.wsHealthy();
      svc.wsHealthy(); // every frame calls it; only the first may speak
      svc.clock += 60_000;
      svc.fallBack("code 1006");
    });
    svc.stop();

    const back = svc.lines.filter((l) => l.includes("websocket is back"));
    assert.equal(back.length, 1, `the recovery printed ${back.length} times:\n  ${svc.lines.join("\n  ")}`);

    const falling = svc.lines.filter((l) => l.includes("falling back to the transcript SSE stream"));
    assert.equal(falling.length, 2, "a second, separate outage was swallowed by the first one's run");
  });

  it("a different failure kind inside one outage is still news", () => {
    const svc = started();
    capturing(svc, () => {
      svc.fallBack("closed before open (code 1006)");
      svc.clock += 5_000;
      svc.fallBack("HTTP 401");
    });
    svc.stop();

    const falling = svc.lines.filter((l) => l.includes("falling back to the transcript SSE stream"));
    assert.equal(falling.length, 2, "a key rejection hidden behind an earlier upgrade failure is a different problem");
  });
});
