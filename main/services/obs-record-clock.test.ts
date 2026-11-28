// The record clock ticks on the CLIENT, so a recording costs no traffic.
//
// THE BUG THIS GUARDS. `GetRecordStatus` was polled once a second for the whole
// length of a recording, purely to refresh a "HH:MM:SS" string, and the service
// broadcast whenever that string changed. A ninety-minute service was ~5,400
// requests to OBS and ~5,400 SSE frames to every connected browser, for a number
// each of those browsers could have worked out for itself. `docs/integrations/
// obs.md` said so out loud.
//
// THIS DRIVES A REAL SOCKET, for the reason obs-close-code.test.ts does: the
// question is not "does the reducer fold correctly" — obs-service.test.ts covers
// that — but "how many requests and how many frames does a running recording
// actually cost", and only the assembled service can answer it. A unit test of
// either half is green while a poll runs.
//
// The two halves of the claim are tested against each other:
//   - with the keepalive parked out of the window, a running recording must cost
//     EXACTLY NOTHING. That is the assertion the old code fails.
//   - with the keepalive inside the window, it must cost something. Otherwise
//     "exactly nothing" would be satisfied by a service that had simply died,
//     and the anchor would never correct its drift from OBS.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-obs-clock-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { obsService } = await import("./obs-service.js");
const { addBroadcastListener } = await import("./broadcaster.js");
const { obsRecordTimecode, recordElapsedMs } = await import("./obs-record-clock.js");
const { FakeObs } = await import("./obs-server-harness.js");

const fake = new FakeObs();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait, bounded, for something the service does asynchronously after a push: how long OBS's
 *  answer takes to arrive and be folded is the machine's load, not a number a case can guess. */
async function until(ready: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Every `obs:status` frame that went out, in order. */
const frames: unknown[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "obs:status") frames.push(payload);
});

/** Only the record reads — the seed also asks for stream and virtual cam. */
const recordReads = () => fake.requests.filter((r) => r === "GetRecordStatus").length;

/**
 * Long enough that a 1 Hz poll could not hide in it.
 *
 * The old code polled every 1000ms, so a window of two and a half seconds sees
 * two or three of them however the timers happen to line up — which is what
 * makes `assert.equal(0)` below a guard rather than a race.
 */
const QUIET_WINDOW_MS = 2500;

/** The keepalive, shadowed. An own accessor shadows the prototype getter, so
 *  startKeepalive() still does exactly what it does in production. */
function setKeepalive(ms: number): void {
  Object.defineProperty(obsService, "anchorKeepaliveMs", { get: () => ms, configurable: true });
}

async function waitForConnected(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (obsService.getLatest().connected) return;
    await sleep(20);
  }
  assert.fail("the service never connected to the stub OBS");
}

/**
 * Start a recording on the stub and let the start settle.
 *
 * The transition itself costs a handful of frames — the fold, then the
 * GetRecordStatus that answers it, and OBS sends STARTING before STARTED — and
 * that is not what any of this is measuring. Every test below counts from AFTER
 * this returns, so what it measures is the steady state: a recording that is
 * simply running.
 */
async function startRecording(durationMs: number): Promise<void> {
  fake.recordStatus = {
    outputActive: true,
    outputPaused: false,
    outputTimecode: "00:12:34.000",
    outputDuration: durationMs,
  };
  fake.pushEvent("RecordStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" });
  // The GetRecordStatus that answers the event has landed: the anchor is OBS's own number.
  await until(() => obsService.getLatest().recordAnchorMs === durationMs, "the start's record status to be folded");
}

before(async () => {
  await fake.listen();
  Object.defineProperty(obsService, "reconnectBaseMs", { get: () => 100, configurable: true });
});

