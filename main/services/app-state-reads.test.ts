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
const { resiService } = await import("./resi-service.js");
const { youtubeService } = await import("./youtube-service.js");
const { implicitStateBinding } = await import("./cue-pairs.js");
const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");

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

const YOUTUBE_OFFLINE: ReturnType<typeof youtubeService.getLatest> = {
  connected: false,
  live: false,
  startedAt: null,
  detail: null,
  viewers: null,
  scheduledStartAt: null,
};

const RESI_OFFLINE: ReturnType<typeof resiService.getLatest> = {
  connected: false,
  live: false,
  startedAt: null,
  detail: null,
};

function obs(patch: Partial<ObsStatus>): void {
  obsService.getLatest = () => ({ ...OBS_OFFLINE, connected: true, ...patch });
}

beforeEach(() => {
  obsService.getLatest = () => OBS_OFFLINE;
  reaperService.getLatest = () => REAPER_OFFLINE;
  youtubeService.getLatest = () => YOUTUBE_OFFLINE;
  resiService.getLatest = () => RESI_OFFLINE;
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

describe("app:obs.virtualCam", () => {
  test("reads on while OBS's virtual camera is running", () => {
    obs({ virtualCam: true });
    assert.deepEqual(readAppState("app:obs.virtualCam"), { value: "on" });
  });

  test("reads off while OBS is connected and the virtual camera is stopped", () => {
    obs({ virtualCam: false });
    assert.deepEqual(readAppState("app:obs.virtualCam"), { value: "off" });
  });

  test("recording and streaming do not move the virtual camera reading", () => {
    // Three sources now share one snapshot and one channel. The virtual camera
    // is the one an operator is least likely to be watching, so a reader that
    // picked up `recording` would report a camera nothing is publishing.
    obs({ recording: true, streaming: true, virtualCam: false });
    assert.deepEqual(readAppState("app:obs.virtualCam"), { value: "off" });
  });

  test("the virtual camera does not move the recording reading", () => {
    obs({ virtualCam: true, recording: false });
    assert.deepEqual(readAppState("app:obs.recording"), { value: "off" });
  });

  test("an OBS nobody can reach is unreadable, not off", () => {
    obsService.getLatest = () => OBS_OFFLINE;
    assert.deepEqual(readAppState("app:obs.virtualCam"), { error: "OBS is not connected" });
  });
});

describe("app:youtube.live and app:resi.live", () => {
  test("YouTube reads on while it is broadcasting", () => {
    youtubeService.getLatest = () => ({ ...YOUTUBE_OFFLINE, connected: true, live: true });
    assert.deepEqual(readAppState("app:youtube.live"), { value: "on" });
  });

  test("YouTube reads off while connected and not broadcasting", () => {
    youtubeService.getLatest = () => ({ ...YOUTUBE_OFFLINE, connected: true, live: false });
    assert.deepEqual(readAppState("app:youtube.live"), { value: "off" });
  });

  test("a YouTube nobody can reach is unreadable, not off", () => {
    // `connected` is the link to YouTube's API and `live` is whether it is on
    // air. Folding the first into the second would be a light saying the service
    // is not being streamed during the one part of the morning somebody acts on
    // it — and `live` is false on an OFFLINE snapshot, so this is the default
    // the reader has to override rather than a case it has to invent.
    youtubeService.getLatest = () => YOUTUBE_OFFLINE;
    assert.deepEqual(readAppState("app:youtube.live"), { error: "YouTube is not connected" });
  });

  test("Resi reads on while it is broadcasting", () => {
    resiService.getLatest = () => ({ ...RESI_OFFLINE, connected: true, live: true });
    assert.deepEqual(readAppState("app:resi.live"), { value: "on" });
  });

  test("a Resi nobody can reach is unreadable, not off", () => {
    resiService.getLatest = () => RESI_OFFLINE;
    assert.deepEqual(readAppState("app:resi.live"), { error: "Resi is not connected" });
  });

  test("the two platforms are not crossed", () => {
    // Two near-identical readers over two services publishing the SAME shape.
    // One reading the other's snapshot is a switch naming the wrong platform,
    // and every other assertion in this file would still pass.
    youtubeService.getLatest = () => ({ ...YOUTUBE_OFFLINE, connected: true, live: true });
    resiService.getLatest = () => ({ ...RESI_OFFLINE, connected: true, live: false });
    assert.deepEqual(readAppState("app:youtube.live"), { value: "on" });
    assert.deepEqual(readAppState("app:resi.live"), { value: "off" });
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
    // EXACT, over the union rather than a list written here: a seventh source
    // added without a reader does not compile, and one added without reaching
    // this file would still be read here. Every integration is connected, so no
    // source may answer with an error.
    obs({});
    reaperService.getLatest = () => ({ ...REAPER_OFFLINE, connected: true });
    youtubeService.getLatest = () => ({ ...YOUTUBE_OFFLINE, connected: true });
    resiService.getLatest = () => ({ ...RESI_OFFLINE, connected: true });
    assert.equal(APP_STATE_SOURCE_IDS.length, 6);
    for (const id of APP_STATE_SOURCE_IDS) {
      const answer = readAppState(`app:${id}`);
      assert.equal("value" in answer, true, `app:${id} answered with no value`);
    }
  });

  test("exactly four sources are implied by an action, and the platforms are not among them", () => {
    // `app:youtube.live` and `app:resi.live` are the first sources with NO
    // action behind them — Stage Utility cannot start a broadcast on either, so
    // a pair reading one is bound by hand. Nothing requires a source to have an
    // implied row, and this asserts the other direction too: the implied set is
    // EXACT, so a row copied from the one above it and pointed at a platform
    // would claim a state no cue here ever causes, and every other assertion in
    // this file would still pass.
    //
    // Driven through the REAL registry and the REAL binding function rather
    // than reading IMPLIED_SOURCES, which is not exported: every action is
    // offered every command any action uses.
    const commands = ["start", "stop", "record", "play", "on", "off", ""];
    const implied = new Set<string>();
    for (const id of Object.keys(AUTOMATION_ACTIONS)) {
      for (const command of commands) {
        const binding = implicitStateBinding({ id, params: { command } });
        if (binding) implied.add(binding.variable);
      }
    }
    assert.deepEqual(
      [...implied].sort(),
      ["app:obs.recording", "app:obs.streaming", "app:obs.virtualCam", "app:reaper.recording"],
    );
  });

  test("a ref nothing answers to is named, not guessed at", () => {
    // `virtualcam` with a small c. `app:obs.virtualCam` IS a source now, so this
    // is also the case-sensitivity question: the lookup is an exact Map hit, and
    // a ref that differs only in case is a typo, not a near miss to be helped
    // along into somebody's house reporting a camera it never read.
    assert.deepEqual(readAppState("app:obs.virtualcam"), {
      error: 'no Stage Utility state source called "app:obs.virtualcam"',
    });
  });
});
