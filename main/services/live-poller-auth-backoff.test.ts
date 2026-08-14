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
// catch — with only stageController.fetchLive replaced.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-poller-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { livePoller } = await import("./live-poller.js");
const { stageController } = await import("./stage-controller.js");
const { PcoAuthError } = await import("./pco-service.js");

type Poller = { running: boolean; timer: ReturnType<typeof setTimeout> | null };
const poller = livePoller as unknown as Poller;

const realFetchLive = stageController.fetchLive.bind(stageController);

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

const settle = () => new Promise((r) => setTimeout(r, 25));

describe("live-poller auth backoff", () => {
  beforeEach(() => {
    livePoller.stop();
    calls = 0;
  });
  afterEach(() => {
    livePoller.stop();
    (stageController as unknown as { fetchLive: typeof realFetchLive }).fetchLive = realFetchLive;
  });

  it("keeps polling after PCO rejects the credentials, so a transient 401 can heal", async () => {
    fetchLiveThrows(new PcoAuthError());
    livePoller.start();
    await settle();

    // The regression this guards: stop() here ended polling for the process's
    // life, taking every recorder fed by this tick down with it.
    assert.equal(poller.running, true, "an auth failure must not end polling for the life of the process");
    assert.ok(poller.timer !== null, "a retry must stay scheduled");
  });

  it("backs off hard rather than asking once per tick", async () => {
    fetchLiveThrows(new PcoAuthError());
    livePoller.start();
    await settle();

    // The other regression: at the 4s idle cadence this wrote a line per tick
    // until /log held nothing else. One attempt in the settle window means the
    // retry was scheduled minutes out, not seconds.
    assert.equal(calls, 1, "must not retry immediately after an auth failure");
  });

  it("keeps polling through a TRANSIENT failure — an outage is not a misconfiguration", async () => {
    fetchLiveThrows(new Error("fetch failed: ECONNREFUSED"));
    livePoller.start();
    await settle();

    assert.equal(poller.running, true, "a network blip must not disable the countdown");
    assert.ok(poller.timer !== null, "the next tick must stay scheduled");
  });

  it("start() re-arms immediately, which is how saving credentials recovers without waiting out the backoff", async () => {
    fetchLiveThrows(new PcoAuthError());
    livePoller.start();
    await settle();
    const afterAuthFailure = calls;

    // What integration-manager does once a credential check passes.
    fetchLiveSucceeds();
    livePoller.start();
    await settle();

    assert.ok(calls > afterAuthFailure, "saving credentials must poll again at once, not after the backoff");
    assert.equal(poller.running, true);
  });
});
