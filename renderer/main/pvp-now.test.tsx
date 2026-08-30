// The "what is on now" widget, rendered.
//
// Two classes of bug this file is aimed at, both of which look fine in a props
// assertion and are wrong on a wall:
//
//   1. A STILL DRAWING A COUNTDOWN. PVP reports a still as isPlaying:true with
//      playbackRate 0 and timeRemaining 0, so the obvious reading gives every
//      graphic a 0:00 that ticks nowhere.
//   2. A "NEXT" LINE WITH NOTHING BEHIND IT. It is the next PLAYLIST entry, not
//      a prediction, and drawn without a current cue to anchor it, or past the
//      end of a playlist, it would be a confident claim about the future.
//
// jsdom has no layout engine, so nothing here asserts what the composition LOOKS
// like — sizes, the rule's rendered width, whether a line was dropped for want
// of room. Those were driven in a real browser at 1920x1080 against a live
// ProVideoPlayer, at 257x159, 620x300 and 880x300 tiles and on two Home cards.
//
// One thing that found, which no assertion here could: the EMPTY state does not
// belong in the value slot. The approved mockup puts the sentence there and it
// works at the one card size the mockup drew; at a 257x159 tile "Nothing on this
// layer" measured 241px of text in a 220px box and was cut off mid-word, because
// the value line is one nowrap string that shrinks to fit and then stops. It is
// the sub-line now — which ellipsises — with the app's usual em-dash above it.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PvpNowObject, chooseNowLayer, nowBadge, nowEmptyReason, PVP_NOW_CAPTION } from "./pvp-now.js";
import { computePvpProgress } from "./pvp-progress.js";
import type { PvpLayerDTO, PvpStatusDTO } from "@main/types/pvp";

const T = "2026-08-30T12:00:00.000Z";
const AT = Date.parse(T);

const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Graphics", index: 0, state: "video",
  mediaName: "loop_a.mp4", mediaUuid: "m1",
  lastCueName: "MAIN GRAPHIC", lastCueUuid: "cue-0001", nextCueName: "CLEAR GRAPHIC",
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 10, durationSec: 20,
  ...over,
});

const STILL = {
  state: "still" as const, mediaName: "slide.png", playbackRate: 0,
  anchorElapsedSec: 0, durationSec: null,
};
const EMPTY = {
  state: "empty" as const, mediaName: null, mediaUuid: null,
  anchorElapsedSec: null, durationSec: null,
};

const status = (layers: PvpLayerDTO[]): PvpStatusDTO => ({ connected: true, layers, sampledAt: T });

const draw = (
  s: PvpStatusDTO | null,
  config: { layerName?: string | null; showProgress?: boolean; showNextCue?: boolean } = {},
): string => renderToStaticMarkup(<PvpNowObject config={config} status={s} now={AT} skewMs={0} />);

const progressOf = (l: PvpLayerDTO) => computePvpProgress(l, T, AT, 0);

describe("which layer it reads", () => {
  const three = [layer({ uuid: "a", name: "Top", ...EMPTY }), layer({ uuid: "b", name: "Middle" }), layer({ uuid: "c", name: "Bottom" })];

  test("with no name it follows content, preferring PVP's own stack order", () => {
    assert.equal(chooseNowLayer(three, null)?.name, "Middle");
    assert.equal(chooseNowLayer(three, "  ")?.name, "Middle");
  });

  test("a named layer is matched case-insensitively, spaces ignored", () => {
    assert.equal(chooseNowLayer(three, " bottom ")?.name, "Bottom");
  });

  test("a named EMPTY layer is still that layer, not a wander to another one", () => {
    // An operator who pinned this to Exit Screen wants to know Exit Screen is
    // empty. Falling through to whatever else is up would be the widget quietly
    // answering a different question.
    assert.equal(chooseNowLayer(three, "Top")?.name, "Top");
    assert.equal(chooseNowLayer(three, "Top")?.state, "empty");
  });

  test("a name that matches nothing is null, never a fallback", () => {
    assert.equal(chooseNowLayer(three, "Typo"), null);
  });
});

