// What the PVP surfaces actually put on a screen.
//
// Rendered, not reasoned about. The defect this file exists to catch is a widget
// that renders perfectly and says something untrue: `playingItem` is RESIDUAL —
// four idle layers were observed simultaneously naming the same cue while
// displaying nothing — so a row that drew it would tell an operator five layers
// were live when one was. That is not visible in any assertion about props.
//
// renderToStaticMarkup rather than a DOM: PvpLayerRow takes everything by prop
// and holds no effect, so the markup IS the behaviour and there is nothing for a
// jsdom to add.
//
// WHAT THIS FILE DELIBERATELY DOES NOT TEST, because jsdom cannot see it:
// overflow, clipping, the "+N more" count, and the rendered WIDTH of the
// hairline rule. clientHeight and offsetTop are 0 for every element here, so any
// assertion about them would pass on every bug.
//
// Those were driven in a real browser against a live ProVideoPlayer instead, at
// 1920x1080 on a wall canvas. What that found, and what it settled:
//
//   - Eleven layers in a 257x159 tile draw four rows and say "+7 more"; eight in
//     a 620x300 tile say "+3 more"; all eleven fit an 880x640 tile and it says
//     nothing.
//   - THE ROW'S FLEX WAS WRONG and only a browser could say so. With the values
//     group held at charger-battery's `shrink-0`, a 36-character PVP file name
//     in a narrow tile rendered every layer NAME at exactly 0px — measured, all
//     three of them — because the values refused to give any width back. With
//     both sides shrinking the same names measure 33-39px and truncate. jsdom
//     reports 0 for both, so no assertion here could have caught it.
//   - The hairline reads as a hairline at wall size and its fill tracks the
//     fraction. Its track had to become a color-mix of the ink in use: a stage
//     canvas is not inside .kiosk-surface, so a neutral token resolved to the
//     LIGHT theme's grey under a white bar on a black card.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { parseWorkspace } from "@main/services/pvp-parse";
import { PvpLayerRow, rowQualifiers } from "./pvp-layer-row.js";
import { PvpObject, emptyReason, visibleLayers } from "./pvp-object.js";
import type { PvpLayerDTO, PvpStatusDTO } from "@main/types/pvp";
import type { LayoutObjectConfig } from "@main/types/stage";

type Config = Extract<LayoutObjectConfig, { type: "pvp-layers" }>;

const FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("../../main/services/fixtures/pvp-workspace.json", import.meta.url), "utf8"),
);
const FIXTURE_LAYERS = parseWorkspace(FIXTURE);

const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Graphics", index: 0, state: "video",
  mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC", lastCueUuid: "c1", nextCueName: null,
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 10, durationSec: 20,
  ...over,
});

const T = "2026-08-30T12:00:00.000Z";
const AT = Date.parse(T);

const draw = (l: PvpLayerDTO, showProgress = true): string =>
  renderToStaticMarkup(
    <PvpLayerRow layer={l} sampledAt={T} now={AT} skewMs={0} showProgress={showProgress} />,
  );

const EMPTY = {
  state: "empty" as const, mediaName: null, mediaUuid: null,
  anchorElapsedSec: null, durationSec: null,
};

/** A still: media present, rate 0, and NO remaining time — so parseWorkspace
 *  gives it no duration. This is the shape a PNG on a layer actually has. */
const STILL = {
  state: "still" as const, mediaName: "slide_b.png", playbackRate: 0,
  anchorElapsedSec: 0, durationSec: null,
};

/** A paused clip: rate 0 like a still, but it keeps the rest of itself to play.
 *  Only the duration tells the two apart. */
const PAUSED = { playbackRate: 0, mediaName: "bumper.mp4", anchorElapsedSec: 12, durationSec: 20 };

