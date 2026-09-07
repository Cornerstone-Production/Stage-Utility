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

import {
  PvpNowObject, chooseNowLayer, nowBadge, nowEmptyReason, pinnedLayerExists,
  pvpNowLabel, stripExtension, PVP_NOW_CAPTION, type PvpNowConfig,
} from "./pvp-now.js";
import type { PvpLayerDTO, PvpStatusDTO } from "@main/types/pvp";

const T = "2026-08-30T12:00:00.000Z";
const AT = Date.parse(T);

const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Graphics", index: 0, state: "video",
  mediaName: "loop_a.mp4", mediaUuid: "m1",
  lastCueName: "MAIN GRAPHIC", lastCueUuid: "cue-0001", nextCueName: "CLEAR GRAPHIC",
  mediaSinceAt: null,
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

const status = (layers: PvpLayerDTO[], over: Partial<PvpStatusDTO> = {}): PvpStatusDTO => ({
  connected: true, layers, sampledAt: T, imageDurationSec: null, ...over,
});

const draw = (
  s: PvpStatusDTO | null,
  config: PvpNowConfig = {},
): string => renderToStaticMarkup(<PvpNowObject config={config} status={s} now={AT} skewMs={0} />);

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
    assert.equal(nowBadge(l), "playing");
  });

  test("a still is `still`: it is up, and it is not counting", () => {
    const l = layer(STILL);
    assert.equal(nowBadge(l), "still");
  });

  test("a paused clip is `paused`: rate 0, but it kept its duration", () => {
    const l = layer({ playbackRate: 0, anchorElapsedSec: 12, durationSec: 20 });
    assert.equal(nowBadge(l), "paused");
  });

  test("an ended clip is `ended`, never `playing` despite playbackRate > 0", () => {
    // GUARD: real PVP output for a clip that ran out is playbackRate: 1,
    // timeRemaining: 0, timeElapsed > 0, isPlaying: false — which parseWorkspace
    // now reads as "ended". Reading playbackRate alone (the pre-fix behaviour)
    // reports "playing" here, which is the exact bug this state exists to fix.
    const l = layer({ state: "ended", playbackRate: 1, anchorElapsedSec: 7.97, durationSec: null });
    assert.equal(nowBadge(l), "ended");
  });

  test("nothing on the layer is `empty`", () => {
    assert.equal(nowBadge(layer(EMPTY)), "empty");
    assert.equal(nowBadge(null), "empty");
  });

  test("a pinned name PVP is not reporting is `not found`, checked before content", () => {
    assert.equal(nowBadge(null, false), "not found");
    // found=false wins even if a layer happened to be passed in.
    assert.equal(nowBadge(layer(), false), "not found");
  });
});

describe("pinnedLayerExists", () => {
  const three = [layer({ uuid: "a", name: "Top" }), layer({ uuid: "b", name: "Middle" })];
  test("an unpinned widget (blank name) has no notion of not-found", () => {
    assert.equal(pinnedLayerExists(three, null), true);
    assert.equal(pinnedLayerExists(three, "  "), true);
  });
  test("matched trimmed and case-insensitive, like chooseNowLayer", () => {
    assert.equal(pinnedLayerExists(three, " top "), true);
    assert.equal(pinnedLayerExists(three, "TOP"), true);
  });
  test("a name matching nothing live is false", () => {
    assert.equal(pinnedLayerExists(three, "Typo"), false);
  });
});

