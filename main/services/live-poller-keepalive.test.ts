// The clock-resync keepalive on pco:live.
//
// Clients measure how far their own clock is behind the server's from the
// `serverNow` on each pco:live frame. That only works if frames keep arriving.
// The keepalive used to live inside tick(), which is scheduled by Planning
// Center's cadence: outside a service window the tick runs every FIVE MINUTES,
// so the 15 s check inside it could not fire any sooner than that. A display
// opened on a Tuesday therefore held a skew of 0 — the host browser's clock,
// whatever that was — for minutes, and every countdown and progress bar on it
// was wrong by the browser's error.
//
// So it runs on its own interval. Drives the REAL poller: only
// stageController.fetchLive and getLastLive are replaced, and fetchLive is made
// to HANG, which is what models a tick that is not coming back round for five
// minutes. Any pco:live frame in that state is the keepalive's, because tick()
// broadcasts nothing until its fetch resolves.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-keepalive-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { livePoller } = await import("./live-poller.js");
const { stageController } = await import("./stage-controller.js");
const { addBroadcastListener, setSubscriberCheck } = await import("./broadcaster.js");
type Controller = {
  fetchLive: () => Promise<unknown>;
  getLastLive: () => unknown;
};
const real = {
  fetchLive: stageController.fetchLive.bind(stageController),
  getLastLive: stageController.getLastLive.bind(stageController),
};

const LAST_LIVE = {
  mode: "idle",
  currentItemId: null,
  label: "Before service",
  serverNow: "2026-09-17T12:00:00.000Z",
};

let fetchCalls = 0;
const frames: Array<{ channel: string; payload: unknown }> = [];
addBroadcastListener((channel, payload) => {
  if (channel === "pco:live") frames.push({ channel, payload });
});

type Poller = { keepaliveTimer: ReturnType<typeof setInterval> | null };

/** A fetch that resolves with a live item whose label moves every time, so the
 *  poller's own tick broadcasts on each of its 1 s passes. */
function fetchAdvances(): void {
  let n = 0;
  (stageController as unknown as Controller).fetchLive = () => {
    fetchCalls++;
    return Promise.resolve({ ...LAST_LIVE, mode: "item", label: `item ${n++}` });
  };
}

/** A fetch that never settles — a tick that is not coming back for five minutes. */
function fetchHangs(): void {
  (stageController as unknown as Controller).fetchLive = () => {
    fetchCalls++;
    return new Promise(() => {});
  };
}

const settle = () => new Promise((r) => setImmediate(r));

/**
 * Fake timers with a fake clock, each case an hour after the last.
 *
 * Date must be mocked too: the keepalive compares Date.now() against when it
 * last pushed, so with a real clock only the FIRST tick ever gets through and
 * the interval would look right while delivering one frame. The hour between
 * cases is because the poller is a module singleton — its last-broadcast stamp
 * survives into the next case, and a real clock leaves it moments in the past.
 */
let base = Date.UTC(2026, 8, 17, 12, 0, 0);
function fakeClock(t: TestContext): void {
  base += 3_600_000;
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: base });
}

describe("live-poller clock keepalive", () => {
  beforeEach(() => {
    livePoller.stop();
    fetchCalls = 0;
    frames.length = 0;
    fetchHangs();
    (stageController as unknown as Controller).getLastLive = () => LAST_LIVE;
    setSubscriberCheck(() => true);
  });

  afterEach(() => {
    livePoller.stop();
    Object.assign(stageController, real);
    setSubscriberCheck(() => true);
  });

  it("re-sends the last live DTO every 15 s without asking Planning Center", async (t) => {
    fakeClock(t);
    livePoller.start();
    await settle();
    assert.equal(fetchCalls, 1, "the initial tick fetches once and then hangs — that is the premise");

    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(15_000);
      await settle();
    }

    assert.equal(frames.length, 3, "a client's skew estimate needs a frame every 15 s, tick or no tick");
    assert.equal(fetchCalls, 1, "the keepalive must never spend a Planning Center request");
  });

  it("stamps each keepalive with a fresh serverNow", async (t) => {
    fakeClock(t);
    livePoller.start();
    await settle();
    t.mock.timers.tick(15_000);
    await settle();

    const payload = frames[0]?.payload as { serverNow?: string; label?: string } | undefined;
    assert.ok(payload, "expected a keepalive frame");
    assert.equal(payload.label, "Before service", "the rest of the DTO is re-sent unchanged");
    assert.notEqual(
      payload.serverNow,
      LAST_LIVE.serverNow,
      "re-sending the stale serverNow teaches the client nothing about its clock",
    );
    assert.ok(Date.parse(payload.serverNow ?? "") > 0, "serverNow must parse as a time");
  });

  it("broadcasts nothing when nobody subscribes to pco:live", async (t) => {
    setSubscriberCheck(() => false);
    fakeClock(t);
    livePoller.start();
    await settle();
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(15_000);
      await settle();
    }
    assert.equal(frames.length, 0, "an unattended appliance must not broadcast into an empty room");
  });

  it("broadcasts nothing before the first successful fetch", async (t) => {
    (stageController as unknown as Controller).getLastLive = () => null;
    fakeClock(t);
    livePoller.start();
    await settle();
    t.mock.timers.tick(15_000);
    await settle();
    assert.equal(frames.length, 0, "there is no DTO to restamp yet");
  });

  it("adds nothing while the tick is already pushing inside the window", async (t) => {
    // During a live item the tick pushes about once a second. A keepalive that
    // fired regardless would be a duplicate frame every 15 s on the busiest
    // channel in the app, for a clock the client has just been told.
    fetchAdvances();
    fakeClock(t);
    livePoller.start();
    await settle();
    assert.equal(frames.length, 1, "the first tick pushes — that is the premise");
    for (let i = 0; i < 15; i++) {
      t.mock.timers.tick(1_000);
      await settle();
    }
    assert.equal(
      frames.length,
      16,
      "one frame per tick and nothing else; a 17th is the keepalive duplicating a push one second old",
    );
  });

  it("stops with the poller, leaving no interval behind", async (t) => {
    fakeClock(t);
    livePoller.start();
    await settle();
    livePoller.stop();
    assert.equal(
      (livePoller as unknown as Poller).keepaliveTimer,
      null,
      "a stopped poller holding a live interval keeps the process awake and fires again on restart",
    );
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(15_000);
      await settle();
    }
    assert.equal(frames.length, 0, "a stopped poller that keeps broadcasting is a config restore writing over itself");
  });
});