describe("PvpLayerRow — the five states in the approved table", () => {
  test("a rolling video: media, then the time left, and no state word", () => {
    const html = draw(layer());
    assert.ok(html.includes("loop_a.mp4"), html);
    assert.ok(html.includes("0:10"), html);
    assert.deepEqual(rowQualifiers(layer(), true), []);
  });

  test("a still: media, then the word still, AND NO COUNTDOWN AT ALL", () => {
    // THE guard. A still reports isPlaying TRUE with playbackRate 0 and
    // timeRemaining 0, so a row that timed it would put 0:00 under a graphic
    // that is up indefinitely — a countdown to nothing. Reintroducing that means
    // keying the countdown on isPlaying, which is why the DTO does not carry it.
    const html = draw(layer(STILL));
    assert.ok(html.includes("slide_b.png"), html);
    // On the PURE helper, not on `html.includes("still")` — the fixture's own
    // media name used to be `still_b.png`, so that assertion was satisfied by
    // the file name and stayed green with the qualifier deleted.
    assert.deepEqual(rowQualifiers(layer(STILL), false), ["still"]);
    assert.ok(!/[0-9]:[0-9][0-9]/.test(html), `a still drew a countdown:\n${html}`);
    assert.ok(!html.includes("data-pvp-bar"), `a still drew a progress rule:\n${html}`);
  });

  test("a paused clip KEEPS its duration and stops the number", () => {
    const html = draw(layer(PAUSED));
    assert.ok(html.includes("bumper.mp4"), html);
    assert.ok(html.includes("0:08"), html);
    assert.ok(html.includes("paused"), html);
    // Not "still": a paused clip has the rest of itself to play, and calling it
    // a still is what once made its bar and its countdown vanish mid-service.
    assert.deepEqual(rowQualifiers(layer(PAUSED), true), ["paused"]);
  });

  test("an empty layer reads `empty`, and NEVER its residual cue name", () => {
    // THE finding. playingItem never clears, so four idle layers were observed
    // all naming the same cue while showing nothing. A row that drew it would
    // tell an operator five layers were live when one was.
    const html = draw(layer(EMPTY));
    assert.ok(/empty/i.test(html), html);
    assert.ok(!html.includes("MAIN GRAPHIC"), `an empty layer drew its stale cue:\n${html}`);
    assert.ok(!html.includes("loop_a.mp4"), html);
  });

  test("a hidden layer says so — live content nobody can see", () => {
    assert.ok(/hidden/i.test(draw(layer({ hidden: true }))), draw(layer({ hidden: true })));
    // Faded to nothing is hidden by any useful definition; a partial fade keeps
    // its number, because that is a look somebody chose.
    assert.deepEqual(rowQualifiers(layer({ opacity: 0 }), true), ["hidden"]);
    assert.deepEqual(rowQualifiers(layer({ opacity: 0.5 }), true), ["50%"]);
    assert.deepEqual(rowQualifiers(layer(), true), [], "a fully opaque layer wears a permanent 100%");
  });

  test("muted is its own word: the picture is up, the sound is not", () => {
    assert.deepEqual(rowQualifiers(layer({ muted: true }), true), ["muted"]);
  });

  test("LAST CUE IS GONE FROM THE ROW, on a live layer too", () => {
    // It was the loudest text on the tile and it is the least trustworthy field
    // PVP reports: measured live, media LoopGraphic_1_HeisWorthy.mp4 under a cue
    // reading SERIES GRAPHIC. It survives on the DTO for actions to verify
    // against and for the next-cue lookup, and nothing draws it here.
    assert.ok(!draw(layer()).includes("MAIN GRAPHIC"), draw(layer()));
  });
});

describe("what decides `rolling`", () => {
  test("playbackRate, NOT isPlaying — the whole reason the DTO drops isPlaying", () => {
    // The two disagree on exactly one state and it is the common one: a still
    // reports isPlaying true. Test it through the parser, which is where the
    // decision is actually made, so the guard fails on the real bug rather than
    // on a re-statement of the DTO.
    const stillJson = {
      data: [{
        transportState: {
          isPlaying: true, isScrubbing: false, playbackRate: 0,
          timeElapsed: 0, timeRemaining: 0,
          playingItem: { name: "GRAPHIC", uuid: "c9" },
          playingMedia: { name: "slide.png", uuid: "m9" },
          layer: { name: "Lyric Strip", uuid: "u9", isHidden: false, isMuted: false, opacity: 1 },
        },
      }],
    };
    const [l] = parseWorkspace(stillJson);
    assert.equal(l.state, "still", "isPlaying:true with rate 0 is a STILL, not a rolling clip");
    assert.equal(l.durationSec, null, "a still must have no duration to count down");
    assert.ok(!/[0-9]:[0-9][0-9]/.test(draw(l)), `a still drew a countdown:\n${draw(l)}`);
  });
});

