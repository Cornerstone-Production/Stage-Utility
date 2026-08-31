import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  parseWorkspace, layerSignature, anchorDriftSec, driftedLayers,
  cueSuccessors, hasUnknownCue, isPlaylistsResponse, isWorkspaceResponse, withNextCues,
} from "./pvp-parse.js";
import type { PvpLayerDTO, PvpStatusDTO } from "../types/pvp.js";

const FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/pvp-workspace.json", import.meta.url), "utf8"),
);
const PLAYLISTS: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/pvp-playlists.json", import.meta.url), "utf8"),
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

  test("EVERY field in the signature is actually in it", () => {
    // The whole list, one patch each. Five of the twelve were unpinned, and a
    // signature shortened to uuid/mediaUuid/nextCueName left the file green —
    // which is a still going to video, and a cue change under the same media,
    // never reaching a display at all.
    //
    // A Partial<PvpLayerDTO> per field rather than a loop over keys, because the
    // patch has to be a DIFFERENT value from the fixture's and only a human can
    // say what that is. Adding a field to layerSignature without adding a line
    // here fails the count below.
    const patches: Partial<PvpLayerDTO>[] = [
      { uuid: "layer-9999" },
      { name: "Renamed" },
      { index: 7 },
      { state: "empty" },
      { mediaUuid: "media-9999" },
      { lastCueName: "SOME OTHER CUE" },
      { lastCueUuid: "cue-9999" },
      { nextCueName: "THE ONE AFTER" },
      { hidden: true },
      { muted: true },
      { opacity: 0.5 },
      { playbackRate: 3 },
    ];
    for (const patch of patches) {
      const next = base.map((l, i) => (i === 0 ? { ...l, ...patch } : l));
      assert.notEqual(layerSignature(next), layerSignature(base), `${JSON.stringify(patch)} was not noticed`);
    }

    // EXACT, not a floor. The signature is an array of arrays, one per layer;
    // a field dropped from it and from the list above would otherwise pass.
    const decoded = JSON.parse(layerSignature(base)) as unknown[][];
    assert.equal(decoded.length, base.length);
    for (const row of decoded) {
      assert.equal(row.length, patches.length, "the signature and the list above have drifted apart");
    }
  });

  test("the fields deliberately LEFT OUT stay out", () => {
    // The efficiency decision, field by field. Any of these moving on every poll
    // during playback, so including one turns a 1 Hz poll into a 1 Hz SSE frame.
    for (const patch of [
      { anchorElapsedSec: 12.3 },
      { durationSec: 20 },
      // The uuid beside it is the identity; a name change under a stable uuid is
      // a relabel, not a cue.
      { mediaName: "something_else.mp4" },
    ] as Partial<PvpLayerDTO>[]) {
      const next = base.map((l, i) => (i === 0 ? { ...l, ...patch } : l));
      assert.equal(
        layerSignature(next),
        layerSignature(base),
        `${JSON.stringify(patch)} would send a frame on every poll`,
      );
    }
  });

  test("a layer disappearing changes the signature", () => {
    assert.notEqual(layerSignature(base.slice(1)), layerSignature(base));
  });
});