describe("the badge", () => {
  test("playing is playbackRate > 0 — NEVER isPlaying", () => {
    // isPlaying is true on a still, which is why the DTO does not carry it at
    // all. Rebuild the widget on it and every graphic reads `playing`.
    const l = layer();
    assert.equal(nowBadge(l, progressOf(l)), "playing");
  });

  test("a still is `still`: it is up, and it is not counting", () => {
    const l = layer(STILL);
    assert.equal(nowBadge(l, progressOf(l)), "still");
  });

  test("a paused clip is `paused`: rate 0, but it kept its duration", () => {
    const l = layer({ playbackRate: 0, anchorElapsedSec: 12, durationSec: 20 });
    assert.equal(nowBadge(l, progressOf(l)), "paused");
  });

  test("nothing on the layer is `empty`", () => {
    assert.equal(nowBadge(layer(EMPTY), null), "empty");
    assert.equal(nowBadge(null, null), "empty");
  });
});

describe("what it draws", () => {
  test("the caption names the widget, which is the whole point of it", () => {
    assert.ok(draw(status([layer()])).includes(PVP_NOW_CAPTION));
  });

  test("a rolling clip: the media, the time left, and the rule", () => {
    const html = draw(status([layer()]));
    assert.ok(html.includes("loop_a.mp4"), html);
    assert.ok(html.includes("0:10"), html);
    assert.ok(html.includes("playing"), html);
    assert.ok(html.includes("data-readout-meter"), html);
  });

  test("A STILL DRAWS NO COUNTDOWN AND NO RULE", () => {
    // The guard. Delete the `progress ?` in the sub-line and a graphic that is
    // up indefinitely starts counting down to nothing.
    const html = draw(status([layer(STILL)]));
    assert.ok(html.includes("slide.png"), html);
    assert.ok(!/[0-9]:[0-9][0-9]/.test(html), `a still drew a countdown:\n${html}`);
    assert.ok(!html.includes("data-readout-meter"), `a still drew a progress rule:\n${html}`);
    assert.ok(html.includes("no duration"), html);
  });

  test("an empty layer says so plainly, never a countdown to nothing", () => {
    const html = draw(status([layer(EMPTY)]));
    assert.ok(html.includes("Nothing on screen"), html);
    assert.ok(!/[0-9]:[0-9][0-9]/.test(html), html);
    // And never the residual cue name, which never clears.
    assert.ok(!html.includes("MAIN GRAPHIC"), html);
    assert.ok(!html.includes("CLEAR GRAPHIC"), `an empty layer named a next cue:\n${html}`);
  });

  test("the four nothings are four different sentences", () => {
    const up = status([layer({ name: "Graphics", ...EMPTY })]);
    assert.equal(nowEmptyReason(null, null), "—");
    assert.equal(nowEmptyReason({ ...up, connected: false }, null), "ProVideoPlayer offline");
    assert.equal(nowEmptyReason(up, null), "Nothing on screen");
    assert.equal(nowEmptyReason(up, "Graphics"), "Nothing on this layer");
    assert.equal(nowEmptyReason(up, "Typo"), "No layer named Typo");
  });

  test("the progress rule is switchable, and the TIME is not behind the switch", () => {
    const off = draw(status([layer()]), { showProgress: false });
    assert.ok(!off.includes("data-readout-meter"), off);
    assert.ok(off.includes("0:10"), `switching the rule off took the time with it:\n${off}`);
  });
});

describe("the next cue", () => {
  test("names the following playlist entry, under everything else", () => {
    const html = draw(status([layer()]));
    assert.ok(html.includes("CLEAR GRAPHIC"), html);
  });

  test("switched off, it is not drawn at all", () => {
    const html = draw(status([layer()]), { showNextCue: false });
    assert.ok(!html.includes("CLEAR GRAPHIC"), html);
    // and the rest of the widget is untouched
    assert.ok(html.includes("loop_a.mp4"), html);
  });

  test("END OF PLAYLIST DRAWS NOTHING, not an empty label", () => {
    // `nextCueName` is null at the end of a playlist. A "Next" with nothing after
    // it reads as a cue whose name failed to load.
    const html = draw(status([layer({ nextCueName: null })]));
    assert.ok(!/Next/.test(html), `drew a Next label with no cue behind it:\n${html}`);
    assert.ok(html.includes("loop_a.mp4"), html);
  });
});