describe("the hairline rule", () => {
  test("is behind showProgress — and the TIME never is", () => {
    // The time remaining is the reading this widget exists for. Hiding it behind
    // the rule's switch is how a countdown that was never drawn would read as
    // one PVP was not reporting.
    const off = draw(layer(), false);
    assert.ok(!off.includes("data-pvp-bar"), off);
    assert.ok(off.includes("0:10"), `switching the bar off took the time with it:\n${off}`);
    assert.ok(draw(layer(), true).includes("data-pvp-bar"));
  });

  test("its width is the fraction, not a fixed sliver", () => {
    // A rule drawn at a constant width renders and means nothing, which is the
    // failure mode this whole file is aimed at. The RENDERED width — what it
    // looks like at a tile size — is not checkable here and was driven in a
    // browser instead.
    assert.ok(draw(layer({ anchorElapsedSec: 5 })).includes("width:25%"), draw(layer({ anchorElapsedSec: 5 })));
    assert.ok(draw(layer({ anchorElapsedSec: 15 })).includes("width:75%"), draw(layer({ anchorElapsedSec: 15 })));
  });
});

describe("visibleLayers", () => {
  const c = (over: Partial<Config> = {}): Config => ({ type: "pvp-layers", ...over });

  test("with-content drops the empty layers, which is the useful default", () => {
    const shown = visibleLayers(FIXTURE_LAYERS, c({ show: "with-content" }));
    assert.deepEqual(shown.map((l) => l.name), ["Graphics", "Lower third"]);
  });

  test("an unset show behaves as with-content", () => {
    assert.deepEqual(
      visibleLayers(FIXTURE_LAYERS, c()).map((l) => l.name),
      ["Graphics", "Lower third"],
    );
  });

  test("all shows all of them, empties included", () => {
    assert.equal(visibleLayers(FIXTURE_LAYERS, c({ show: "all" })).length, 4);
  });

  test("one with no layer chosen shows NOTHING, not everything", () => {
    // Falling back to every layer would look like the filter had been ignored.
    assert.deepEqual(visibleLayers(FIXTURE_LAYERS, c({ show: "one", layerName: "" })), []);
    assert.deepEqual(visibleLayers(FIXTURE_LAYERS, c({ show: "one", layerName: null })), []);
  });

  test("one matches the layer name case-insensitively and ignores stray spaces", () => {
    const shown = visibleLayers(FIXTURE_LAYERS, c({ show: "one", layerName: "  graphics " }));
    assert.deepEqual(shown.map((l) => l.name), ["Graphics"]);
  });

  test("one shows a named EMPTY layer, because that is what was asked for", () => {
    // Unlike with-content. An operator who names a layer wants to know it is
    // empty, not to have the row silently vanish.
    const shown = visibleLayers(FIXTURE_LAYERS, c({ show: "one", layerName: "Exit screen" }));
    assert.deepEqual(shown.map((l) => l.state), ["empty"]);
  });
});

describe("emptyReason", () => {
  const c = (over: Partial<Config> = {}): Config => ({ type: "pvp-layers", ...over });
  const up: PvpStatusDTO = { connected: true, layers: [], sampledAt: T };

  test("offline, idle and not-yet-heard are THREE different answers", () => {
    // One message for all of them would send an operator looking for a fault in
    // the wrong machine, or none at all. null is the one that is easiest to get
    // wrong: it means "no snapshot yet", not "PVP is down", and calling it
    // offline would make every display accuse PVP for the moment before its
    // first hydrate.
    assert.equal(emptyReason(null, c()), "—");
    assert.equal(emptyReason({ ...up, connected: false }, c()), "ProVideoPlayer offline");
    assert.equal(emptyReason(up, c()), "Nothing on screen");
  });

  test("a 'one layer' object says which of the two things is wrong", () => {
    assert.equal(emptyReason(up, c({ show: "one" })), "No layer chosen");
    assert.equal(emptyReason(up, c({ show: "one", layerName: "Typo" })), "No layer named Typo");
  });
});