describe("what it draws", () => {
  test("the caption names the widget, which is the whole point of it", () => {
    assert.ok(draw(status([layer()])).includes(PVP_NOW_CAPTION));
  });

  test("a rolling clip: COUNTDOWN leads as the value, file + total in the sub", () => {
    // Option A: the countdown takes the value slot while there is one, and the
    // file name (with its total length) steps down to the sub-line.
    const html = draw(status([layer()]));
    assert.ok(html.includes("0:10"), html);
    assert.ok(html.includes("loop_a.mp4"), html);
    assert.ok(html.includes("0:20"), `the clip's total length was not in the sub:\n${html}`);
    assert.ok(html.includes("playing"), html);
    assert.ok(html.includes("data-readout-meter"), html);
  });

  test("A STILL DRAWS NO COUNTDOWN AND NO RULE", () => {
    // The guard. Delete the `progress ?` and a graphic that is up indefinitely
    // starts counting down to nothing. With no countdown the value falls back to
    // the cue name (same rule as compact), and the file name moves to the sub
    // only because it differs from that value.
    const html = draw(status([layer(STILL)]));
    assert.ok(html.includes("MAIN GRAPHIC"), `the cue name was not the value:\n${html}`);
    assert.ok(html.includes("slide.png"), html);
    assert.ok(!/[0-9]:[0-9][0-9]/.test(html), `a still drew a countdown:\n${html}`);
    assert.ok(!html.includes("data-readout-meter"), `a still drew a progress rule:\n${html}`);
    assert.ok(!html.includes("no duration"), `a still still says "no duration":\n${html}`);
  });

  test("an ended clip reads `ended`, not `playing` — and draws no countdown", () => {
    const ENDED = {
      state: "ended" as const, mediaName: "speaker_bumper.mov", lastCueName: null,
      playbackRate: 1, anchorElapsedSec: 7.97, durationSec: null,
    };
    const html = draw(status([layer(ENDED)]));
    assert.ok(html.includes("ended"), html);
    assert.ok(!html.includes("playing"), `an ended clip's rate > 0 read as playing:\n${html}`);
    assert.ok(!/[0-9]:[0-9][0-9]/.test(html), `an ended clip drew a countdown:\n${html}`);
    // lastCueName is null here, so the value falls back to the file name.
    assert.ok(html.includes("speaker_bumper"), html);
  });

  test("an empty layer says so plainly, never a countdown to nothing", () => {
    const html = draw(status([layer(EMPTY)]));
    assert.ok(html.includes("Nothing on screen"), html);
    assert.ok(!/[0-9]:[0-9][0-9]/.test(html), html);
    // And never the residual cue name, which never clears.
    assert.ok(!html.includes("MAIN GRAPHIC"), html);
    assert.ok(!html.includes("CLEAR GRAPHIC"), `an empty layer named a next cue:\n${html}`);
  });

  test("the five nothings are five different sentences", () => {
    const up = status([layer({ name: "Graphics", ...EMPTY })]);
    assert.equal(nowEmptyReason(null, null), "—");
    assert.equal(nowEmptyReason({ ...up, connected: false }, null), "ProVideoPlayer offline");
    assert.equal(nowEmptyReason(up, null), "Nothing on screen");
    assert.equal(nowEmptyReason(up, "Graphics"), "Nothing on this layer");
    // Never echoes the typed name back — that name is ALREADY the caption when
    // a layer is pinned (see pvpNowCaption), so repeating it here would say the
    // same word twice on a two-line tile.
    assert.equal(nowEmptyReason(up, "Typo"), "No layer by this name in PVP");
  });

  test("the progress rule is switchable, and the TIME is not behind the switch", () => {
    const off = draw(status([layer()]), { showProgress: false });
    assert.ok(!off.includes("data-readout-meter"), off);
    assert.ok(off.includes("0:10"), `switching the rule off took the time with it:\n${off}`);
  });
});

