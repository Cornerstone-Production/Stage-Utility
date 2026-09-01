// Every PVP action reports a FAILURE when the write did not land.
//
// PVP answers a POST with 200 and an empty body whether or not it acted, and
// applies a change a beat later. An action that trusted the 200 would be a rule
// that appears to run, logs "fired", and never touches a screen.
//
// WHAT THIS FILE PROVES AND WHAT IT DOES NOT, said plainly. It replaces
// pvpDeps.command with a double, so it proves the ACTIONS: that each one posts
// the right path, resolves the right layer, refuses what it should refuse, and
// hands `command` a predicate that says no when the world did not change.
// It does NOT prove command() itself — a double proves the double. The real
// method, its retry loop and its failure wording are exercised against a stubbed
// transport in pvp-service.test.ts.

import { strict as assert } from "node:assert";
import { describe, test, beforeEach } from "node:test";

import { PVP_ACTIONS, pvpDeps } from "./pvp-actions.js";
import type { PvpLayerDTO } from "../types/pvp.js";
import type { ActionResult } from "../types/automation.js";

const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Graphics", index: 0, state: "video",
  mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC", lastCueUuid: "c1", nextCueName: null,
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 1, durationSec: 20,
  ...over,
});

let posted: { path: string; body: unknown }[] = [];
/** Stands in for pvpService.command: records the post, then answers the verify
 *  predicate against whatever `after` is set to. This is the whole point of the
 *  seam — it lets a test say "PVP answered 200 and nothing changed". */
let after: PvpLayerDTO[] = [layer()];
let readThrows: Error | null = null;

beforeEach(() => {
  posted = [];
  after = [layer()];
  readThrows = null;
  pvpDeps.readLayers = async () => {
    if (readThrows) throw readThrows;
    return [layer()];
  };
  pvpDeps.command = async (path, body, verify): Promise<ActionResult> => {
    posted.push({ path, body });
    return verify.holds(after)
      ? { ok: true, detail: verify.what }
      : { ok: false, detail: `PVP answered 200 but ${verify.what} did not take effect` };
  };
});

const run = (id: string, params: Record<string, unknown>, simulate = false) =>
  PVP_ACTIONS[id].run(params, { simulate });

