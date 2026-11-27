// What the poller does when PCO rejects the credentials.
//
// Two failures pull in opposite directions and both have happened:
//
//   Asking again every 4s. Observed live on 2026-08-13: "[live-poller] fetch
//   error: PCO auth failed — check App ID/Secret" per tick, forever. The noise
//   evicts the 500-line /log buffer, so the one page you would open to diagnose
//   anything else holds nothing but this.
//
//   Stopping outright. The fix for the above called stop(), and start() is only
//   reached from boot and from integration-manager after a credential check
//   passes — nothing re-verifies on a timer. So ONE 401 ended polling for the
//   life of the process. A 401 is not always a typo: a rotated token, an org
//   re-authorisation or a PCO auth blip produces one, and fetchLive() fans out
//   to several requests. Mid-service that froze every countdown and stopped the
//   SPL, attendance and timeline recorders, which are fed from this tick.
//
// So: keep polling, but slowly. Drives the REAL poller — its own tick, timer and
// catch — with only stageController.fetchLive replaced, on fake timers, so "five
// minutes, not four seconds" is something the test can tell apart. Waiting a
// few real milliseconds and counting one call cannot: a 4 s retry gives one too.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { advance, fakeTime, settle } from "./fixtures/live-poller-clock.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-poller-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { livePoller } = await import("./live-poller.js");
const { stageController } = await import("./stage-controller.js");
const { PcoAuthError } = await import("./pco-service.js");
const { serviceWindow } = await import("./service-window.js");

const realFetchLive = stageController.fetchLive.bind(stageController);
const realPollDelayMs = serviceWindow.pollDelayMs.bind(serviceWindow);

/** The idle cadence, and the auth backoff it must not be mistaken for. */
const IDLE_MS = 4_000;
const AUTH_RETRY_MS = 5 * 60_000;

let calls = 0;
/** Replace the one network call the tick makes, counting attempts. */
function fetchLiveThrows(err: Error): void {
  (stageController as unknown as { fetchLive: () => Promise<unknown> }).fetchLive = () => {
    calls++;
    return Promise.reject(err);
  };
}
function fetchLiveSucceeds(): void {
  (stageController as unknown as { fetchLive: () => Promise<unknown> }).fetchLive = () => {
    calls++;
    return Promise.resolve(null);
  };
}

after(() => fs.rm(TMP, { recursive: true, force: true }));

describe("live-poller auth backoff", () => {
  beforeEach(() => {
    livePoller.stop();
    calls = 0;
    // Hold the service window open, so the idle retry is the plain 4 s whatever
    // schedule this machine has. Dormant, it stretches to five minutes too, and
    // the backoff would be indistinguishable from it.
    (serviceWindow as unknown as { pollDelayMs: (ms: number) => number }).pollDelayMs = (ms) => ms;
  });
  afterEach(() => {
    livePoller.stop();
    (stageController as unknown as { fetchLive: typeof realFetchLive }).fetchLive = realFetchLive;
    (serviceWindow as unknown as { pollDelayMs: typeof realPollDelayMs }).pollDelayMs = realPollDelayMs;
  });

  it("keeps polling after PCO rejects the credentials, so a transient 401 can heal", async (t) => {
    fakeTime(t);
    fetchLiveThrows(new PcoAuthError());
    livePoller.start();
    await settle();
    assert.equal(calls, 1, "the first tick asks once — that is the premise");

    // The regression this guards: stop() here ended polling for the process's
    // life, taking every recorder fed by this tick down with it.
    await advance(t, AUTH_RETRY_MS);
    assert.equal(livePoller["running"], true, "an auth failure must not end polling for the life of the process");
    assert.equal(calls, 2, "the retry must come round");
  });

  it("backs off for five minutes rather than asking once per tick", async (t) => {
    fakeTime(t);
    fetchLiveThrows(new PcoAuthError());
    livePoller.start();
    await settle();

    // The other regression: at the 4 s idle cadence this wrote a line per tick
    // until /log held nothing else. Nothing is asked until the backoff is due…
    await advance(t, AUTH_RETRY_MS - 1_000);
    assert.equal(calls, 1, `an auth failure must not be retried at the ${IDLE_MS / 1000} s idle cadence`);
    // …and then it asks again, because a backoff is not a stop.
    await advance(t, 1_000);
    assert.equal(calls, 2, "the auth retry is due five minutes after the failure");
  });

  it("keeps polling through a TRANSIENT failure at the idle cadence — an outage is not a misconfiguration", async (t) => {
    fakeTime(t);
    fetchLiveThrows(new Error("fetch failed: ECONNREFUSED"));
    livePoller.start();
    await settle();

    await advance(t, IDLE_MS);
    assert.equal(livePoller["running"], true, "a network blip must not disable the countdown");
    assert.equal(calls, 2, "a transient failure is retried at the idle cadence, not backed off");
  });

  it("start() re-arms immediately, which is how saving credentials recovers without waiting out the backoff", async (t) => {
    fakeTime(t);
    fetchLiveThrows(new PcoAuthError());
    livePoller.start();
    await settle();
    assert.equal(calls, 1);

    // What integration-manager does once a credential check passes.
    fetchLiveSucceeds();
    livePoller.start();
    await settle();

    assert.equal(calls, 2, "saving credentials must poll again at once, not after the backoff");
    assert.equal(livePoller["running"], true);
  });
});
