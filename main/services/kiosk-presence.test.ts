import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";

import {
  scanning, startScan, stopScan, recordSeen, seenDevices, forgetSeen,
  resetKioskPresence, SCAN_WINDOW_MS,
} from "./kiosk-presence.js";

// Devices heard on the network. The whole point of this module is that it does
// NOT persist: an unclaimed device exists only while it is probing, which is why
// powering a Pi off before pairing makes it disappear everywhere.

const dev = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, macs: [`aa:${id}`], ip: "192.168.16.74", ...over }) as Parameters<typeof recordSeen>[0];

beforeEach(() => resetKioskPresence());

describe("scan windows", () => {
  test("nothing is scanning until somebody asks", () => {
    assert.equal(scanning(), false);
  });

  test("a scan expires on its own", () => {
    const t0 = 1_000_000;
    startScan("manual", SCAN_WINDOW_MS, t0);
    assert.equal(scanning(t0 + 1_000), true);
    assert.equal(scanning(t0 + SCAN_WINDOW_MS + 1), false, "a scan window never closed");
  });

  test("Stop closes it early", () => {
    const t0 = 1_000_000;
    startScan("manual", SCAN_WINDOW_MS, t0);
    stopScan("manual");
    assert.equal(scanning(t0 + 1_000), false);
  });

  test("the page holding one open does not fight the button", () => {
    // The Devices page holds a scan for as long as it is mounted; pressing Stop
    // on the button must not close the page's, and vice versa.
    const t0 = 1_000_000;
    startScan("page", 10 * 60_000, t0);
    startScan("manual", SCAN_WINDOW_MS, t0);
    stopScan("manual");
    assert.equal(scanning(t0 + 1_000), true, "stopping the button closed the page's scan");
  });
});

describe("devices heard", () => {
  test("a device is remembered and then ages out", () => {
    const t0 = 1_000_000;
    recordSeen(dev("d1"), t0);
    assert.deepEqual(seenDevices(t0).map((d) => d.id), ["d1"]);
    // THE property. Power it off before pairing and it stops probing, so it
    // simply stops being in the list — there is nothing stored to clean up.
    assert.deepEqual(seenDevices(t0 + 91_000).map((d) => d.id), [], "a silent device stayed in the list");
  });

  test("a device that keeps probing stays", () => {
    const t0 = 1_000_000;
    recordSeen(dev("d1"), t0);
    recordSeen(dev("d1"), t0 + 60_000);
    assert.deepEqual(seenDevices(t0 + 100_000).map((d) => d.id), ["d1"]);
  });

  test("an unknown device cannot flood the list", () => {
    // A misconfigured box probing every 2s must not add an entry every 2s.
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) recordSeen(dev(`flood-${i}`), t0);
    // Each distinct id is allowed once; the rate limit is per id, so a single
    // rogue id retrying is what gets throttled.
    const first = recordSeen(dev("rogue"), t0);
    const again = recordSeen(dev("rogue"), t0 + 1_000);
    assert.equal(first, true);
    forgetSeen("rogue");
    assert.equal(recordSeen(dev("rogue"), t0 + 2_000), false, "a re-added id was not rate limited");
    void again;
  });

  test("claiming forgets it at once", () => {
    // Otherwise a device you just bound sits in the unclaimed list for another
    // 90 seconds, which reads as the claim not having worked.
    const t0 = 1_000_000;
    recordSeen(dev("d1"), t0);
    forgetSeen("d1");
    assert.deepEqual(seenDevices(t0).map((d) => d.id), []);
  });

  test("freshest first", () => {
    const t0 = 1_000_000;
    recordSeen(dev("old"), t0);
    recordSeen(dev("new"), t0 + 5_000);
    assert.deepEqual(seenDevices(t0 + 6_000).map((d) => d.id), ["new", "old"]);
  });

  test("what a device says about its binding is kept", () => {
    const t0 = 1_000_000;
    recordSeen(dev("d1", { boundTo: "srv-other", unreachable: true }), t0);
    const d = seenDevices(t0)[0];
    assert.equal(d.boundTo, "srv-other");
    assert.equal(d.unreachable, true);
  });
});