describe("PVP actions verify rather than trusting a 200", () => {
  test("clearing a layer that DID clear succeeds", async () => {
    after = [layer({ state: "empty", mediaUuid: null, mediaName: null })];
    const r = await run("pvp.clear-layer", { layer: "Graphics" });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(posted.map((p) => p.path), ["/clear/layer/l1"]);
  });

  test("clearing a layer that did NOT clear FAILS, even though PVP said 200", async () => {
    // THE test this whole file exists for. `after` is unchanged: PVP accepted the
    // request and did nothing.
    after = [layer()];
    const r = await run("pvp.clear-layer", { layer: "Graphics" });
    assert.equal(r.ok, false);
    assert.match(r.detail, /did not take effect/);
  });

  test("a residual cue name does not make a cleared layer look uncleared", async () => {
    // playingItem survives a clear on every layer observed, so a verify that
    // asked about the cue would report a working clear as failed forever.
    after = [layer({ state: "empty", mediaUuid: null, mediaName: null, lastCueName: "MAIN GRAPHIC" })];
    assert.equal((await run("pvp.clear-layer", { layer: "Graphics" })).ok, true);
  });

  test("clearing the workspace requires EVERY layer empty, and an empty read is not success", async () => {
    after = [layer({ state: "empty" }), layer({ uuid: "l2", state: "video" })];
    assert.equal((await run("pvp.clear-workspace", {})).ok, false);
    after = [layer({ state: "empty" }), layer({ uuid: "l2", state: "empty" })];
    assert.equal((await run("pvp.clear-workspace", {})).ok, true);
    // A read that returned nothing satisfies every() vacuously. It must not pass.
    after = [];
    assert.equal((await run("pvp.clear-workspace", {})).ok, false);
  });

  test("hide, unhide, mute and unmute each verify their OWN field", async () => {
    after = [layer({ hidden: true })];
    assert.equal((await run("pvp.hide-layer", { layer: "Graphics" })).ok, true);
    assert.equal((await run("pvp.mute-layer", { layer: "Graphics" })).ok, false, "hidden must not satisfy muted");
    after = [layer({ muted: true })];
    assert.equal((await run("pvp.mute-layer", { layer: "Graphics" })).ok, true);
    assert.equal((await run("pvp.unmute-layer", { layer: "Graphics" })).ok, false);
    after = [layer()];
    assert.equal((await run("pvp.unhide-layer", { layer: "Graphics" })).ok, true);
    assert.equal((await run("pvp.unmute-layer", { layer: "Graphics" })).ok, true);
  });

  test("each flag action posts its own path", async () => {
    after = [layer({ hidden: true, muted: true })];
    await run("pvp.hide-layer", { layer: "Graphics" });
    await run("pvp.mute-layer", { layer: "Graphics" });
    after = [layer()];
    await run("pvp.unhide-layer", { layer: "Graphics" });
    await run("pvp.unmute-layer", { layer: "Graphics" });
    assert.deepEqual(posted.map((p) => p.path), [
      "/hide/layer/l1", "/mute/layer/l1", "/unhide/layer/l1", "/unmute/layer/l1",
    ]);
  });

  test("opacity is sent as 0..1 and verified with a tolerance", async () => {
    after = [layer({ opacity: 0.5 })];
    const r = await run("pvp.set-layer-opacity", { layer: "Graphics", percent: 50 });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(posted[0], { path: "/opacity/layer/l1", body: { value: 0.5 } });
  });

  test("an opacity that came back a hair off still counts, and one that came back wrong does not", async () => {
    // The value crosses JSON and returns through whatever precision PVP keeps it
    // in. An exact float compare would report a working action as failed.
    after = [layer({ opacity: 0.3300001 })];
    assert.equal((await run("pvp.set-layer-opacity", { layer: "Graphics", percent: 33 })).ok, true);
    after = [layer({ opacity: 1 })];
    assert.equal((await run("pvp.set-layer-opacity", { layer: "Graphics", percent: 33 })).ok, false);
  });

  test("an out-of-range opacity is REFUSED, not sent and clamped", async () => {
    // PVP silently clamps 5 to 1 and answers 200. Sending it would set the layer
    // fully opaque and report success at "500%".
    for (const percent of [500, -1, NaN, "nope"]) {
      const r = await run("pvp.set-layer-opacity", { layer: "Graphics", percent });
      assert.equal(r.ok, false, `${String(percent)} was accepted`);
    }
    assert.deepEqual(posted, [], "an out-of-range opacity reached the wire");
  });

  test("firing a cue succeeds when SOME layer picks it up", async () => {
    // The pre-image (from pvpDeps.readLayers) carries lastCueName "MAIN GRAPHIC"
    // on a layer holding m1, so a confirmation needs the cue to have MOVED.
    pvpDeps.readLayers = async () => [layer({ lastCueName: "SOMETHING ELSE" })];
    after = [layer({ lastCueName: "SOMETHING ELSE" })];
    assert.equal((await run("pvp.trigger-cue", { playlist: "PreService", cue: "MAIN GRAPHIC" })).ok, false);
    after = [layer({ lastCueName: "MAIN GRAPHIC" })];
    const r = await run("pvp.trigger-cue", { playlist: "PreService", cue: "MAIN GRAPHIC" });
    assert.equal(r.ok, true, r.detail);
    assert.equal(posted[1].path, "/trigger/playlist/PreService/cue/MAIN%20GRAPHIC");
  });

  test("RE-FIRING THE CUE A LAYER IS ALREADY CARRYING IS NOT SELF-CONFIRMING", async () => {
    // THE bug this predicate is most likely to have. `lastCueName` is RESIDUAL —
    // it names the last cue that touched the layer and never clears — so a
    // verify that only asked "is the cue there" would find it already there from
    // an earlier firing and report success against a PVP that did nothing. On a
    // layer that has since been CLEARED, that means reporting "fired" at a black
    // screen.
    const stale = layer({ lastCueName: "MAIN GRAPHIC", state: "empty", mediaUuid: null, mediaName: null, anchorElapsedSec: null });
    pvpDeps.readLayers = async () => [stale];
    after = [stale]; // PVP answered 200 and changed nothing.
    const r = await run("pvp.trigger-cue", { playlist: "PreService", cue: "MAIN GRAPHIC" });
    assert.equal(r.ok, false, `reported success against an unchanged workspace: ${r.detail}`);
  });

  test("a re-fire IS confirmed when the media changes or the clip restarts", async () => {
    // The other half: the same cue genuinely firing again must still confirm.
    // Two signals do it — different media under the same cue name, or the clip's
    // clock jumping backwards.
    const before = layer({ lastCueName: "MAIN GRAPHIC", mediaUuid: "m1", anchorElapsedSec: 18 });
    pvpDeps.readLayers = async () => [before];

    after = [layer({ lastCueName: "MAIN GRAPHIC", mediaUuid: "m2", anchorElapsedSec: 1 })];
    assert.equal((await run("pvp.trigger-cue", { playlist: "PreService", cue: "MAIN GRAPHIC" })).ok, true, "media changed");

    after = [layer({ lastCueName: "MAIN GRAPHIC", mediaUuid: "m1", anchorElapsedSec: 0.4 })];
    assert.equal((await run("pvp.trigger-cue", { playlist: "PreService", cue: "MAIN GRAPHIC" })).ok, true, "clip restarted");
  });

  test("a cue landing on a layer that was not there before is confirmed", async () => {
    // No pre-image for that layer means it cannot have been carrying the cue
    // already, so its arrival IS the evidence.
    pvpDeps.readLayers = async () => [layer({ lastCueName: "SOMETHING ELSE" })];
    after = [layer({ lastCueName: "SOMETHING ELSE" }), layer({ uuid: "l9", name: "New", lastCueName: "MAIN GRAPHIC" })];
    assert.equal((await run("pvp.trigger-cue", { playlist: "PreService", cue: "MAIN GRAPHIC" })).ok, true);
  });

  test("a trigger whose pre-image cannot be read is NOT sent", async () => {
    // Without a pre-image there is no way to tell a fresh firing from a residual
    // cue, so firing anyway would be a command that can never be confirmed.
    readThrows = new Error("connect ECONNREFUSED");
    const r = await run("pvp.trigger-cue", { playlist: "PreService", cue: "MAIN GRAPHIC" });
    assert.equal(r.ok, false);
    assert.match(r.detail, /ECONNREFUSED/);
    assert.deepEqual(posted, []);
  });

  test("the message says when only a restart could confirm it", async () => {
    // Said rather than hidden: an operator whose rule reports failed deserves to
    // know the verify was working with a residual field.
    const stale = layer({ lastCueName: "MAIN GRAPHIC" });
    pvpDeps.readLayers = async () => [stale];
    after = [stale];
    const r = await run("pvp.trigger-cue", { playlist: "PreService", cue: "MAIN GRAPHIC" });
    assert.match(r.detail, /already the last cue/);
  });

  test("THERE IS NO ACTION THAT CLAIMS TO CHOOSE A CUE'S LAYER", async () => {
    // Measured on the device, not inferred: PVP's layer-addressed trigger
    // endpoint accepts the layer and IGNORES it. Three empty layers (1, 2, 4)
    // were each sent a different PreService cue; all three landed on layer 0,
    // the cue's own configured layer, and the three named layers stayed empty.
    // Three targets rather than one rules out "that layer refused that media".
    //
    // An action built on it would fire a real cue, change what is on screen, and
    // then correctly report a failure — a side effect logged as a no-op, which
    // invites a retry that fires it again. So it is not offered at all, and this
    // is the guard that stops it being reintroduced as an obvious-looking
    // convenience.
    assert.ok(!("pvp.trigger-cue-on-layer" in PVP_ACTIONS));
    for (const [id, a] of Object.entries(PVP_ACTIONS)) {
      const takesLayerAndCue = a.params.some((p) => p.key === "layer") && a.params.some((p) => p.key === "cue");
      assert.ok(!takesLayerAndCue, `${id} takes both a layer and a cue, which PVP cannot honour`);
    }
  });

  test("an all-digits playlist or cue name is REFUSED, not sent as a position", async () => {
    // PVP reads an all-digits parameter as an INDEX, so "2024" would fire the
    // 2024th entry rather than the playlist called 2024.
    for (const params of [{ playlist: "2024", cue: "MAIN GRAPHIC" }, { playlist: "PreService", cue: "12" }]) {
      const res = await run("pvp.trigger-cue", params);
      assert.equal(res.ok, false, JSON.stringify(params));
      assert.match(res.detail, /position/);
    }
    assert.deepEqual(posted, []);
  });

  test("a layer name that matches nothing fails, and lists what does exist", async () => {
    const r = await run("pvp.clear-layer", { layer: "Typo" });
    assert.equal(r.ok, false);
    assert.match(r.detail, /"Graphics"/);
    assert.deepEqual(posted, [], "a POST went out for a layer that does not exist");
  });

  test("a blank layer name fails rather than clearing an arbitrary layer", async () => {
    assert.equal((await run("pvp.clear-layer", { layer: "" })).ok, false);
    assert.deepEqual(posted, []);
  });

  test("a layer name matches case-insensitively and ignores stray spaces", async () => {
    after = [layer({ state: "empty" })];
    assert.equal((await run("pvp.clear-layer", { layer: "  graphics " })).ok, true);
  });

  test("a failed READ is a failure, not a success and not a throw", async () => {
    readThrows = new Error("connect ECONNREFUSED");
    const r = await run("pvp.clear-layer", { layer: "Graphics" });
    assert.equal(r.ok, false);
    assert.match(r.detail, /ECONNREFUSED/);
    assert.deepEqual(posted, [], "a POST went out after the layer read failed");
  });

  test("simulate never reaches the wire, for any action", async () => {
    for (const id of Object.keys(PVP_ACTIONS)) {
      const r = await PVP_ACTIONS[id].run(
        { layer: "Graphics", percent: 50, playlist: "PreService", cue: "MAIN GRAPHIC" },
        { simulate: true },
      );
      assert.equal(r.ok, true, `${id} failed in simulate: ${r.detail}`);
      assert.match(r.detail, /^would /, `${id} did not say what it WOULD do: ${r.detail}`);
    }
    assert.deepEqual(posted, [], "simulate mode sent a command");
  });

  test("every action is registered under the id it declares", async () => {
    for (const [key, a] of Object.entries(PVP_ACTIONS)) assert.equal(a.id, key);
  });

  test("no action throws, whatever it is given", async () => {
    // ActionDef's contract: a failure is a returned result, so one bad provider
    // cannot stop the engine or block the next rule.
    for (const id of Object.keys(PVP_ACTIONS)) {
      for (const params of [{}, { layer: null }, { layer: 7 }, { layer: "Graphics", percent: "x" }, { playlist: {}, cue: [] }]) {
        await assert.doesNotReject(
          () => PVP_ACTIONS[id].run(params as never, { simulate: false }),
          `${id} threw on ${JSON.stringify(params)}`,
        );
      }
    }
  });
});
