// Two ProVideoPlayer layers with one name.
//
// PVP allows it (pvp-parse.ts passes every name through), and every reader that
// takes a layer by name used to answer it its own way: the Home Assistant switch
// read unknown, while the action and the automation condition each took
// whichever layer PVP happened to list first. A rule conditioned on "Lyrics is
// hidden" then judged a layer nobody chose, and the cue that hides "Lyrics" hid
// one of two. One lookup now (findPvpLayer in main/types/pvp.ts), and one rule:
// a duplicated name is refused, never resolved to the first hit.
//
// Each case runs with the two layers in BOTH orders, since an answer that
// depends on PVP's list order is exactly the bug.

import { strict as assert } from "node:assert";
import { describe, test, beforeEach } from "node:test";

import { PVP_ACTIONS, pvpDeps } from "./pvp-actions.js";
import { AUTOMATION_CONDITIONS } from "./automation-conditions.js";
import { AUTOMATION_TRIGGERS } from "./automation-triggers.js";
import type { PvpLayerDTO } from "../types/pvp.js";
import type { ActionResult, ConditionCtx } from "../types/automation.js";

const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Lyrics", index: 0, state: "video",
  mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: null, lastCueUuid: null, nextCueName: null,
  mediaSinceAt: null,
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 1, durationSec: 20,
  ...over,
});

const shown = layer({ uuid: "a", index: 0, hidden: false });
const hidden = layer({ uuid: "b", index: 1, name: " lyrics ", hidden: true, state: "empty" });
const ORDERS: [string, PvpLayerDTO[]][] = [
  ["shown first", [shown, hidden]],
  ["hidden first", [hidden, shown]],
];

describe("a duplicated PVP layer name is refused, whatever PVP's order", () => {
  for (const [order, layers] of ORDERS) {
    test(`the "is hidden" condition does not hold (${order})`, () => {
      const ctx = { pvpLayers: layers } as unknown as ConditionCtx;
      assert.equal(AUTOMATION_CONDITIONS["pvp.layer-is-hidden"].holds(ctx, { layer: "Lyrics" }, 0), false);
      assert.equal(AUTOMATION_CONDITIONS["pvp.layer-has-content"].holds(ctx, { layer: "Lyrics" }, 0), false);
    });

    test(`a trigger on the name does not fire when one of them clears (${order})`, () => {
      // Found by grepping past the audit's seven sites: the PVP triggers match a
      // layer param per layer, so "Lyrics cleared" fired when either did.
      const snap = (ls: PvpLayerDTO[]) => ({ connected: true, layers: ls });
      const cleared = layers.map((l) => (l === shown ? { ...l, state: "empty" as const, mediaUuid: null } : l));
      const fire = AUTOMATION_TRIGGERS["pvp.layer-cleared"].didFire;
      assert.equal(fire(snap(layers), snap(cleared), { layer: "Lyrics" }, 0), false);
      // Blank still means any layer.
      assert.equal(fire(snap(layers), snap(cleared), { layer: "" }, 0), true);
    });

    describe(`the hide action refuses and sends nothing (${order})`, () => {
      let posted: string[] = [];
      beforeEach(() => {
        posted = [];
        pvpDeps.readLayers = async () => layers;
        pvpDeps.command = async (path): Promise<ActionResult> => {
          posted.push(path);
          return { ok: true, detail: "sent" };
        };
      });

      test("refused, naming the duplicate", async () => {
        const r = await PVP_ACTIONS["pvp.hide-layer"].run({ layer: "Lyrics" }, { simulate: false });
        assert.equal(r.ok, false);
        assert.match(r.detail, /2 layers are called "Lyrics"/);
        assert.deepEqual(posted, []);
      });
    });
  }
});

describe("the duplicate is said in the server log, once", () => {
  test("named on the first read, quiet while it lasts, and said again when it is gone", async () => {
    const { pvpService } = await import("./pvp-service.js");
    // Through emitFresh, which every successful read goes through, so a read
    // path that stopped asking would fail here.
    let readAt = Date.now();
    const note = (layers: PvpLayerDTO[]) =>
      (pvpService as unknown as { emitFresh(l: PvpLayerDTO[], at: number): void }).emitFresh(layers, ++readAt);
    const lines: string[] = [];
    const { warn, log } = console;
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      note([shown, hidden]);
      note([hidden, shown]);
      note([shown, layer({ uuid: "c", name: "Graphics" })]);
    } finally {
      console.warn = warn;
      console.log = log;
    }
    assert.deepEqual(lines, [
      '[pvp] more than one layer is called "Lyrics": cues, rules, switches and widgets that name it will not pick one until it is renamed',
      "[pvp] every layer name is unique again",
    ]);
  });
});