after(async () => {
  obsService.stop();
  await fake.close();
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

beforeEach(() => {
  obsService.stop();
  fake.reset();
  frames.length = 0;
  setKeepalive(60_000);
});

describe("a running recording", () => {
  test("costs no requests and no frames between keepalives", async () => {
    // THE BUG. With the keepalive parked outside the window, a recording that is
    // simply rolling must be silent: the timecode advances on every display from
    // an anchor those displays already hold.
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    await startRecording(754_000);

    const framesAtStart = frames.length;
    const readsAtStart = recordReads();
    // The recording keeps rolling on the stub, as it would in OBS.
    fake.recordStatus = { ...fake.recordStatus, outputDuration: 754_000 + QUIET_WINDOW_MS };
    await sleep(QUIET_WINDOW_MS);

    assert.equal(
      recordReads() - readsAtStart,
      0,
      `asked OBS for the record status ${recordReads() - readsAtStart} time(s) in ${QUIET_WINDOW_MS}ms of a recording that did not change — the timecode is being polled`,
    );
    assert.equal(
      frames.length - framesAtStart,
      0,
      `broadcast ${frames.length - framesAtStart} obs:status frame(s) in ${QUIET_WINDOW_MS}ms of a recording that did not change — every connected browser got each one`,
    );
  });

  test("still re-anchors on the keepalive, which is what makes the silence above meaningful", async () => {
    // The control. Without this, "no frames" would also be true of a service
    // that had stopped talking to OBS entirely, and the anchor would never
    // correct its drift from what OBS actually recorded.
    setKeepalive(300);
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    await startRecording(754_000);

    const framesAtStart = frames.length;
    const readsAtStart = recordReads();
    const t0 = Date.now();
    // Two re-anchors, waited for rather than a fixed 1200 ms hoped to hold them: a loaded
    // machine delays the keepalive, it does not skip it.
    await until(() => recordReads() - readsAtStart >= 2, "the keepalive to re-anchor twice at a 300ms cadence");
    // Let the second answer's frame go out before counting frames against reads.
    await until(() => frames.length - framesAtStart >= 2, "the second re-anchor to be published");
    // A deliberate observation window for the ceiling below, which is an absence (nothing more
    // often than asked); the ceiling is measured against the time actually elapsed, so a slow
    // machine widens it rather than tripping it.
    await sleep(600);
    const elapsed = Date.now() - t0;
    const reads = recordReads() - readsAtStart;
    // The ceiling is a rate: at most one read per cadence, plus the two a timer boundary can add.
    assert.ok(
      reads <= Math.floor(elapsed / 300) + 2,
      `re-anchored ${reads} time(s) in ${elapsed}ms at a 300ms cadence — more often than the keepalive asked for`,
    );
    // Each read is counted when it ARRIVES at the stub and its frame goes out when the answer is
    // folded, so a read still in flight at the count above has no frame yet: wait for it. Every
    // read that read a new duration must end up published.
    await until(() => frames.length - framesAtStart >= reads, `all ${reads} re-anchors to be published`);
    // And no more than were asked for. A frame needs a read to have arrived, so at any instant
    // frames <= reads; read both in the same synchronous step (a newer read may have landed since
    // the count above, which is why this compares against the reads NOW, not `reads`). A re-anchor
    // that published twice breaks it.
    const published = frames.length - framesAtStart;
    const readsNow = recordReads() - readsAtStart;
    assert.ok(published <= readsNow, `${published} frame(s) for ${readsNow} read(s) — a re-anchor published more than once`);
  });

  test("asks OBS nothing at all while it is idle", async () => {
    // The old poll ran on a timer regardless and returned early on the snapshot,
    // which cost nothing on the wire — but the keepalive is a request, so an
    // idle OBS must be skipped before it is sent, not after.
    setKeepalive(300);
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();

    const readsAtStart = recordReads();
    await sleep(1200);

    assert.equal(
      recordReads() - readsAtStart,
      0,
      "asked an idle OBS for the record status; nothing is recording, so there is no anchor to refresh",
    );
  });
});

describe("a paused recording", () => {
  test("holds its published anchor rather than interpolating forward", async () => {
    // THE SECOND BUG. `outputDuration` counts what was RECORDED, and it stops
    // while paused. A clock that read wall time forward through a pause would
    // report minutes that were never written to disk — and a pause left in for
    // the whole of a sermon would have the wall reading an hour long when the
    // file is twenty minutes.
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    await startRecording(300_000);

    fake.recordStatus = { ...fake.recordStatus, outputPaused: true, outputDuration: 300_000 };
    fake.pushEvent("RecordStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_PAUSED" });
    await until(
      () => obsService.getLatest().recordPaused === true && obsService.getLatest().recordAnchorMs === 300_000,
      "the pause to be published with OBS's own duration",
    );

    const snap = obsService.getLatest();
    assert.equal(snap.recordPaused, true, "the pause was not published");
    const at = Date.now();
    assert.equal(
      recordElapsedMs(snap, at),
      recordElapsedMs(snap, at + 600_000),
      "ten minutes of wall clock advanced a paused recording's timecode; OBS recorded none of it",
    );
    assert.equal(recordElapsedMs(snap, at), 300_000, "the paused reading is not what OBS said it had recorded");
  });

  test("costs nothing while it sits there", async () => {
    // A pause is a state, not an event stream. Nothing changes while it is held,
    // so nothing goes out — including the keepalive's own frame, which would
    // otherwise republish an anchor that cannot have moved.
    setKeepalive(300);
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    await startRecording(300_000);
    fake.recordStatus = { ...fake.recordStatus, outputPaused: true, outputDuration: 300_000 };
    fake.pushEvent("RecordStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_PAUSED" });
    await until(
      () => obsService.getLatest().recordPaused === true && obsService.getLatest().recordAnchorMs === 300_000,
      "the pause to be published with OBS's own duration",
    );
    // The pause's own GetRecordStatus answer, and a keepalive after it, may still be out: a
    // frame they cause is the pause settling, not a cost of it sitting there.
    await sleep(400);

    const framesAtStart = frames.length;
    await sleep(1200);

    assert.equal(
      frames.length - framesAtStart,
      0,
      `broadcast ${frames.length - framesAtStart} frame(s) while a paused recording sat still — a paused outputDuration cannot have moved`,
    );
  });

  test("resumes from what OBS says it recorded, not from where the pause started", async () => {
    // A pause held for a while and then released. The fold rolls the anchor to
    // this instant so the pause is not replayed as recorded time, and the
    // GetRecordStatus on the same event replaces the guess with OBS's own
    // number.
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    await startRecording(300_000);
    fake.recordStatus = { ...fake.recordStatus, outputPaused: true };
    fake.pushEvent("RecordStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_PAUSED" });
    await until(
      () => obsService.getLatest().recordPaused === true && obsService.getLatest().recordAnchorMs === 300_000,
      "the pause to be published with OBS's own duration",
    );

    // OBS recorded a further 500ms between the resume and its answer.
    fake.recordStatus = { ...fake.recordStatus, outputPaused: false, outputDuration: 300_500 };
    fake.pushEvent("RecordStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_RESUMED" });
    await until(() => obsService.getLatest().recordAnchorMs === 300_500, "OBS's own resumed duration to be folded");

    const snap = obsService.getLatest();
    assert.equal(snap.recordPaused, false, "the resume was not published");
    assert.equal(snap.recordAnchorMs, 300_500, "the resumed anchor is not what OBS reported");
    const elapsed = recordElapsedMs(snap, Date.now());
    assert.ok(
      elapsed != null && elapsed < 302_000,
      `the timecode read ${String(elapsed)}ms straight after a resume — the pause was replayed as recorded time`,
    );
  });
});

