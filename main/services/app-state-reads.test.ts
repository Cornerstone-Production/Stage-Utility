// What each `app:` source answers, read straight off its integration's snapshot.
//
// The mapping IS the feature: a cue pair bound to `app:obs.recording` is a
// switch in somebody's house, and a reader that folds "cannot reach OBS" into
// "off" is that switch saying the service is not being recorded when the truth
// is that nobody knows. Both halves of every source are asserted — the value it
// reports, and the refusal to report one at all.
//
// The only stubs are the services' own snapshots. Nothing here contacts OBS or
// REAPER, and nothing here may: there is a real OBS on this LAN.
//
// cue-states-app-source.test.ts drives the same seam end to end through
// cue-states; this file is the per-source mapping underneath it.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-app-state-reads-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { APP_STATE_SOURCE_IDS } = await import("./app-state-sources.js");
const { readAppState } = await import("./app-state-reads.js");
const { obsService } = await import("./obs-service.js");
const { reaperService } = await import("./reaper-service.js");

type ObsStatus = ReturnType<typeof obsService.getLatest>;
type ReaperStatus = ReturnType<typeof reaperService.getLatest>;

const OBS_OFFLINE: ObsStatus = {
  connected: false,
  recording: false,
  recordPaused: false,
  streaming: false,
  virtualCam: false,
  recordAnchorMs: null,
  recordSampledAt: null,
};

const REAPER_OFFLINE: ReaperStatus = {
  connected: false,
  recording: false,
  recordPaused: false,
  playing: false,
  positionSeconds: null,
  positionString: null,
};

function obs(patch: Partial<ObsStatus>): void {
  obsService.getLatest = () => ({ ...OBS_OFFLINE, connected: true, ...patch });
}

beforeEach(() => {
  obsService.getLatest = () => OBS_OFFLINE;
  reaperService.getLatest = () => REAPER_OFFLINE;
});

describe("app:obs.recording", () => {
  test("reads on while OBS is recording", () => {
    obs({ recording: true });
    assert.deepEqual(readAppState("app:obs.recording"), { value: "on" });
  });

  test("reads off while OBS is connected and idle", () => {
    obs({ recording: false });
    assert.deepEqual(readAppState("app:obs.recording"), { value: "off" });
  });

  test("a paused recording is still on", () => {
    // OBS still has a recording in progress while paused; a switch that flipped
    // off on a pause would be telling the room the service stopped recording.
    obs({ recording: true, recordPaused: true });
    assert.deepEqual(readAppState("app:obs.recording"), { value: "on" });
  });

  test("an OBS nobody can reach is unreadable, not off", () => {
    obsService.getLatest = () => OBS_OFFLINE;
    assert.deepEqual(readAppState("app:obs.recording"), { error: "OBS is not connected" });
  });

  test("streaming does not move the recording reading", () => {
    // The two sources share one snapshot and one channel. Reading the wrong
    // field would be a recording indicator that lights up on a stream.
    obs({ recording: false, streaming: true });
    assert.deepEqual(readAppState("app:obs.recording"), { value: "off" });
  });
});

describe("app:obs.streaming", () => {
  test("reads on while OBS is streaming", () => {
    obs({ streaming: true });
    assert.deepEqual(readAppState("app:obs.streaming"), { value: "on" });
  });

  test("reads off while OBS is connected and not streaming", () => {
    obs({ streaming: false });
    assert.deepEqual(readAppState("app:obs.streaming"), { value: "off" });
  });

  test("recording does not move the streaming reading", () => {
    obs({ recording: true, streaming: false });
    assert.deepEqual(readAppState("app:obs.streaming"), { value: "off" });
  });

  test("an OBS nobody can reach is unreadable, not off", () => {
    obsService.getLatest = () => OBS_OFFLINE;
    assert.deepEqual(readAppState("app:obs.streaming"), { error: "OBS is not connected" });
  });
});

describe("app:reaper.recording", () => {
  test("reads on while REAPER is recording", () => {
    reaperService.getLatest = () => ({ ...REAPER_OFFLINE, connected: true, recording: true });
    assert.deepEqual(readAppState("app:reaper.recording"), { value: "on" });
  });

  test("an unreachable REAPER is unreadable, not off", () => {
    assert.deepEqual(readAppState("app:reaper.recording"), { error: "REAPER is not connected" });
  });
});

describe("the registry and the readers", () => {
  test("every shipped source answers, and nothing else does", () => {
    // EXACT, over the union rather than a list written here: a fourth source
    // added without a reader does not compile, and one added without reaching
    // this file would still be read here. `obs` is connected, so no source may
    // answer with an error.
    obs({});
    reaperService.getLatest = () => ({ ...REAPER_OFFLINE, connected: true });
    assert.equal(APP_STATE_SOURCE_IDS.length, 3);
    for (const id of APP_STATE_SOURCE_IDS) {
      const answer = readAppState(`app:${id}`);
      assert.equal("value" in answer, true, `app:${id} answered with no value`);
    }
  });

  test("a ref nothing answers to is named, not guessed at", () => {
    assert.deepEqual(readAppState("app:obs.virtualcam"), {
      error: 'no Stage Utility state source called "app:obs.virtualcam"',
    });
  });
});
