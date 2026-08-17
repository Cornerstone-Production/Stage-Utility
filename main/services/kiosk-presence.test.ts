import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";

import {
  scanning, startScan, stopScan, recordSeen, seenDevices, forgetSeen,
  resetKioskPresence, rememberScreen, rememberSecret, SCAN_WINDOW_MS,
} from "./kiosk-presence.js";
import { addBroadcastListener } from "./broadcaster.js";

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

// Two sources report a screen's size and neither has the whole picture: the
// probe carries the DRM mode (Linux only), the holding screen reports CSS pixels
// (every platform). Whichever arrives second must not erase the first.
describe("a screen's size, from two sources", () => {
  test("a later probe does not erase the size the browser reported", () => {
    const t0 = 1_000_000;
    recordSeen(dev("d1"), t0);
    rememberScreen("d1", { w: 1280, h: 720, dpr: 1.5 });
    // The Linux agent's probe: mode only, and w/h it has no way to know.
    recordSeen(dev("d1", { screen: { w: 0, h: 0, mode: "1920x1080" } }), t0 + 3000);

    const d = seenDevices(t0 + 3000)[0];
    assert.deepEqual(
      d.screen,
      { w: 1280, h: 720, dpr: 1.5, mode: "1920x1080" },
      "the probe overwrote the browser-reported size instead of merging with it",
    );
  });

  test("a probe with no mode does not erase the size either", () => {
    const t0 = 1_000_000;
    recordSeen(dev("d1"), t0);
    rememberScreen("d1", { w: 1920, h: 1080 });
    // macOS and Windows send no mode at all, and the responder passes an
    // EXPLICIT `screen: undefined` for them — which a plain spread happily
    // writes over the top. This is the common case, not the edge one.
    recordSeen(dev("d1", { screen: undefined }), t0 + 3000);
    assert.deepEqual(seenDevices(t0 + 3000)[0].screen, { w: 1920, h: 1080 });
  });

  test("a size for a device nobody has heard from is not invented", () => {
    // /enroll is reachable by anything on the LAN. A size for an unknown id must
    // not conjure a row on the Screens page that no probe ever backed.
    rememberScreen("never-heard-of", { w: 1920, h: 1080 });
    assert.deepEqual(seenDevices().map((d) => d.id), []);
  });
});

// What actually reaches an open Screens page. These drive the real broadcaster,
// because every bug in this area was a value that was computed correctly and
// then never shipped.
describe("what is broadcast", () => {
  const sent: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "kiosk:devices") sent.push(payload);
  });
  const frames = () => sent.length;

  // The real clock, not a synthetic one. rememberScreen and forgetSeen announce
  // against Date.now(), so a device recorded at a made-up timestamp is already
  // past its TTL by the time they run — every assertion below then passes
  // because the device VANISHED, not because the change was broadcast.
  const now = () => Date.now();

  test("a screen size reported while somebody is watching reaches them", () => {
    recordSeen(dev("d1"), now());
    const before = frames();
    // The holding screen reloads 15 seconds after the operator opened Screens,
    // reporting its size. If this does not broadcast, the row stays blank for
    // as long as the page stays open — which is exactly when they are looking.
    rememberScreen("d1", { w: 1280, h: 720, dpr: 1.5 });
    assert.equal(frames(), before + 1, "the reported size never left the server");
  });

  test("a device that changed address reaches them too", () => {
    recordSeen(dev("d2"), now());
    const before = frames();
    recordSeen(dev("d2", { ip: "192.168.16.99" }), now());
    assert.equal(frames(), before + 1, "a new address never left the server");
  });

  test("a device that was renamed reaches them too", () => {
    recordSeen(dev("d5"), now());
    const before = frames();
    recordSeen(dev("d5", { hostname: "renamed-pi" }), now());
    assert.equal(frames(), before + 1, "a new hostname never left the server");
  });

  test("an unchanged probe does not broadcast, so a 2s heartbeat is not a 2s SSE", () => {
    recordSeen(dev("d3"), now());
    const before = frames();
    recordSeen(dev("d3"), now());
    recordSeen(dev("d3"), now());
    assert.equal(frames(), before, "an identical probe broadcast anyway");
  });

  test("a device secret is never in the payload", () => {
    // /api/events is an open GET on the LAN. A secret here is a secret handed to
    // anything that holds the stream open — and it is the only thing separating
    // a claimed display from any other machine on the network.
    recordSeen(dev("d4"), now());
    rememberSecret("d4", "super-secret-token");
    rememberScreen("d4", { w: 800, h: 600 });
    assert.equal(
      JSON.stringify(sent).includes("super-secret-token"),
      false,
      "a device secret went out over the broadcast",
    );
  });

  test("a secret for a device nobody has heard from does not put a row on the page", () => {
    // /enroll is a GET, so the same-origin write guard does not apply to it.
    // Anything on the LAN can call it with any id.
    rememberSecret("never-probed", "x");
    assert.equal(seenDevices().some((d) => d.id === "never-probed"), false);
  });
});
