// The people-count poll gate has to count the consumers it cannot see.
//
// SenSource slows to once a minute when "nobody is watching", and asked only
// channelHasSubscribers — a question about browsers. Two consumers live inside
// this process and are invisible to it: the attendance recorder pulls
// getLatest() on every live tick, and tslService pushes counts to a scoreboard.
//
// So on a Sunday with no people-count display open, the recorder sampled counts
// up to a minute stale for the whole service. The trend graph drew the shape of
// the poll gate rather than of the room, and nothing anywhere reported a fault.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-demand-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

// Imported for the side effect that matters: each registers itself as a demand
// source at module load. If that registration is ever dropped, these fail.
const { attendanceRecorder } = await import("./attendance-recorder.js");
const { tslService } = await import("./tsl-service.js");
const { sensourceService } = await import("./sensource-service.js");
const { setSubscriberCheck } = await import("./broadcaster.js");

// channelHasSubscribers answers TRUE until the server registers a real check —
// fail-open, so nothing is throttled during boot. These cases are about the
// other half of the gate, so pin the browser side to "nobody watching".
let browsersWatching = false;
setSubscriberCheck(() => browsersWatching);

type Gate = { demandSources: (() => boolean)[]; inDemand: boolean };
const gate = sensourceService as unknown as Gate;

type Recorder = { current: { endedAt: string | null } | null; postMs: number };
const recorder = attendanceRecorder as unknown as Recorder;

type Tsl = { connected: boolean; feeds: unknown[] };
const tsl = tslService as unknown as Tsl;

describe("SenSource poll demand", () => {
  beforeEach(() => {
    browsersWatching = false;
    recorder.current = null;
    recorder.postMs = 60 * 60_000;
    tsl.connected = false;
    tsl.feeds = [];
  });

  it("still polls fast for a browser, which is what it always did", () => {
    browsersWatching = true;
    assert.equal(gate.inDemand, true, "the subscriber path must survive the change");
  });

  it("registers both in-process consumers", () => {
    // A count, not a floor: if a third consumer of getLatest() is added without
    // registering, that is the same bug again and this is where it surfaces.
    assert.equal(
      gate.demandSources.length,
      2,
      "expected the attendance recorder and tslService to register as consumers",
    );
  });

  it("is idle when nothing at all is consuming", () => {
    assert.equal(gate.inDemand, false);
  });

  it("counts an open attendance record as demand", () => {
    // THE bug: mid-service, no browser open. This used to read false and the
    // poll dropped to the 60s idle cadence for the whole service.
    recorder.current = { endedAt: null };
    assert.equal(gate.inDemand, true, "a service is being recorded and the counts went stale");
  });

  it("keeps counting through the post-service taper", () => {
    // The record has an end but the room is still emptying — the taper samples
    // for another hour, and those samples matter as much as the service's.
    recorder.current = { endedAt: new Date(Date.now() - 10 * 60_000).toISOString() };
    assert.equal(gate.inDemand, true);
  });

  it("goes idle once the taper window has passed", () => {
    recorder.current = { endedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() };
    assert.equal(gate.inDemand, false, "an ended service must not hold the fast cadence open");
  });

  it("counts a connected scoreboard as demand", () => {
    tsl.connected = true;
    tsl.feeds = [{}];
    assert.equal(gate.inDemand, true);
  });

  it("does not count a scoreboard that is connected but fed nothing", () => {
    tsl.connected = true;
    tsl.feeds = [];
    assert.equal(gate.inDemand, false);
  });
});
