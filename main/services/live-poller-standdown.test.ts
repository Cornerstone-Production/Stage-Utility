// A poller that keeps asking with credentials PCO has already rejected.
//
// Observed live on 2026-08-13: "[live-poller] fetch error: PCO auth failed —
// check App ID/Secret" every 4 seconds, forever. Retrying cannot fix a
// configuration fault, and the noise evicts the 500-line /log buffer — so the
// one page you would open to diagnose anything else holds nothing but this.
//
// Drives the REAL poller (its own tick, its own timer, its own catch), with
// only stageController.fetchLive replaced, so a change that stopped honouring
// the stand-down would fail here.

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
/** Replace the one network call the tick makes. */
function fetchLiveThrows(err: Error): void {
  (stageController as unknown as { fetchLive: () => Promise<unknown> }).fetchLive = () => Promise.reject(err);
}

const settle = () => new Promise((r) => setTimeout(r, 25));

describe("live-poller stand-down", () => {
  beforeEach(() => {
    livePoller.stop();
  });
  afterEach(() => {
    livePoller.stop();
    (stageController as unknown as { fetchLive: typeof realFetchLive }).fetchLive = realFetchLive;
  });

  it("stops polling when PCO rejects the credentials", async () => {
    fetchLiveThrows(new PcoAuthError());
    livePoller.start();
    await settle();

    assert.equal(poller.running, false, "must stand down rather than ask again");
    assert.equal(poller.timer, null, "and must not leave a tick scheduled");
  });

  it("keeps polling through a TRANSIENT failure — an outage is not a misconfiguration", async () => {
    fetchLiveThrows(new Error("fetch failed: ECONNREFUSED"));
    livePoller.start();
    await settle();

    assert.equal(poller.running, true, "a network blip must not disable the countdown");
    assert.ok(poller.timer !== null, "the next tick must stay scheduled");
  });

  it("start() brings a stood-down poller back, which is how saving credentials revives it", async () => {
    fetchLiveThrows(new PcoAuthError());
    livePoller.start();
    await settle();
    assert.equal(poller.running, false);

    // What integration-manager does after a credential check passes.
    fetchLiveThrows(new Error("transient")); // any non-auth outcome keeps it alive
    livePoller.start();
    await settle();
    assert.equal(poller.running, true, "must be revivable without a server restart");
  });
});
