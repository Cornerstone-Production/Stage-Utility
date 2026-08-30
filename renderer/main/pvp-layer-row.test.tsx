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

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { parseWorkspace } from "@main/services/pvp-parse";
import { PvpLayerRow } from "./pvp-layer-row.js";
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
  mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC",
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 10, durationSec: 20,
  ...over,
});

const T = "2026-08-30T12:00:00.000Z";
const AT = Date.parse(T);

const draw = (l: PvpLayerDTO, compact = false): string =>
  renderToStaticMarkup(
    <PvpLayerRow layer={l} sampledAt={T} now={AT} skewMs={0} showProgress compact={compact} />,
  );

const EMPTY = {
  state: "empty" as const, mediaName: null, mediaUuid: null,
  anchorElapsedSec: null, durationSec: null,
};

describe("PvpLayerRow", () => {
  test("a playing layer names its media and its cue", () => {
    const html = draw(layer());
    assert.ok(html.includes("loop_a.mp4"), html);
    assert.ok(html.includes("MAIN GRAPHIC"), html);
  });

  test("AN EMPTY LAYER NEVER DRAWS ITS RESIDUAL CUE NAME", () => {
    // THE finding. playingItem never clears, so four idle layers were observed
    // all naming the same cue while showing nothing. A row that drew it would
    // tell an operator five layers were live when one was.
    const html = draw(layer(EMPTY));
    assert.ok(!html.includes("MAIN GRAPHIC"), `an empty layer drew its stale cue:\n${html}`);
  });

  test("an empty layer says so, rather than rendering blank", () => {
    assert.ok(/Empty/i.test(draw(layer(EMPTY))), draw(layer(EMPTY)));
  });

  test("a still draws no progress bar", () => {
    // A still reports timeRemaining 0. A bar for it would sit at an end and read
    // as a clip that had finished.
    const html = draw(layer({ state: "still", mediaName: "still_b.png", playbackRate: 0, durationSec: null }));
    assert.ok(!html.includes("data-pvp-bar"), html);
    assert.ok(html.includes("still_b.png"), html);
  });

  test("a rolling video draws a bar and the time left", () => {
    const html = draw(layer());
    assert.ok(html.includes("data-pvp-bar"), html);
    assert.ok(html.includes("0:10"), html);
  });

  test("the bar's width is the fraction, not a fixed sliver", () => {
    // A bar drawn at a constant width renders and means nothing, which is the
    // failure mode this whole file is aimed at.
    assert.ok(draw(layer({ anchorElapsedSec: 5 })).includes("width:25%"), draw(layer({ anchorElapsedSec: 5 })));
    assert.ok(draw(layer({ anchorElapsedSec: 15 })).includes("width:75%"), draw(layer({ anchorElapsedSec: 15 })));
  });

  test("hidden, muted and faded each get a badge", () => {
    const html = draw(layer({ hidden: true, muted: true, opacity: 0.5 }));
    assert.ok(/Hidden/i.test(html), html);
    assert.ok(/Muted/i.test(html), html);
    assert.ok(html.includes("50%"), html);
  });

  test("a fully opaque layer gets NO opacity badge", () => {
    // Otherwise every layer on the wall wears a permanent "100%".
    assert.ok(!draw(layer()).includes("100%"), draw(layer()));
  });

  test("compact drops the bar and the cue line, and KEEPS the time left", () => {
    // Home's tile carries up to three of these. Three bars is a texture, not a
    // reading, and the cue line would double the height of every row — but "how
    // long is left" is the thing worth having, and the Home card's own blurb
    // promises it, so dropping the time along with the bar would have made that
    // blurb a lie.
    const html = draw(layer(), true);
    assert.ok(html.includes("loop_a.mp4"), html);
    assert.ok(!html.includes("data-pvp-bar"), html);
    assert.ok(!html.includes("MAIN GRAPHIC"), html);
    assert.ok(html.includes("0:10"), `compact lost the time remaining:\n${html}`);
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
    assert.equal(emptyReason(null, c()), "\u2014");
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
    renderToStaticMarkup(<PvpObject config={config} status={status} now={AT} skewMs={0} />);
  const live: PvpStatusDTO = { connected: true, layers: FIXTURE_LAYERS, sampledAt: T };

  test("draws one row per visible layer", () => {
    const html = render({ type: "pvp-layers", show: "with-content" }, live);
    assert.ok(html.includes("loop_a.mp4"), html);
    assert.ok(html.includes("still_b.png"), html);
    // The empty layer is filtered out, so its residual cue cannot appear either.
    assert.ok(!html.includes("Exit screen"), html);
  });

  test("SHOWING ALL LAYERS STILL NEVER DRAWS AN EMPTY ONE'S RESIDUAL CUE", () => {
    // The fixture's empty layer names the SAME cue as the playing one, exactly
    // as the live workspace did. So "MAIN GRAPHIC" appears once, for the layer
    // that is actually showing it — not twice.
    const html = render({ type: "pvp-layers", show: "all" }, live);
    assert.ok(html.includes("Exit screen"), html);
    assert.equal(html.split("MAIN GRAPHIC").length - 1, 1, html);
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
    // verified in a real browser instead — eleven layers in a 247x153 tile draw
    // three and say "+8 more"; nine in a 517x208 tile draw three and say
    // "+6 more"; eleven in a 1108x779 tile draw all eleven and say nothing.
    const html = render({ type: "pvp-layers", show: "all" }, live);
    for (const l of FIXTURE_LAYERS) assert.ok(html.includes(l.name), `${l.name} was not rendered`);
  });

  test("showProgress off drops the bar but keeps the layers", () => {
    const html = render({ type: "pvp-layers", show: "all", showProgress: false }, live);
    assert.ok(html.includes("loop_a.mp4"), html);
    assert.ok(!html.includes("data-pvp-bar"), html);
  });
});
