// The two recorders, and the promise that adding the second one did not change
// what the first one meant.
//
// `recording.started` / `recording.stopped` were labelled "Recording starts" and
// "Recording stops" while bound to `obs:status` alone. Every rule an operator
// has already saved names those ids, and the whole point of naming REAPER's pair
// separately is that those saved rules go on doing exactly what they did.
//
// Drives the REAL engine through its real broadcast dispatch, not the pure
// registry: the thing that could silently change meaning is which CHANNEL a
// saved rule listens to, and didFire cannot see a channel.

import assert from "node:assert/strict";
import { describe, test, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-recorder-triggers-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { automationEngine } = await import("./automation-engine.js");
const { automationLog } = await import("./automation-log.js");
const { AUTOMATION_TRIGGERS } = await import("./automation-triggers.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-11T15:00:00Z");

/** An OBS snapshot, as obs-service publishes it. */
const obs = (recording: boolean, connected = true) => ({
  connected, recording, recordPaused: false, streaming: false, virtualCam: false, recordTimecode: null,
});

/** A REAPER snapshot, as reaper-service publishes it. A DIFFERENT shape from
 *  OBS's — no streaming or virtual camera, and a position rather than a
 *  timecode — which is why each pair reads its own channel. */
const reaper = (recording: boolean, connected = true) => ({
  connected, recording, recordPaused: false, playing: false,
  positionSeconds: recording ? 12 : null, positionString: recording ? "0:12.000" : null,
});

/** One enabled rule on `triggerId`, nothing else in the store. */
async function onlyRule(triggerId: string): Promise<void> {
  for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
  await automationLog.clear();
  await automationEngine.addRule({
    name: `test ${triggerId}`,
    enabled: true,
    trigger: { id: triggerId, params: {} },
    conditions: [],
    action: { id: "log.message", params: { message: "fired" } },
    cooldownSec: 0,
    oncePerService: false,
  });
}

const fires = () =>
  automationLog.list().filter((e) => e.outcome === "fired" || e.outcome === "simulated").length;

/** Seed the channel (the first snapshot is never evaluated), then push the edge. */
async function edge(channel: string, before: unknown, afterSnap: unknown): Promise<void> {
  await automationEngine.__handleBroadcast(channel, before, NOW);
  await automationEngine.__handleBroadcast(channel, afterSnap, NOW + 1000);
}

describe("recorder triggers", () => {
  beforeEach(async () => {
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: true, disarmed: false });
  });

  test("a saved OBS recording rule still fires on obs:status", async () => {
    await onlyRule("recording.started");
    await edge("obs:status", obs(false), obs(true));
    assert.equal(fires(), 1, "recording.started must go on meaning what it meant: OBS began recording");
  });

  test("a saved OBS recording rule is NOT fired by REAPER", async () => {
    // THE MEANING GUARD. Every rule already on disk carrying `recording.started`
    // was written when the trigger could only see OBS. Widening it — a `source`
    // param defaulting to "any", or re-pointing the channel — would make those
    // rules start firing on a machine their author never chose.
    await onlyRule("recording.started");
    await edge("reaper:status", reaper(false), reaper(true));
    assert.equal(fires(), 0, "an existing OBS recording rule must not fire because REAPER rolled");
  });

  test("a REAPER recording rule fires when REAPER starts recording", async () => {
    await onlyRule("reaper.recording-started");
    await edge("reaper:status", reaper(false), reaper(true));
    assert.equal(fires(), 1, "reaper.recording-started did not fire on REAPER's own transport edge");
  });

  test("a REAPER recording rule fires when REAPER stops recording", async () => {
    await onlyRule("reaper.recording-stopped");
    await edge("reaper:status", reaper(true), reaper(false));
    assert.equal(fires(), 1);
  });

  test("a REAPER recording rule is not fired by OBS", async () => {
    await onlyRule("reaper.recording-started");
    await edge("obs:status", obs(false), obs(true));
    assert.equal(fires(), 0);
  });

  test("REAPER dropping off the network is not 'stopped recording'", async () => {
    // reaper-service publishes OFFLINE — connected:false, recording:false — the
    // moment a poll fails. That is unknown, not an edge.
    await onlyRule("reaper.recording-stopped");
    await edge("reaper:status", reaper(true), reaper(false, false));
    assert.equal(fires(), 0, "an unreachable REAPER must not fire a stop rule");
  });

  test("REAPER's position ticking while recording does not re-fire", async () => {
    // reaper-service overrides `changed` to broadcast EVERY poll while recording
    // so a timecode display advances, so this channel re-sends a rolling
    // recording once a second. A level rather than an edge would fire 60 times a
    // minute, unattended.
    await onlyRule("reaper.recording-started");
    await automationEngine.__handleBroadcast("reaper:status", reaper(false), NOW);
    await automationEngine.__handleBroadcast("reaper:status", reaper(true), NOW + 1000);
    for (let i = 2; i < 8; i++) {
      await automationEngine.__handleBroadcast(
        "reaper:status",
        { ...reaper(true), positionSeconds: 12 + i, positionString: `0:${12 + i}.000` },
        NOW + i * 1000,
      );
    }
    assert.equal(fires(), 1, "the recording edge is one event, however many ticks follow it");
  });

  test("an enabled REAPER recording rule puts reaper:status in demand", async () => {
    // reaper-service polls at IDLE_POLL_MS with no browser watching, which is
    // the unattended booth this rule exists for.
    for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
    assert.equal(automationEngine.wantsChannel("reaper:status"), false, "no rules, no demand");
    await onlyRule("reaper.recording-started");
    assert.equal(automationEngine.wantsChannel("reaper:status"), true);
  });
});