describe("PvpObject", () => {
  const render = (config: Config, status: PvpStatusDTO | null): string =>
    renderToStaticMarkup(<PvpObject config={config} status={status} now={AT} skewMs={0} H={1080} />);
  const live: PvpStatusDTO = { connected: true, layers: FIXTURE_LAYERS, sampledAt: T };

  test("draws one row per visible layer", () => {
    const html = render({ type: "pvp-layers", show: "with-content" }, live);
    assert.ok(html.includes("loop_a.mp4"), html);
    assert.ok(html.includes("still_b.png"), html);
    // The empty layer is filtered out, so its residual cue cannot appear either.
    assert.ok(!html.includes("Exit screen"), html);
  });

  test("SHOWING ALL LAYERS DRAWS NO CUE NAME AT ALL", () => {
    // The fixture's empty layers name the SAME cue as the playing one, exactly
    // as the live workspace did. The row no longer draws a cue on any layer, so
    // it appears zero times rather than once.
    const html = render({ type: "pvp-layers", show: "all" }, live);
    assert.ok(html.includes("Exit screen"), html);
    assert.equal(html.split("MAIN GRAPHIC").length - 1, 0, html);
  });

  test("hideWhenEmpty renders NOTHING, not an empty box", () => {
    assert.equal(render({ type: "pvp-layers", show: "with-content", hideWhenEmpty: true }, null), "");
  });

  test("without hideWhenEmpty it says why it is empty", () => {
    const offline: PvpStatusDTO = { connected: false, layers: [], sampledAt: null };
    assert.ok(render({ type: "pvp-layers", show: "with-content" }, offline).includes("ProVideoPlayer offline"));
    // And before the first snapshot it does not accuse PVP of anything.
    assert.ok(!render({ type: "pvp-layers", show: "with-content" }, null).includes("offline"));
  });

  test("EVERY visible layer is rendered, never a slice of them", () => {
    // The property that keeps the clipped-row count honest. The box clips the
    // overflow and useClippedRows counts what fell off the bottom — so if this
    // component ever sliced the list to what it thought would fit, the next
    // measurement would be reading its own output and would settle on whatever
    // it happened to render first.
    //
    // What this canNOT check, said plainly: the count itself. jsdom has no
    // layout engine, so clientHeight and offsetTop are 0 for every element and
    // any assertion about the "+N more" label would pass on every bug. It was
    // verified in a real browser instead — see the browser notes in the PR.
    const html = render({ type: "pvp-layers", show: "all" }, live);
    for (const l of FIXTURE_LAYERS) assert.ok(html.includes(l.name), `${l.name} was not rendered`);
  });

  test("showProgress is in the row-shape signature, so the +N count cannot go stale", () => {
    // The rule changes a row's HEIGHT, and useClippedRows re-measures on the
    // shape string rather than on a row count for exactly that reason. A
    // previous change forgot to put a height-affecting option in the signature
    // and left the count frozen until the next real cue change.
    //
    // The signature is built inside the component, so this asserts the OBSERVABLE
    // consequence: the two settings produce different markup, which is what makes
    // the string differ and what makes the observer fire.
    const on = render({ type: "pvp-layers", show: "all", showProgress: true }, live);
    const off = render({ type: "pvp-layers", show: "all", showProgress: false }, live);
    assert.notEqual(on, off, "toggling the rule changed nothing, so nothing would re-measure");
    assert.ok(on.includes("data-pvp-bar") && !off.includes("data-pvp-bar"));
  });
});

// ── The Home card's not-yet-heard state ─────────────────────────────────────
//
// It rendered the seven literal characters `—` on the operator's front
// page. JSX attribute literals do not process escapes, and nothing covered
// PvpCard at all, so a bug visible from across the room shipped.
//
// renderToStaticMarkup runs the component synchronously and does not run
// effects, so `usePvpState` has not hydrated yet and the card is in exactly the
// state that was broken.

describe("PvpCard before the first snapshot", () => {
  test("DRAWS ONE DASH, NOT THE CHARACTERS OF AN ESCAPE SEQUENCE", async () => {
    const { PvpCard } = await import("../app/home/cards.js");
    const html = renderToStaticMarkup(<PvpCard now={AT} />);
    assert.ok(!html.includes("u2014"), `the card rendered an escape sequence:\n${html}`);
    assert.ok(html.includes("—"), `the card did not render a dash:\n${html}`);
    // And it does not accuse PVP of being down before it has heard anything.
    assert.ok(!/offline/i.test(html), html);
  });
});
