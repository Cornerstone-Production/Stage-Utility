import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ObsStatusDTO, ReaperStatusDTO } from "@main/types/live";
import { attentionInput, integration } from "../test-input.js";
import { recorderIdle } from "./recorder-idle.js";

const reaper = (over: Partial<ReaperStatusDTO> = {}) =>
  ({ connected: true, recording: false, recordPaused: false, playing: false, positionSeconds: null, positionString: null, ...over }) as ReaperStatusDTO;
const obs = (over: Partial<ObsStatusDTO> = {}) =>
  ({ connected: true, recording: false, recordPaused: false, streaming: false, virtualCam: false, ...over }) as ObsStatusDTO;

const base = { mood: "live" as const, integrations: [integration("reaper"), integration("obs")], integrationLabels: { reaper: "REAPER", obs: "OBS" } };

describe("recorder-idle source", () => {
  it("fires per enabled, connected recorder that is idle while live, with the in-place action", () => {
    const items = recorderIdle.items(attentionInput({ ...base, reaper: reaper(), obs: obs() }));
    assert.deepEqual(items.map((i) => i.key), ["recorder-idle:reaper", "recorder-idle:obs"]);
    assert.equal(items[0].severity, "warn");
    assert.equal(items[0].title, "REAPER is not recording");
    assert.deepEqual(items[0].fix, { label: "Start recording", action: { actionId: "reaper.transport", params: { command: "record" } } });
    assert.deepEqual(items[1].fix.action, { actionId: "obs.record", params: { command: "start" } });
  });

  it("does not fire when recording, when idle (not live), when disabled, or when not connected", () => {
    assert.deepEqual(recorderIdle.items(attentionInput({ ...base, reaper: reaper({ recording: true }), obs: obs({ recording: true }) })), []);
    assert.deepEqual(recorderIdle.items(attentionInput({ ...base, mood: "idle", reaper: reaper(), obs: obs() })), []);
    assert.deepEqual(recorderIdle.items(attentionInput({ ...base, integrations: [integration("reaper", { enabled: false })], reaper: reaper(), obs: null })), []);
    assert.deepEqual(recorderIdle.items(attentionInput({ ...base, reaper: reaper({ connected: false }), obs: obs({ connected: false }) })), []);
  });

  it("unknown contributes nothing: a status that has not answered, or an integration list that has not", () => {
    assert.deepEqual(recorderIdle.items(attentionInput({ ...base, reaper: null, reaperKnown: false, obs: null, obsKnown: false })), []);
    assert.deepEqual(recorderIdle.items(attentionInput({ ...base, integrationsKnown: false, reaper: reaper(), obs: obs() })), []);
  });

  it("each recorder's own known flag counts: OBS unanswered does not silence REAPER, nor the reverse", () => {
    const r = recorderIdle.items(attentionInput({ ...base, reaper: reaper(), reaperKnown: true, obs: obs(), obsKnown: false }));
    assert.deepEqual(r.map((i) => i.key), ["recorder-idle:reaper"]);
    const o = recorderIdle.items(attentionInput({ ...base, reaper: reaper(), reaperKnown: false, obs: obs(), obsKnown: true }));
    assert.deepEqual(o.map((i) => i.key), ["recorder-idle:obs"]);
  });
});