describe("the recorder pairs are told apart in the list", () => {
  test("the legacy OBS pair keeps its ids, its channel and its empty params", () => {
    // Ids: a saved rule names its trigger by id and the engine skips an id it
    // does not know, silently. Channel: what the rule listens to.
    // params: []: a rule saved before today holds `params: {}`, so a new
    // REQUIRED param on this pair would be a rule running on a default nobody
    // chose.
    for (const id of ["recording.started", "recording.stopped"]) {
      const t = AUTOMATION_TRIGGERS[id];
      assert.ok(t, `${id} has gone from the registry — every saved recording rule is now dead`);
      assert.equal(t.channel, "obs:status", `${id} must still watch OBS alone`);
      assert.deepEqual(t.params, [], `${id} gained a param a saved rule cannot supply`);
    }
  });

  test("REAPER's pair watches reaper:status and carries no params either", () => {
    for (const id of ["reaper.recording-started", "reaper.recording-stopped"]) {
      const t = AUTOMATION_TRIGGERS[id];
      assert.ok(t, `${id} is missing — REAPER recording cannot be a trigger`);
      assert.equal(t.channel, "reaper:status");
      assert.deepEqual(t.params, []);
    }
  });

  test("every recording trigger names its machine", () => {
    // The trigger list is a <select>. "Recording starts" beside "REAPER starts
    // recording" is a choice an operator cannot make, and picking the wrong one
    // is a rule that never fires with nothing anywhere saying why.
    const recorders = Object.values(AUTOMATION_TRIGGERS).filter((t) => /\brecord/i.test(t.label));
    assert.deepEqual(
      recorders.map((t) => t.label).sort(),
      ["OBS starts recording", "OBS stops recording", "REAPER starts recording", "REAPER stops recording"],
    );
  });

  test("no two triggers share a label", () => {
    // An EXACT check over the whole registry, not just the recorders: two rows
    // reading the same in the picker is the failure, whichever pair causes it.
    const byLabel = new Map<string, string[]>();
    for (const t of Object.values(AUTOMATION_TRIGGERS)) {
      byLabel.set(t.label, [...(byLabel.get(t.label) ?? []), t.id]);
    }
    const clashes = [...byLabel].filter(([, ids]) => ids.length > 1);
    assert.deepEqual(
      clashes,
      [],
      `these triggers read identically in the picker: ${clashes.map(([l, ids]) => `"${l}" (${ids.join(", ")})`).join("; ")}`,
    );
  });
});
