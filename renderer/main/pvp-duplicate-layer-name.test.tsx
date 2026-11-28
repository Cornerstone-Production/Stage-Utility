// Two ProVideoPlayer layers with one name, on the wall.
//
// The server refuses a duplicated name (see
// main/services/pvp-duplicate-layer-name.test.ts), and the two widgets that
// take a layer by name used to disagree with it and with each other: the Now
// widget showed whichever layer PVP listed first, and the list object's "one
// layer" mode drew both. Both now say the name is ambiguous and show neither,
// whatever PVP's order.
//
// Not covered here: how the sentence fits a tile. jsdom has no layout, so a
// sub-line cut off mid-word passes any assertion on the markup. Both widgets
// were looked at in Chrome on a wall at about 480x180 per tile, where the
// sentences fit; the 257x159 tile pvp-now.test.tsx names, and the Home card,
// were not.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PvpNowObject, chooseNowLayer, nowEmptyReason, type PvpNowConfig } from "./pvp-now.js";
import { emptyReason, visibleLayers } from "./pvp-object.js";
import { pvpLayerOptions } from "../editor/inspector.js";
import type { LayoutObjectConfig } from "@main/types/stage";
import type { PvpLayerDTO, PvpStatusDTO } from "@main/types/pvp";

const T = "2026-08-30T12:00:00.000Z";

const layer = (over: Partial<PvpLayerDTO>): PvpLayerDTO => ({
  uuid: "l1", name: "Lyrics", index: 0, state: "video",
  mediaName: "verse_one.mp4", mediaUuid: "m1", lastCueName: null, lastCueUuid: null, nextCueName: null,
  mediaSinceAt: null,
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 10, durationSec: 20,
  ...over,
});

const first = layer({ uuid: "a", index: 0 });
const second = layer({ uuid: "b", index: 1, name: "LYRICS ", mediaName: "chorus.mp4", mediaUuid: "m2" });
const ORDERS: [string, PvpLayerDTO[]][] = [
  ["verse first", [first, second]],
  ["chorus first", [second, first]],
];

const status = (layers: PvpLayerDTO[]): PvpStatusDTO => ({ connected: true, layers, sampledAt: T, imageDurationSec: null });
type ListConfig = Extract<LayoutObjectConfig, { type: "pvp-layers" }>;
const one: ListConfig = { type: "pvp-layers", show: "one", layerName: "Lyrics" };

describe("a duplicated layer name shows neither layer, whatever PVP's order", () => {
  for (const [order, layers] of ORDERS) {
    test(`the Now widget pinned to it (${order})`, () => {
      assert.equal(chooseNowLayer(layers, "Lyrics"), null);
      assert.equal(nowEmptyReason(status(layers), "Lyrics"), "More than one layer has this name");
      const config = { type: "pvp-now", layerName: "Lyrics" } as PvpNowConfig;
      const html = renderToStaticMarkup(<PvpNowObject config={config} status={status(layers)} now={Date.parse(T)} />);
      assert.ok(!html.includes("verse_one") && !html.includes("chorus"), html);
      assert.ok(html.includes("duplicate"), html);
    });

    test(`the inspector's layer picker offers the name once, as a duplicate (${order})`, () => {
      // Two options with one value was what the picker drew before: React
      // warned about the repeated key, and the Select could only ever show the
      // first of them as chosen.
      const other = layer({ uuid: "c", index: 2, name: "Graphics" });
      assert.deepEqual(pvpLayerOptions([...layers, other]), [
        { name: layers[0].name, word: "duplicate" },
        { name: "Graphics", word: "playing" },
      ]);
    });

    test(`the list object's one-layer mode (${order})`, () => {
      assert.deepEqual(visibleLayers(layers, one), []);
      assert.equal(emptyReason(status(layers), one), "More than one layer is named Lyrics");
    });
  }
});
