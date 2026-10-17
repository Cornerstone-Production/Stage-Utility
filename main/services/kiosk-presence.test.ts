import assert from "node:assert/strict";
import { describe, test, beforeEach, afterEach, mock } from "node:test";

import {
  scanning, startScan, stopScan, recordSeen, seenDevices, forgetSeen,
  resetKioskPresence, rememberScreen, rememberSecret, SCAN_WINDOW_MS,
  recordHealth, healthList, forgetHealth, MAX_SEEN, noteReleased,
} from "./kiosk-presence.js";
import { HEALTH_TTL_MS } from "./output-health.js";
import { addBroadcastListener } from "./broadcaster.js";

// Devices heard on the network. The whole point of this module is that it does
// NOT persist: an unclaimed device exists only while it is probing, which is why
// powering a Pi off before pairing makes it disappear everywhere.

const dev = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, macs: [`aa:${id}`], ip: "192.168.1.54", ...over }) as Parameters<typeof recordSeen>[0];

beforeEach(() => resetKioskPresence());

describe("an output heard", () => {
  test("is kept on the device so Screens can group and name it", () => {
    const output = { kind: "display" as const, name: "HDMI 1", port: "HDMI 1" };
    recordSeen(dev("mac1.hdmi-1", { output }), Date.now());
    assert.deepEqual(seenDevices()[0].output, output);
  });
});

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

  test("claiming forgets it at once", () => {
    // Otherwise a device you just bound sits in the unclaimed list for another
    // 90 seconds, which reads as the claim not having worked.
    const t0 = 1_000_000;
    recordSeen(dev("d1"), t0);
    forgetSeen("d1");
    assert.deepEqual(seenDevices(t0).map((d) => d.id), []);
  });

  test("a device claimed and released inside a minute is listed again at once", () => {
    // Heard, claimed (forgotten), released: the output is a candidate again the
    // moment it is next heard.
    const t0 = 1_000_000;
    recordSeen(dev("d1"), t0);
    forgetSeen("d1");
    recordSeen(dev("d1"), t0 + 10_000);
    assert.deepEqual(seenDevices(t0 + 10_000).map((d) => d.id), ["d1"]);
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

// Devices are listed with no scan open, so anything on the LAN that can send a
// datagram can add to this list. What it may hold, and what is said about it, are
// bounded and logged.
describe("a list that is always open", () => {
  const T0 = 1_000_000;
  const lines: string[] = [];
  const warnings: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const frames: { seen: { id: string }[] }[] = [];
  let listening = false;
  beforeEach(() => {
    lines.length = 0;
    warnings.length = 0;
    frames.length = 0;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
    if (!listening) {
      listening = true;
      addBroadcastListener((channel, payload) => {
        if (channel === "kiosk:devices") frames.push(payload as (typeof frames)[number]);
      });
    }
  });
  afterEach(() => {
    console.log = realLog;
    console.warn = realWarn;
  });

  const SEEN = "[kiosk-presence] device seen:";

  test("a device heard for the first time says so once, with no scan open", () => {
    assert.equal(scanning(T0), false);
    recordSeen(dev("pi-1", { os: "Linux", hostname: "lobby-pi" }), T0);
    recordSeen(dev("pi-1", { os: "Linux", hostname: "lobby-pi" }), T0 + 30_000);
    recordSeen(dev("pi-1", { os: "Linux", hostname: "lobby-pi" }), T0 + 60_000);
    assert.deepEqual(lines.filter((l) => l.startsWith(SEEN)), [`${SEEN} pi-1 (Linux) on lobby-pi`]);
  });

  test("a device heard again after it aged out is a new sighting: said, and the page is told", () => {
    // Treated as a refresh it would rejoin the list silently, because nothing a
    // person reads would differ from the record kept for it. Between its 90 s TTL
    // and the sweep that prunes it the record is still there, and anything else
    // being announced in that window tells the page it is gone.
    mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
    try {
      recordSeen(dev("pi-1", { os: "Linux" }), T0);
      recordSeen(dev("pi-2", { os: "Linux" }), T0 + 80_000);
      // A change to a device already listed announces without pruning anything.
      recordSeen(dev("pi-2", { os: "Linux", ip: "192.168.1.60" }), T0 + 95_000);
      assert.deepEqual(frames.at(-1)?.seen.map((d) => d.id), ["pi-2"], "pi-1 had not aged out of the page's list");
      const before = frames.length;
      recordSeen(dev("pi-1", { os: "Linux" }), T0 + 100_000);
      assert.ok(frames.length > before, "the page was not told it was back");
      assert.deepEqual(frames.at(-1)?.seen.map((d) => d.id).sort(), ["pi-1", "pi-2"]);
      assert.equal(lines.filter((l) => l.startsWith(`${SEEN} pi-1`)).length, 2, `lines: ${lines.join(" | ")}`);
    } finally {
      mock.timers.reset();
    }
  });

  test("the list holds MAX_SEEN devices and says once, not per datagram, that it is full", () => {
    for (let i = 0; i < MAX_SEEN; i++) recordSeen(dev(`flood-${i}`), T0);
    assert.equal(seenDevices(T0).length, MAX_SEEN);
    for (let i = 0; i < 50; i++) recordSeen(dev(`over-${i}`), T0 + 1_000);
    assert.equal(seenDevices(T0 + 1_000).length, MAX_SEEN, "the list grew past its bound");
    assert.equal(seenDevices(T0 + 1_000).some((d) => d.id.startsWith("over-")), false);
    assert.equal(warnings.length, 1, `warned ${warnings.length} times: ${warnings.join(" | ")}`);
    assert.match(warnings[0], /^\[kiosk-presence\] 256 devices are already listed/);
  });

  test("a device already listed is still refreshed when the list is full", () => {
    for (let i = 0; i < MAX_SEEN; i++) recordSeen(dev(`flood-${i}`), T0);
    recordSeen(dev("flood-0", { ip: "192.168.1.99" }), T0 + 1_000);
    assert.equal(seenDevices(T0 + 1_000).find((d) => d.id === "flood-0")?.ip, "192.168.1.99");
  });

  test("the full warning is said again the next time the list fills, not once per process", () => {
    const fill = (prefix: string, at: number, n: number) => {
      for (let i = 0; i < n; i++) recordSeen(dev(`${prefix}-${i}`), at);
    };
    fill("a", T0, MAX_SEEN);
    recordSeen(dev("over-1"), T0 + 1_000); // full: the first warning
    // Everything ages out, one new device finds room, and the list fills again.
    recordSeen(dev("late"), T0 + 100_000);
    fill("b", T0 + 100_000, MAX_SEEN - 1);
    assert.equal(seenDevices(T0 + 100_000).length, MAX_SEEN);
    recordSeen(dev("over-2"), T0 + 101_000); // full again: the second
    recordSeen(dev("over-3"), T0 + 101_000); // but not a third
    assert.equal(warnings.length, 2, `${warnings.length} warnings: ${warnings.join(" | ")}`);
  });

  test("room returns as devices age out", () => {
    for (let i = 0; i < MAX_SEEN; i++) recordSeen(dev(`flood-${i}`), T0);
    recordSeen(dev("late"), T0 + 100_000);
    assert.deepEqual(seenDevices(T0 + 100_000).map((d) => d.id), ["late"], "an aged-out device still held a place");
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
    recordSeen(dev("d2", { ip: "192.168.1.59" }), now());
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

  test("an output's modes arriving or changing reach them", () => {
    // The helper announces an output before its card has reported modes, then
    // again with them. The row names the kind and mode, so the second probe is a
    // change a person reads, not a heartbeat.
    const out = { kind: "decklink" as const, name: "SDI 1", port: "SDI 1" };
    recordSeen(dev("d6", { output: out }), now());
    const before = frames();
    recordSeen(dev("d6", { output: { ...out, modes: ["1080p59.94"] } }), now());
    assert.equal(frames(), before + 1, "a port reporting its modes never left the server");
    recordSeen(dev("d6", { output: { ...out, modes: ["1080p59.94"] } }), now());
    assert.equal(frames(), before + 1, "an identical output broadcast anyway");
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

// What an output helper reports about itself. Runtime, like the rest of this
// module: nothing is written, and a reading that stops being refreshed stops
// being shown.
describe("output health", () => {
  const report = (over: Record<string, number> = {}) => ({ fps: 59.94, repeated: 0.2, dropped: 0, at: 1, ...over });
  const lines: string[] = [];
  const realLog = console.log;
  beforeEach(() => {
    lines.length = 0;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
  });
  const quiet = () => {
    console.log = realLog;
  };

  test("a healthy output reporting for a long time logs nothing", () => {
    try {
      for (let i = 0; i < 30; i++) recordHealth("mac1.sdi-1", report(), "decklink", 1_000_000 + i * 10_000);
    } finally {
      quiet();
    }
    assert.deepEqual(lines, [], "every report was logged");
  });

  test("a sustained drop is logged once when it starts and once when it ends", () => {
    const t0 = 1_000_000;
    try {
      let n = 0;
      for (const dropped of [0, 4, 9, 15, 15, 15, 15]) recordHealth("mac1.sdi-1", report({ dropped }), "decklink", t0 + n++ * 10_000);
    } finally {
      quiet();
    }
    assert.equal(lines.length, 2, lines.join("\n"));
    assert.match(lines[0], /^\[output-helper\] mac1\.sdi-1 is struggling: 15 frames dropped so far/);
    assert.match(lines[1], /^\[output-helper\] mac1\.sdi-1 has recovered/);
  });

  test("a display output is never struggling: its figures come from a display link that sleeps", () => {
    // A display asleep or a screen locked reports 0 fps, and its dropped count
    // has no card behind it. The same run that marks a DeckLink port struggling
    // must leave it alone.
    try {
      let n = 0;
      for (const dropped of [0, 4, 9, 15]) {
        recordHealth("mac1.hdmi-1", report({ fps: 0, repeated: 30, dropped }), "display", 1_000_000 + n++ * 10_000);
      }
    } finally {
      quiet();
    }
    assert.deepEqual(lines, [], "a display output was logged as struggling");
    assert.equal(healthList(1_000_000 + 40_000)[0].struggling, false);
  });

  test("a reading is shown while it is fresh and not after", () => {
    const t0 = 1_000_000;
    recordHealth("mac1.sdi-1", report(), "decklink", t0);
    assert.deepEqual(healthList(t0 + HEALTH_TTL_MS - 1).map((h) => h.deviceId), ["mac1.sdi-1"]);
    assert.deepEqual(healthList(t0 + HEALTH_TTL_MS + 1), [], "a reading that stopped being refreshed stayed on the page");
  });

  test("forgetting a device takes its reading away", () => {
    recordHealth("mac1.sdi-1", report(), "decklink");
    forgetHealth("mac1.sdi-1");
    assert.deepEqual(healthList(), []);
  });

  test("readings come back in id order", () => {
    for (const id of ["mac1.sdi-2", "mac1.hdmi-1", "mac1.sdi-1"]) recordHealth(id, report(), "decklink");
    assert.deepEqual(healthList().map((h) => h.deviceId), ["mac1.hdmi-1", "mac1.sdi-1", "mac1.sdi-2"]);
  });

  test("an output that stops reporting is dropped by the sweep, said so, and Screens is told", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
    const sentHere: unknown[] = [];
    addBroadcastListener((channel, payload) => {
      if (channel === "kiosk:devices") sentHere.push(payload);
    });
    try {
      recordHealth("mac1.sdi-1", report(), "decklink");
      const before = sentHere.length;
      mock.timers.tick(HEALTH_TTL_MS + 30_000);
      assert.equal(healthList().length, 0);
      assert.ok(sentHere.length > before, "the page was never told the reading went");
      assert.ok(
        lines.some((l) => l === "[output-helper] mac1.sdi-1 stopped reporting health"),
        `no line said it stopped: ${lines.join(" | ")}`,
      );
    } finally {
      quiet();
      mock.timers.reset();
    }
  });
});

// The sweep is one timer for three jobs (expire a scan, drop a reading that went
// quiet, tell the page a device aged out) and stops only when none of them has
// anything left to do. Ticked ONE 15 s STEP AT A TIME: a single tick across the
// whole span ran green against a sweep that stopped at its first step.
describe("the sweep timer", () => {
  const STEP = 15_000;
  const T0 = 1_000_000;
  const lines: string[] = [];
  const realLog = console.log;
  const frames: { seen: unknown[]; health: unknown[] }[] = [];
  let listening = false;

  beforeEach(() => {
    lines.length = 0;
    frames.length = 0;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    if (!listening) {
      listening = true;
      addBroadcastListener((channel, payload) => {
        if (channel === "kiosk:devices") frames.push(payload as (typeof frames)[number]);
      });
    }
    mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
  });
  afterEach(() => {
    console.log = realLog;
    mock.timers.reset();
  });

  const STOPPED = "[output-helper] mac1.sdi-1 stopped reporting health";

  test("keeps running for a reading that has not yet gone quiet, then drops it on the first step past 60 s", () => {
    recordHealth("mac1.sdi-1", { fps: 59.94, repeated: 0.2, dropped: 0, at: 1 }, "decklink");
    const stopped: number[] = [];
    for (let elapsed = STEP; elapsed <= 6 * STEP; elapsed += STEP) {
      mock.timers.tick(STEP);
      if (lines.includes(STOPPED) && stopped.length === 0) stopped.push(elapsed);
    }
    // 60 s is the TTL: the reading is still good at 45 s and gone at 60 s.
    assert.deepEqual(stopped, [4 * STEP], `the reading was not dropped at the step it went quiet:\n${lines.join("\n")}`);
    assert.equal(lines.filter((l) => l === STOPPED).length, 1);
  });

  test("keeps running for a device that is heard and not yet aged out, then tells the page at the first step past 90 s", () => {
    recordSeen(dev("d1"), T0);
    const announcedAt: number[] = [];
    for (let elapsed = STEP; elapsed <= 8 * STEP; elapsed += STEP) {
      const n = frames.length;
      mock.timers.tick(STEP);
      if (frames.length > n && (frames.at(-1)!.seen as unknown[]).length === 0) announcedAt.push(elapsed);
    }
    // lastSeen is T0, a device is kept while it is no more than 90 s old, so it
    // is still listed at the 90 s step and gone from the 105 s one.
    assert.deepEqual(announcedAt, [7 * STEP], "the page was never told the device aged out");
  });

  test("forgets a device that aged out and stops when nothing is left to do, so the next one starts it afresh", () => {
    // seenDevices() already hides an expired device, so the Map's own contents are
    // not visible from outside. What is: the sweep stops itself only when the Map
    // is empty, and a stopped sweep is started again by the next sighting, which
    // is a second setInterval. A sweep that left the expired device in the Map
    // would never stop, and the next sighting would find it still running.
    const real = globalThis.setInterval;
    let started = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      started += 1;
      return real(...args);
    }) as typeof setInterval;
    try {
      recordSeen(dev("d1"), T0);
      assert.equal(started, 1, "the first sighting did not start the sweep");
      for (let elapsed = STEP; elapsed <= 8 * STEP; elapsed += STEP) mock.timers.tick(STEP);
      assert.deepEqual(seenDevices(Date.now()).map((d) => d.id), []);
      recordSeen(dev("d2"), Date.now());
      assert.equal(started, 2, "the sweep was still running: the expired device was never dropped from its list");
    } finally {
      globalThis.setInterval = real;
    }
  });
});

describe("a device told it is no longer set up here", () => {
  const lines: string[] = [];
  const realLog = console.log;
  beforeEach(() => {
    resetKioskPresence();
    lines.length = 0;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.log = realLog;
  });
  const LINE = "[kiosk-responder] d1 still names this server but is not set up here; told it so";

  test("is logged once however often it is told", () => {
    // An agent older than the reply's claimed field never forgets, and is told at
    // every probe.
    for (let i = 0; i < 5; i++) noteReleased("d1");
    assert.deepEqual(lines, [LINE]);
  });

  test("is logged again after it is set up here and released once more", () => {
    // A claim calls forgetSeen, and so does a probe from a device bound here. A
    // kiosk does not probe while its browser runs, so the claim must reset it.
    noteReleased("d1");
    forgetSeen("d1");
    noteReleased("d1");
    assert.deepEqual(lines, [LINE, LINE]);
  });
});
