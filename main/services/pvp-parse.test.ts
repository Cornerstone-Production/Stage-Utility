import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { parseWorkspace, layerSignature, anchorDriftSec, driftedLayers } from "./pvp-parse.js";
import type { PvpLayerDTO, PvpStatusDTO } from "../types/pvp.js";

const FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/pvp-workspace.json", import.meta.url), "utf8"),
);

function byName(layers: PvpLayerDTO[], name: string): PvpLayerDTO {
  const l = layers.find((x) => x.name === name);
  assert.ok(l, `no layer named ${name}`);
  return l;
}

describe("parseWorkspace", () => {
  test("reads every layer in the workspace", () => {
    assert.equal(parseWorkspace(FIXTURE).length, 4);
  });

  test("a layer with a rolling video is 'video'", () => {
    const l = byName(parseWorkspace(FIXTURE), "Graphics");
    assert.equal(l.state, "video");
    assert.equal(l.mediaName, "loop_a.mp4");
    assert.equal(l.mediaUuid, "media-0001");
    assert.equal(l.playbackRate, 1);
  });

  test("a still image is 'still', NOT 'video', even though PVP says isPlaying", () => {
    // The finding this test exists for: a still reports isPlaying: true with
    // playbackRate: 0. Reading isPlaying would call it a rolling video.
    const l = byName(parseWorkspace(FIXTURE), "Lower third");
    assert.equal(l.state, "still");
    assert.equal(l.playbackRate, 0);
  });

  test("a layer with NO playingMedia key is empty", () => {
    const l = byName(parseWorkspace(FIXTURE), "Exit screen");
    assert.equal(l.state, "empty");
    assert.equal(l.mediaName, null);
    assert.equal(l.mediaUuid, null);
  });

  test("only the PRESENCE of playingMedia decides it — never isPlaying", () => {
    // Synthetic on purpose, and it has to be: the observed workspace never
    // showed the two signals disagreeing, so the fixture alone cannot tell a
    // parser that reads `playingMedia in t` from one that reads `isPlaying`.
    // A guard that cannot separate the right implementation from the wrong one
    // is not a guard, and this repo has shipped several that could not.
    const claimsPlaying = parseWorkspace({
      data: [{ transportState: { isPlaying: true, playbackRate: 1, playingItem: { name: "STALE" }, layer: { uuid: "a", name: "A" } } }],
    });
    assert.equal(claimsPlaying[0].state, "empty", "isPlaying with no media must still be empty");
    assert.equal(claimsPlaying[0].mediaName, null);

    // And the converse: a clip loaded and stopped holds content, whatever
    // isPlaying says about it.
    const loadedButStopped = parseWorkspace({
      data: [{ transportState: { isPlaying: false, playbackRate: 0, playingMedia: { name: "clip.mp4", uuid: "m1" }, layer: { uuid: "b", name: "B" } } }],
    });
    assert.equal(loadedButStopped[0].state, "still");
    assert.equal(loadedButStopped[0].mediaName, "clip.mp4");
  });

  test("a playingMedia key present but EMPTY is still content, not an empty layer", () => {
    // Absent, not null, is what the research observed for an empty layer. A
    // present-but-null value is a shape nobody has seen, and reading it as
    // "empty" would silently widen the has-content rule to truthiness.
    const l = parseWorkspace({ data: [{ transportState: { playingMedia: null, layer: { uuid: "c", name: "C" } } }] });
    assert.equal(l[0].state, "still");
    assert.equal(l[0].mediaName, null, "no name to show, but the layer is not empty");
  });

  test("an empty layer still carries its residual cue name, for verification", () => {
    // Kept, not nulled: it is the only field that can confirm a trigger landed.
    // PvpLayerRow is the one place that refuses to DRAW it — see its own test.
    assert.equal(byName(parseWorkspace(FIXTURE), "Exit screen").lastCueName, "MAIN GRAPHIC");
  });

  test("A PAUSED CLIP KEEPS ITS DURATION, so its bar freezes rather than vanishing", () => {
    // A still and a paused clip both report playbackRate 0. Only timeRemaining
    // tells them apart. Reading the rate alone called a paused clip a still,
    // which dropped its duration, which made computePvpProgress return null and
    // PvpLayerRow drop the bar and the countdown entirely — so pausing mid-clip
    // made the reading DISAPPEAR off a wall instead of holding where it was.
    const l = parseWorkspace({
      data: [{
        transportState: {
          isPlaying: true, playbackRate: 0, timeElapsed: 10, timeRemaining: 10,
          playingMedia: { name: "clip.mp4", uuid: "m1" },
          layer: { uuid: "p1", name: "Paused" },
        },
      }],
    })[0];
    assert.equal(l.state, "video", "a loaded clip with time left is not a still");
    assert.equal(l.durationSec, 20);
    assert.equal(l.anchorElapsedSec, 10);
    assert.equal(l.playbackRate, 0, "and it is still reported as not advancing");
  });

  test("duration is elapsed + remaining for a video, and null for a still", () => {
    const layers = parseWorkspace(FIXTURE);
    assert.equal(byName(layers, "Graphics").durationSec, 20);
    assert.equal(byName(layers, "Graphics").anchorElapsedSec, 9.6);
    // A still's timeRemaining is 0, so a "duration" would just echo its elapsed.
    assert.equal(byName(layers, "Lower third").durationSec, null);
  });

  test("an empty layer has no anchor and no duration", () => {
    const l = byName(parseWorkspace(FIXTURE), "Exit screen");
    assert.equal(l.anchorElapsedSec, null);
    assert.equal(l.durationSec, null);
  });

  test("hidden, muted and part-opacity are read", () => {
    // Never observed live on a real workspace — synthesised so the renderer
    // branch that handles it is exercised by something.
    const l = byName(parseWorkspace(FIXTURE), "Hidden layer");
    assert.equal(l.hidden, true);
    assert.equal(l.muted, true);
    assert.equal(l.opacity, 0.5);
  });

  test("opacity is clamped, because PVP itself clamps what it is sent", () => {
    const high = parseWorkspace({ data: [{ transportState: { layer: { uuid: "a", name: "A", opacity: 5 } } }] });
    assert.equal(high[0].opacity, 1);
    const low = parseWorkspace({ data: [{ transportState: { layer: { uuid: "b", name: "B", opacity: -2 } } }] });
    assert.equal(low[0].opacity, 0);
  });

  test("a missing opacity is fully opaque, not zero", () => {
    // Defaulting to 0 would render every layer of a build that omits the field
    // invisible, and the badge row would claim every layer was faded out.
    const l = parseWorkspace({ data: [{ transportState: { layer: { uuid: "c", name: "C" } } }] });
    assert.equal(l[0].opacity, 1);
  });

  test("garbage never throws and never yields NaN", () => {
    for (const junk of [null, undefined, {}, { data: null }, { data: "nope" }, { data: [null, 3, {}] }]) {
      const layers = parseWorkspace(junk);
      assert.ok(Array.isArray(layers), `${JSON.stringify(junk)} did not yield an array`);
      for (const l of layers) {
        assert.ok(Number.isFinite(l.opacity), `opacity was ${l.opacity}`);
        assert.ok(Number.isFinite(l.playbackRate), `playbackRate was ${l.playbackRate}`);
      }
    }
  });

  test("a layer with no uuid is dropped, not carried with an empty key", () => {
    // uuid is the diff key for every trigger and the address for every action.
    // Two layers keyed on "" would collide and read as one.
    assert.equal(parseWorkspace({ data: [{ transportState: { layer: { name: "no uuid" } } }] }).length, 0);
  });

  test("index is the position PVP returned, kept even when a layer is dropped", () => {
    // Display order only. It is taken from the response position rather than a
    // running counter so a dropped layer does not silently renumber the rest.
    const layers = parseWorkspace({
      data: [
        { transportState: { layer: { name: "no uuid" } } },
        { transportState: { layer: { uuid: "z", name: "Z" } } },
      ],
    });
    assert.deepEqual(layers.map((l) => [l.name, l.index]), [["Z", 1]]);
  });
});