describe("anchorDriftSec", () => {
  // EXACT values throughout. `< 0.01` and `> 1` were bounds around numbers that
  // are stable and computable — the whole function is arithmetic on its
  // arguments — so the loose form only ever hid which answer was actually
  // returned.
  test("ordinary playback has no drift", () => {
    // 10.0s elapsed, one second later, at rate 1 -> 11.0s. Exactly as predicted.
    assert.equal(anchorDriftSec(10, 0, 11, 1000, 1), 0);
  });

  test("a loop restarting on the SAME media is a large drift", () => {
    // The case a media-uuid diff cannot see: one clip looping. Predicted 20.5,
    // observed 0.3.
    assert.equal(anchorDriftSec(19.5, 0, 0.3, 1000, 1), 20.2);
  });

  test("a pause is a drift", () => {
    // Predicted 15.0 after five seconds at rate 1; observed 10.0.
    assert.equal(anchorDriftSec(10, 0, 10, 5000, 1), 5);
  });

  test("a still frame never drifts, so it never re-anchors", () => {
    // rate 0 predicts no movement, and there is none. A still must not force a
    // frame on every poll for the rest of the service.
    assert.equal(anchorDriftSec(0, 0, 0, 60_000, 0), 0);
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

// ── The playlist tree, and the one thing it is asked ────────────────────────
//
// "What plays after this?" is a QUALIFIED answer and the qualification is the
// point: it is the next entry in the playlist, which is what plays next only
// while the playlist keeps auto-advancing. Everything below is about not
// overstating it.
//
// ABOUT THE FIXTURE, plainly: pvp-playlists.json is HAND-WRITTEN, not captured.
// It is small enough to read, and it carries the three shapes the parser has to
// get right that a capture happened not to contain — a nested playlist, a
// duplicate cue uuid, and a cue at the end of its list.
//
// What that costs is the thing a capture would give: it cannot fail on a shape
// the parser got wrong, because it was written to match the parser. So the
// shape was checked against the real device on 2026-08-30 instead, and it holds:
// `{ playlist: { name, uuid, children: [ { uuid, name, items: [{ uuid, name }],
// children: [] } ] } }`, 26 entries across 6 playlists, every uuid distinct even
// where two entries share a name.
//
// The derivation was verified there too: the live `playingItem` uuid matched
// index 1 of a playlist and the entry after it was the one this function names.

describe("isWorkspaceResponse", () => {
  // Asserted nowhere until this block existed: `return true` left the whole
  // file green. It is the only guard between the API-DOCUMENTATION port — which
  // answers 200 with JSON — and Test connection cheerfully reporting
  // "Connected — 0 layers" for the exact wrong port it exists to catch.
  test("accepts the real workspace, and an empty one", () => {
    assert.equal(isWorkspaceResponse(FIXTURE), true);
    // A real workspace with no layers. Not an error, and must not read as one.
    assert.equal(isWorkspaceResponse({ data: [] }), true);
  });

  test("rejects anything else that answered 200 with JSON", () => {
    assert.equal(isWorkspaceResponse({}), false);
    assert.equal(isWorkspaceResponse(null), false);
    assert.equal(isWorkspaceResponse({ data: "nope" }), false);
    // The playlist tree is a different endpoint on the same host. Reading it as
    // a workspace would report every layer gone.
    assert.equal(isWorkspaceResponse(PLAYLISTS), false);
  });
});

describe("isPlaylistsResponse", () => {
  test("accepts the real tree", () => {
    assert.equal(isPlaylistsResponse(PLAYLISTS), true);
  });

  test("rejects a workspace, and anything else that answered 200", () => {
    // The setup mistake this integration warns about twice: PVP serves its API
    // DOCUMENTATION on a different port, which answers 200 with JSON. Caching an
    // empty map from that would look like a workspace with no playlists at all.
    assert.equal(isPlaylistsResponse(FIXTURE), false);
    assert.equal(isPlaylistsResponse({}), false);
    assert.equal(isPlaylistsResponse({ playlist: [] }), false);
    assert.equal(isPlaylistsResponse(null), false);
  });
});

describe("cueSuccessors", () => {
  const map = cueSuccessors(PLAYLISTS);

  test("a cue maps to the entry AFTER it, not to itself and not to the first", () => {
    // The bug this replaces: an off-by-one that names the current cue reads as a
    // widget repeating itself, and one that names index 0 reads as a playlist
    // about to restart.
    assert.equal(map.get("cue-0000"), "MAIN GRAPHIC");
    assert.equal(map.get("cue-0001"), "CLEAR GRAPHIC");
  });

  test("the LAST entry of a playlist maps to null, and is present", () => {
    // Present-with-null is "this is the end"; absent is "never heard of it".
    // Collapsing the two would make the end of every playlist look like a cache
    // miss and refetch the tree on a loop.
    assert.equal(map.has("cue-0009"), true);
    assert.equal(map.get("cue-0009"), null);
  });

  test("a successor NEVER crosses a playlist boundary", () => {
    // cue-0009 ends Masters and cue-0002 opens Pre-service. PVP does not advance
    // that way, and a widget that said so would name a cue from another part of
    // the service.
    //
    // Stated as "it is the END", not as "it is not LOWER THIRD": notEqual passes
    // for undefined and for every other wrong successor, and the exact assertion
    // in the test above already implies it.
    assert.equal(map.get("cue-0009"), null, "the last cue of a playlist ran on into the next one");
    // And the trap is still in the fixture: cue-0002 "LOWER THIRD" opens the
    // NEXT playlist, so a walk that flattened the tree would name it here.
    assert.equal(map.has("cue-0002"), true, "the fixture no longer contains the cue that opens the next playlist");
    assert.equal(
      [...map.values()].includes("LOWER THIRD"),
      false,
      "a cue is followed by the first entry of another playlist",
    );
  });

  test("nested playlists are walked, because the format allows them", () => {
    assert.equal(map.get("cue-0010"), "NESTED TWO");
    assert.equal(map.get("cue-0011"), null);
  });

  test("a cue in no playlist is absent, not null", () => {
    assert.equal(map.has("cue-nope"), false);
  });

  test("the first occurrence of a uuid wins", () => {
    const dup = cueSuccessors({
      playlist: {
        children: [
          { items: [{ uuid: "x", name: "X" }, { uuid: "y", name: "FIRST" }] },
          { items: [{ uuid: "x", name: "X" }, { uuid: "z", name: "SECOND" }] },
        ],
      },
    });
    assert.equal(dup.get("x"), "FIRST");
  });

  test("garbage is an empty map, never a throw", () => {
    // It is a response from a build we do not control, and a parser that threw
    // would take the poll down and be reported as "unreachable".
    assert.equal(cueSuccessors(null).size, 0);
    assert.equal(cueSuccessors({ playlist: { children: "nope" } }).size, 0);
  });
});

describe("withNextCues", () => {
  const map = cueSuccessors(PLAYLISTS);
  const base = parseWorkspace(FIXTURE);

  test("a live layer gets the cue after the one it last played", () => {
    const out = withNextCues(base, map);
    assert.equal(byName(out, "Graphics").nextCueName, "CLEAR GRAPHIC");
    assert.equal(byName(out, "Lower third").nextCueName, null, "cue-0002 ends its playlist");
  });

  test("it never mutates the layers it was given", () => {
    // emitIfChanged keeps the previous snapshot and compares against it. Editing
    // in place would edit that snapshot too, and the comparison would find
    // nothing changed.
    const before = JSON.stringify(base);
    withNextCues(base, map);
    assert.equal(JSON.stringify(base), before);
  });

  test("an unknown cue leaves null rather than guessing", () => {
    assert.equal(withNextCues(base, new Map())[0].nextCueName, null);
  });
});

describe("hasUnknownCue", () => {
  const base = parseWorkspace(FIXTURE);

  test("true when a live layer plays a cue the cache has never heard of", () => {
    assert.equal(hasUnknownCue(base, new Map()), true);
  });

  test("IGNORES an empty layer's residual cue", () => {
    // The guard that stops a refetch loop. An idle layer's `playingItem` names a
    // cue that may have been deleted from the tree hours ago; chasing it would
    // refetch the playlist tree for ever.
    const idle = base.filter((l) => l.state === "empty");
    assert.ok(idle.length > 0, "the fixture has no empty layer to test with");
    assert.ok(idle.some((l) => l.lastCueUuid), "the empty layers carry no residual cue to ignore");
    assert.equal(hasUnknownCue(idle, new Map()), false);
  });

  test("a known cue is not a miss, including one at the end of its playlist", () => {
    assert.equal(hasUnknownCue(base, cueSuccessors(PLAYLISTS)), false);
  });
});

describe("layerSignature and the next cue", () => {
  test("a changed next cue sends a frame, because a display must be told", () => {
    const base = parseWorkspace(FIXTURE);
    const moved = base.map((l) => ({ ...l, nextCueName: "SOMETHING ELSE" }));
    assert.notEqual(layerSignature(base), layerSignature(moved));
  });
});
