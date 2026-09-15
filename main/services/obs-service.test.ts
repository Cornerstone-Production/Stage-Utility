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
  recordAnchorMs: null,
  recordSampledAt: null,
};

/** A fixed moment, so a rolled-forward anchor is an exact number. */
const NOW = Date.parse("2026-09-11T15:20:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const evt = (eventType: string, eventData: Record<string, unknown> = {}) => ({ eventType, eventData });

describe("reduceObsEvent", () => {
  test("RecordStateChanged active starts recording", () => {
    const next = reduceObsEvent(OFFLINE, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_STARTED" }));
    assert.equal(next.recording, true);
    assert.equal(next.recordPaused, false);
  });

  test("RecordStateChanged inactive stops recording and clears the anchor", () => {
    const recording = { ...OFFLINE, recording: true, recordAnchorMs: 754_000, recordSampledAt: at(0) };
    const next = reduceObsEvent(recording, evt("RecordStateChanged", { outputActive: false, outputState: "OUTPUT_STOPPED" }), NOW);
    assert.equal(next.recording, false);
    assert.equal(next.recordAnchorMs, null, "a stale anchor must not survive the stop");
    assert.equal(next.recordSampledAt, null, "a stale anchor must not survive the stop");
  });

  test("a paused recording is still a recording", () => {
    // Documented intent: OBS still has a recording in progress while paused, so
    // the red indicator must stay lit.
    const next = reduceObsEvent(OFFLINE, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_PAUSED" }));
    assert.equal(next.recording, true);
    assert.equal(next.recordPaused, true);
  });

  test("pausing freezes the clock at the time actually recorded, not at the last anchor", () => {
    // The anchor was taken 20s ago and the recording has been rolling since, so
    // a pause has to bank those 20 seconds. Leaving the old anchor in place made
    // the frozen reading jump BACKWARDS by up to a whole keepalive.
    const recording = { ...OFFLINE, recording: true, recordAnchorMs: 300_000, recordSampledAt: at(-20_000) };
    const next = reduceObsEvent(recording, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_PAUSED" }), NOW);
    assert.equal(next.recordPaused, true);
    assert.equal(next.recordAnchorMs, 320_000, "the pause lost the seconds since the last anchor");
    assert.equal(next.recordSampledAt, at(0));
  });

  test("resuming restarts the clock from this instant, so the pause is not replayed as recording", () => {
    // A recording paused at 5:00 and left there for ten minutes. The service
    // re-reads outputDuration on this same event, but that is a round trip away,
    // and an untouched anchor would count the whole pause in the meantime.
    const paused = { ...OFFLINE, recording: true, recordPaused: true, recordAnchorMs: 300_000, recordSampledAt: at(-600_000) };
    const next = reduceObsEvent(paused, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_RESUMED" }), NOW);
    assert.equal(next.recordPaused, false);
    assert.equal(next.recordAnchorMs, 300_000, "ten minutes of pause were counted as recorded time");
    assert.equal(next.recordSampledAt, at(0));
  });

  test("a start with no anchor yet stays null rather than claiming 00:00:00", () => {
    // The GetRecordStatus that answers this event has not come back. Null is the
    // honest reading; 0 would be a clock that happens to be right.
    const next = reduceObsEvent(OFFLINE, evt("RecordStateChanged", { outputActive: true, outputState: "OUTPUT_STARTED" }), NOW);
    assert.equal(next.recording, true);
    assert.equal(next.recordAnchorMs, null);
    assert.equal(next.recordSampledAt, null);
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