describe("layerSignature", () => {
  const base = parseWorkspace(FIXTURE);

  test("the same state twice is the same signature", () => {
    assert.equal(layerSignature(base), layerSignature(parseWorkspace(FIXTURE)));
  });

  test("time moving does NOT change the signature", () => {
    // THE efficiency decision, pinned. If this fails, a 1 Hz poll has become a
    // 1 Hz SSE frame to every connected display.
    const later = base.map((l) => ({ ...l, anchorElapsedSec: 12.3, durationSec: 20 }));
    assert.equal(layerSignature(later), layerSignature(base));
  });

  test("a new media uuid DOES change the signature", () => {
    const next = base.map((l, i) => (i === 0 ? { ...l, mediaUuid: "media-9999" } : l));
    assert.notEqual(layerSignature(next), layerSignature(base));
  });

  test("hiding, muting, opacity and rate all change the signature", () => {
    for (const patch of [{ hidden: true }, { muted: true }, { opacity: 0.5 }, { playbackRate: 0 }]) {
      const next = base.map((l, i) => (i === 0 ? { ...l, ...patch } : l));
      assert.notEqual(layerSignature(next), layerSignature(base), `${JSON.stringify(patch)} was not noticed`);
    }
  });

  test("a layer disappearing changes the signature", () => {
    assert.notEqual(layerSignature(base.slice(1)), layerSignature(base));
  });

  test("a media name changing under the same uuid does not change the signature", () => {
    // The uuid is the identity. A name is a label, and the observed workspace
    // had seven files whose names differed only by a trailing digit.
    const next = base.map((l, i) => (i === 0 ? { ...l, mediaName: "something_else.mp4" } : l));
    assert.equal(layerSignature(next), layerSignature(base));
  });
});

