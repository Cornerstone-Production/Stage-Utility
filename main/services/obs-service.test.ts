// Tests for the pure OBS event→DTO reducer. The mapping is the whole integration:
// everything else is socket plumbing, and a wrong fold here means the "OBS status"
// layout object lies about whether the service is being recorded.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { ObsStatusDTO } from "../types/stage.js";
import { reduceObsEvent } from "./obs-service.js";

const OFFLINE: ObsStatusDTO = {
  connected: false,
  recording: false,
  recordPaused: false,
  streaming: false,
  virtualCam: false,
  recordTimecode: null,
};

const evt = (eventType: string, eventData: Record<string, unknown> = {}) => ({ eventType, eventData });

describe("reduceObsEvent", () => {
  test("RecordStateChanged active starts recording", () => {
    const next = reduceObsEvent(OFFLINE, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_STARTED" }));
    assert.equal(next.recording, true);
    assert.equal(next.recordPaused, false);
  });

  test("RecordStateChanged inactive stops recording and clears the timecode", () => {
    const recording = { ...OFFLINE, recording: true, recordTimecode: "00:12:34" };
    const next = reduceObsEvent(recording, evt("RecordStateChanged", { outputActive: false, outputState: "OUTPUT_STOPPED" }));
    assert.equal(next.recording, false);
    assert.equal(next.recordTimecode, null, "a stale timecode must not survive the stop");
  });

  test("a paused recording is still a recording", () => {
    // Documented intent: OBS still has a recording in progress while paused, so
    // the red indicator must stay lit.
    const next = reduceObsEvent(OFFLINE, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_PAUSED" }));
    assert.equal(next.recording, true);
    assert.equal(next.recordPaused, true);
  });

  test("pausing preserves the running timecode", () => {
    const recording = { ...OFFLINE, recording: true, recordTimecode: "00:05:00" };
    const next = reduceObsEvent(recording, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_PAUSED" }));
    assert.equal(next.recordTimecode, "00:05:00");
  });

  test("resuming clears the paused flag", () => {
    const paused = { ...OFFLINE, recording: true, recordPaused: true };
    const next = reduceObsEvent(paused, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_RESUMED" }));
    assert.equal(next.recordPaused, false);
  });

  test("a missing outputState is treated as not-paused rather than throwing", () => {
    const next = reduceObsEvent(OFFLINE, evt("RecordStateChanged", { outputActive: true }));
    assert.equal(next.recording, true);
    assert.equal(next.recordPaused, false);
  });

  test("outputActive is compared strictly, so truthy junk does not start a recording", () => {
    const next = reduceObsEvent(OFFLINE, evt("RecordStateChanged", { outputActive: "true" }));
    assert.equal(next.recording, false);
  });

  test("StreamStateChanged toggles only streaming", () => {
    const next = reduceObsEvent(OFFLINE, evt("StreamStateChanged", { outputActive: true }));
    assert.equal(next.streaming, true);
    assert.equal(next.recording, false, "streaming must not imply recording");
  });

  test("VirtualcamStateChanged toggles only the virtual camera", () => {
    const next = reduceObsEvent(OFFLINE, evt("VirtualcamStateChanged", { outputActive: true }));
    assert.equal(next.virtualCam, true);
    assert.equal(next.recording, false);
  });

  test("an unknown event returns the previous snapshot unchanged", () => {
    const prev = { ...OFFLINE, recording: true };
    assert.equal(reduceObsEvent(prev, evt("SceneItemEnableStateChanged")), prev);
  });

  test("the reducer does not mutate its input", () => {
    const prev = { ...OFFLINE };
    reduceObsEvent(prev, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_STARTED" }));
    assert.deepEqual(prev, OFFLINE);
  });

  test("independent outputs accumulate across a sequence", () => {
    let s = OFFLINE;
    s = reduceObsEvent(s, evt("StreamStateChanged", { outputActive: true }));
    s = reduceObsEvent(s, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_STARTED" }));
    s = reduceObsEvent(s, evt("VirtualcamStateChanged", { outputActive: true }));
    assert.deepEqual(
      { recording: s.recording, streaming: s.streaming, virtualCam: s.virtualCam },
      { recording: true, streaming: true, virtualCam: true },
    );
  });
});