describe("a stopped recording", () => {
  test("drops the anchor and stops asking", async () => {
    setKeepalive(300);
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    await startRecording(754_000);

    fake.recordStatus = { ...fake.recordStatus, outputActive: false };
    fake.pushEvent("RecordStateChanged", { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" });
    await until(() => obsService.getLatest().recordAnchorMs === null, "the stop to drop the anchor");

    assert.equal(obsService.getLatest().recordAnchorMs, null, "a stale anchor survived the stop");
    const readsAtStop = recordReads();
    await sleep(1200);
    assert.equal(
      recordReads() - readsAtStop,
      0,
      "kept asking for the record status after the recording stopped",
    );
  });

  test("OBS repeating a state it has already reported does not put a second frame on the wire", async () => {
    // OBS sends STOPPING and then STOPPED, and the fold returns a fresh object
    // for both. The service compared that object by REFERENCE, which is always
    // a change, so every pair of events was two identical frames.
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    await startRecording(754_000);
    frames.length = 0;

    fake.recordStatus = { ...fake.recordStatus, outputActive: false };
    fake.pushEvent("RecordStateChanged", { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPING" });
    fake.pushEvent("RecordStateChanged", { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" });
    // The first frame has to land before "no second one" means anything; the 200 ms after it is
    // the absence wait and stays.
    await until(() => frames.length >= 1, "the stop's frame");
    await sleep(200);

    assert.equal(
      frames.length,
      1,
      `two events describing the same stopped recording produced ${frames.length} frames`,
    );
  });
});

// ── The formula itself ──────────────────────────────────────────────────────
//
// Pure, so these need no socket. They live in this file rather than one of their
// own because the socket tests above assert the SERVICE publishes an anchor these
// read forward, and splitting the two halves is how a writer and a reader of the
// same number drift apart.

describe("recordElapsedMs", () => {
  const NOW = Date.parse("2026-09-11T15:20:00.000Z");
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
  const rolling = {
    recording: true,
    recordPaused: false,
    recordAnchorMs: 300_000,
    recordSampledAt: at(-20_000),
  };

  test("reads the anchor forward at wall-clock rate", () => {
    assert.equal(recordElapsedMs(rolling, NOW), 320_000);
  });

  test("a recording with no anchor yet is null, not zero", () => {
    // Zero would draw 00:00:00 over a recording that has been rolling for an
    // hour — the same lie the Resi clock was fixed for. Null draws nothing.
    assert.equal(recordElapsedMs({ ...rolling, recordAnchorMs: null }, NOW), null);
  });

  test("nothing recording is null whatever the anchor says", () => {
    assert.equal(recordElapsedMs({ ...rolling, recording: false }, NOW), null);
  });

  test("an unparseable sample time is null rather than NaN", () => {
    assert.equal(recordElapsedMs({ ...rolling, recordSampledAt: "not a date" }, NOW), null);
    assert.equal(recordElapsedMs({ ...rolling, recordSampledAt: null }, NOW), null);
  });

  test("a sample stamped in the future clamps at zero rather than counting backwards", () => {
    // A display whose clock is ahead of the server's. Skew correction is the real
    // answer; this is what the reading does before it arrives.
    assert.equal(recordElapsedMs({ ...rolling, recordAnchorMs: 0, recordSampledAt: at(60_000) }, NOW), 0);
  });
});

describe("obsRecordTimecode", () => {
  const NOW = Date.parse("2026-09-11T15:20:00.000Z");
  const rolling = {
    recording: true,
    recordPaused: false,
    recordAnchorMs: 3_723_000, // 01:02:03
    recordSampledAt: new Date(NOW).toISOString(),
  };

  test("formats as OBS does, minus the milliseconds", () => {
    assert.equal(obsRecordTimecode(rolling, NOW), "01:02:03");
  });

  test("past a day it keeps counting hours rather than wrapping", () => {
    assert.equal(obsRecordTimecode({ ...rolling, recordAnchorMs: 25 * 3_600_000 }, NOW), "25:00:00");
  });

  test("no snapshot at all is null, not a zeroed clock", () => {
    assert.equal(obsRecordTimecode(null, NOW), null);
  });
});