describe("anchorDriftSec", () => {
  test("ordinary playback has no drift", () => {
    // 10.0s elapsed, one second later, at rate 1 -> 11.0s. Exactly as predicted.
    assert.ok(anchorDriftSec(10, 0, 11, 1000, 1) < 0.01);
  });

  test("a loop restarting on the SAME media is a large drift", () => {
    // The case a media-uuid diff cannot see: one clip looping. Predicted 20.5,
    // observed 0.3.
    assert.ok(anchorDriftSec(19.5, 0, 0.3, 1000, 1) > 1);
  });

  test("a pause is a drift", () => {
    assert.ok(anchorDriftSec(10, 0, 10, 5000, 1) > 1);
  });

  test("a still frame never drifts, so it never re-anchors", () => {
    // rate 0 predicts no movement, and there is none. A still must not force a
    // frame on every poll for the rest of the service.
    assert.ok(anchorDriftSec(0, 0, 0, 60_000, 0) < 0.01);
  });

  test("a null anchor on either side is no drift, not NaN", () => {
    assert.equal(anchorDriftSec(null, 0, 5, 1000, 1), 0);
    assert.equal(anchorDriftSec(5, 0, null, 1000, 1), 0);
  });

  test("time running backwards is no drift, not a frame every poll", () => {
    assert.equal(anchorDriftSec(10, 5000, 0.2, 0, 1), 0);
  });
});

describe("driftedLayers", () => {
  const at = (iso: string, layers: PvpLayerDTO[]): PvpStatusDTO => ({ connected: true, layers, sampledAt: iso });
  const T0 = "2026-08-30T12:00:00.000Z";
  const T1 = "2026-08-30T12:00:01.000Z";
  const base = parseWorkspace(FIXTURE);

  test("ordinary playback drifts nothing", () => {
    const next = base.map((l) => (l.state === "video" ? { ...l, anchorElapsedSec: 10.6 } : l));
    assert.deepEqual(driftedLayers(at(T0, base), at(T1, next), 1), []);
  });

  test("a restarted loop is named", () => {
    const next = base.map((l) => (l.state === "video" ? { ...l, anchorElapsedSec: 0.2 } : l));
    assert.deepEqual(driftedLayers(at(T0, base), at(T1, next), 1), ["layer-0001"]);
  });

  test("a layer that was not there before is not drift", () => {
    // It is a signature change, which already sends a frame. Reporting it twice
    // would be noise.
    const next = [...base, { ...base[0], uuid: "layer-9999", name: "New" }];
    assert.deepEqual(driftedLayers(at(T0, base), at(T1, next), 1), []);
  });

  test("an unparseable sampledAt is not drift", () => {
    // A NaN dt must not force a frame on every poll forever.
    const next = base.map((l) => (l.state === "video" ? { ...l, anchorElapsedSec: 0.2 } : l));
    assert.deepEqual(driftedLayers(at("", base), at(T1, next), 1), []);
  });

  test("an idle workspace of stills never drifts, however long it sits", () => {
    // Every still has rate 0, so it predicts no movement. Without that, a
    // workspace holding one graphic between services would force a frame on
    // every poll for hours.
    const stills = base.filter((l) => l.state !== "video");
    const later = "2026-08-30T13:00:00.000Z";
    assert.deepEqual(driftedLayers(at(T0, stills), at(later, stills), 1), []);
  });
});