describe("countStills — opting a still into the countdown", () => {
  // 5s before AT, so a 20s hold has 15s left and a 10s hold has already run out.
  const SINCE = new Date(AT - 5000).toISOString();
  const countingStill = { ...STILL, mediaSinceAt: SINCE };

  test("off (the default): the #458 composition, unchanged — no countdown, no bar", () => {
    const html = draw(status([layer(countingStill)]));
    assert.ok(!/0:1[0-9]|0:20/.test(html), `countStills off still drew a countdown:\n${html}`);
    assert.ok(!html.includes("data-readout-meter"), `countStills off drew a progress rule:\n${html}`);
  });

  test("on: the still counts down from the card's imageDurationSec, exactly like a clip", () => {
    const html = draw(status([layer(countingStill)], { imageDurationSec: 20 }), { countStills: true });
    assert.ok(html.includes("0:15"), `expected a 15s countdown from a 20s hold, 5s in:\n${html}`);
    assert.ok(html.includes("data-readout-meter"), `countStills on drew no progress rule:\n${html}`);
    assert.ok(html.includes("slide.png"), `the file name should still be on the sub-line:\n${html}`);
  });

  test("THE GUARD: a widget's own stillHoldSec overrides the card default", () => {
    // The rule this whole feature turns on. The card says 20s (15s left); the
    // widget says 3s, which has already run OUT (0s left, 5s in) at the same
    // instant. If the widget's own number were ever ignored, this would still
    // read 0:15 — the card's own answer.
    const html = draw(
      status([layer(countingStill)], { imageDurationSec: 20 }),
      { countStills: true, stillHoldSec: 3 },
    );
    assert.ok(html.includes("0:00"), `the widget's own hold was ignored in favour of the card's:\n${html}`);
    assert.ok(!html.includes("0:15"), `the card's default leaked through the widget's own hold:\n${html}`);
  });

  test("once the hold runs out it holds at 0:00 with a full bar, never switches state", () => {
    const html = draw(status([layer(countingStill)], { imageDurationSec: 3 }), { countStills: true });
    assert.ok(html.includes("0:00"), html);
    assert.ok(html.includes("data-readout-meter"), `a finished hold should still draw its (full) bar:\n${html}`);
    assert.ok(html.includes("still"), `the state word must stay "still", never switch:\n${html}`);
  });

  test("no hold anywhere (no card default, no widget override): falls back exactly as countStills-off does", () => {
    // Nothing to count down FROM, so there is nothing to count down TO either —
    // the widget falls back to the same "on screen", counting UP, that
    // countStills-off draws. It is not counting down: the value stays the cue
    // name, not a time.
    const html = draw(status([layer(countingStill)], { imageDurationSec: null }), { countStills: true });
    assert.ok(html.includes("MAIN GRAPHIC"), `expected the value to fall back to the cue name:\n${html}`);
    assert.ok(html.includes("on screen"), `expected the 'on screen' fallback:\n${html}`);
  });

  test("compact mode: countStills on counts down; off shows nothing extra", () => {
    const on = draw(status([layer(countingStill)], { imageDurationSec: 20 }), { countStills: true, compact: true });
    assert.ok(on.includes("0:15"), on);
    const off = draw(status([layer(countingStill)], { imageDurationSec: 20 }), { countStills: false, compact: true });
    assert.ok(!off.includes("on screen"), `compact mode should show nothing extra for a non-counting still:\n${off}`);
    assert.ok(!/[0-9]:[0-9][0-9]/.test(off), `compact mode drew a countdown with countStills off:\n${off}`);
  });

  test("full mode, countStills off: the sub line gains 'on screen', counting UP", () => {
    const html = draw(status([layer(countingStill)], { imageDurationSec: 20 }));
    assert.ok(html.includes("on screen"), `expected the 'on screen' qualifier:\n${html}`);
    assert.ok(html.includes("0:05"), `expected 5s counted up since mediaSinceAt:\n${html}`);
  });

  test("a still with no mediaSinceAt at all draws neither a countdown nor 'on screen'", () => {
    const html = draw(status([layer(STILL)], { imageDurationSec: 20 }), { countStills: true });
    assert.ok(!html.includes("on screen"), html);
    assert.ok(!/[0-9]:[0-9][0-9]/.test(html), html);
  });

  test("a rolling clip is never touched by countStills", () => {
    const withIt = draw(status([layer()], { imageDurationSec: 20 }), { countStills: true });
    const withoutIt = draw(status([layer()], { imageDurationSec: 20 }), { countStills: false });
    assert.equal(withIt, withoutIt, "countStills changed a rolling clip's own countdown");
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

// ── Compact mode — the countdown-first treatment ────────────────────────────
//
// One fixture throughout: a layer whose file, cue and layer names are all
// different strings, so a test that reads the wrong one fails loudly instead
// of passing on a coincidence.
const COMPACT_LAYER = layer({
  name: "Graphics (1s)",
  mediaName: "Mark Vance - Lead Pastor.mov",
  lastCueName: "Mark Vance",
  // remainingSec = durationSec - anchorElapsedSec = 277 = "4:37", with sampledAt
  // equal to `now` so there is no drift to add.
  anchorElapsedSec: 0,
  durationSec: 277,
  playbackRate: 1,
});

describe("compact mode", () => {
  test("a playing clip: `PVP · <cue>`, the badge, and the countdown alone", () => {
    const html = draw(status([COMPACT_LAYER]), { compact: true });
    assert.ok(html.includes("PVP · Mark Vance"), html);
    assert.ok(html.includes("playing"), html);
    assert.ok(html.includes("4:37"), html);
    assert.ok(!html.includes("remaining"), `compact mode drew the "remaining" word:\n${html}`);
    // The next-cue footer never draws in compact mode, even though this
    // fixture carries one (COMPACT_LAYER inherits `nextCueName: "CLEAR GRAPHIC"`
    // from the base fixture).
    assert.ok(!/Next/.test(html), `compact mode drew a next-cue line:\n${html}`);
    assert.ok(!html.includes("CLEAR GRAPHIC"), html);
  });

  test("a still with the default Label (cue): value falls back to the OTHER name — the file", () => {
    // GUARD: this is the guard for the "never the literal 'no duration'" rule.
    // Revert pvpNowCompactValue to `progress ? ... : "no duration"` and this
    // goes red.
    const html = draw(status([layer({ ...COMPACT_LAYER, ...STILL })]), { compact: true });
    assert.ok(html.includes("PVP · Mark Vance"), `caption should still be the cue:\n${html}`);
    assert.ok(html.includes("slide"), `value should fall back to the file name:\n${html}`);
    assert.ok(html.includes("still"), html);
    assert.ok(!html.includes("no duration"), html);
    assert.ok(!/[0-9]:[0-9][0-9]/.test(html), `a compact still drew a countdown:\n${html}`);
  });

  test("a still with Label = layer: the caption's OTHER name (cue) takes the value", () => {
    const html = draw(status([layer({ ...COMPACT_LAYER, ...STILL })]), { compact: true, nowLabel: "layer" });
    assert.ok(html.includes("PVP · Graphics (1s)"), html);
    assert.ok(html.includes("Mark Vance"), `value should fall back to the cue name:\n${html}`);
    assert.ok(!html.includes("no duration"), html);
  });

  test("empty: caption is bare `PVP`, value is a dash, sub is the empty reason", () => {
    const html = draw(status([layer({ ...COMPACT_LAYER, ...EMPTY })]), { compact: true });
    assert.ok(html.includes(">PVP<"), `compact empty caption was not bare "PVP":\n${html}`);
    assert.ok(!html.includes("PVP ·"), html);
    assert.ok(html.includes("empty"), html);
    assert.ok(html.includes("—"), html);
    assert.ok(html.includes("Nothing on screen"), html);
  });

  describe("the Label choice", () => {
    test("cue: the layer's current cue name", () => {
      assert.equal(pvpNowLabel(COMPACT_LAYER, "cue"), "Mark Vance");
    });
    test("file: the media name without its extension", () => {
      assert.equal(pvpNowLabel(COMPACT_LAYER, "file"), "Mark Vance - Lead Pastor");
    });
    test("file-ext: the media name as-is", () => {
      assert.equal(pvpNowLabel(COMPACT_LAYER, "file-ext"), "Mark Vance - Lead Pastor.mov");
    });
    test("layer: the layer's own name", () => {
      assert.equal(pvpNowLabel(COMPACT_LAYER, "layer"), "Graphics (1s)");
    });
    test("cue null falls back to the file name without its extension", () => {
      assert.equal(
        pvpNowLabel({ ...COMPACT_LAYER, lastCueName: null }, "cue"),
        "Mark Vance - Lead Pastor",
      );
    });
    test("each choice reaches the drawn caption", () => {
      const withLabel = (nowLabel: "cue" | "file" | "file-ext" | "layer") =>
        draw(status([COMPACT_LAYER]), { compact: true, nowLabel });
      assert.ok(withLabel("cue").includes("PVP · Mark Vance"), withLabel("cue"));
      assert.ok(withLabel("file").includes("PVP · Mark Vance - Lead Pastor"), withLabel("file"));
      assert.ok(withLabel("file-ext").includes("PVP · Mark Vance - Lead Pastor.mov"), withLabel("file-ext"));
      assert.ok(withLabel("layer").includes("PVP · Graphics (1s)"), withLabel("layer"));
    });
  });

  describe("stripExtension", () => {
    test("drops the last extension", () => {
      assert.equal(stripExtension("Mark Vance - Lead Pastor.mov"), "Mark Vance - Lead Pastor");
    });
    test("a name with no dot is unchanged", () => {
      assert.equal(stripExtension("noext"), "noext");
    });
    test("a leading-dot name (a dotfile) is unchanged", () => {
      assert.equal(stripExtension(".hidden"), ".hidden");
    });
  });

  test("normal mode is untouched: the same fixture still leads with the countdown", () => {
    // GUARD: this is what pins the normal composition against compact-mode
    // regressions. It renders the SAME fixture COMPACT_LAYER used above, with
    // `compact` simply absent. Option A: the countdown is the VALUE, the file
    // (with its total) is the sub.
    const html = draw(status([COMPACT_LAYER]));
    assert.ok(html.includes(PVP_NOW_CAPTION), html);
    assert.ok(html.includes("4:37"), html);
    assert.ok(html.includes("Mark Vance - Lead Pastor.mov"), html);
    assert.ok(html.includes("4:37"), html);
    assert.ok(html.includes("CLEAR GRAPHIC"), html);
  });
});

// ── A pinned layer names the caption, in every state ────────────────────────
describe("a pinned layer", () => {
  test("an unreachable PVP reads empty, not 'not found' — there is no layer list to be absent from", () => {
    const html = draw(null, { layerName: "Exit screen" });
    assert.match(html, /PVP · Exit screen/);
    assert.match(html, />empty</);
    assert.doesNotMatch(html, /not found/);
  });

  test("full mode, empty: caption is `PVP · <layer>`, state word `empty`", () => {
    const html = draw(status([layer({ name: "Exit screen", ...EMPTY })]), { layerName: "Exit screen" });
    assert.ok(html.includes("PVP · Exit screen"), html);
    assert.ok(html.includes("empty"), html);
    assert.ok(html.includes("Nothing on this layer"), html);
  });

  test("compact mode, empty: caption is STILL `PVP · <layer>`, not the bare `PVP`", () => {
    // This is the one place pinning changes compact's own rule: with no name
    // pinned, an empty layer draws the bare "PVP" (nothing to borrow a label
    // from). A pinned name overrides that — the caption's whole job is to say
    // which tile this is, and it does not stop doing that just because the
    // layer is empty.
    const html = draw(status([layer({ name: "Exit screen", ...EMPTY })]), {
      layerName: "Exit screen", compact: true,
    });
    assert.ok(html.includes("PVP · Exit screen"), html);
    assert.ok(html.includes("empty"), html);
  });

  test("a name PVP is not reporting: state word `not found`, its own sentence", () => {
    const html = draw(status([layer()]), { layerName: "Typo" });
    assert.ok(html.includes("PVP · Typo"), html);
    assert.ok(html.includes("not found"), html);
    assert.ok(html.includes("No layer by this name in PVP"), html);
    // Never the word "empty" for this case — a missing layer and an idle one
    // are different problems and read different sentences.
    assert.ok(!/>empty</.test(html), html);
  });

  test("with content, the caption still names the layer, not the fixed word", () => {
    const html = draw(status([layer({ name: "Graphics" })]), { layerName: "Graphics" });
    assert.ok(html.includes("PVP · Graphics"), html);
    assert.ok(!html.includes(PVP_NOW_CAPTION), html);
  });
});
