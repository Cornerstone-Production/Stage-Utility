// A widget inside a tile is on screen, so it gets a subscription.
//
// The bug this guards: `collectLayoutTypes` recursed into container children and
// stopped there. An embedded view's objects were invisible to it, so every gate
// in `useLayoutData` — obs, reaper, SPL, transcript, OSC, wireless, people, the
// streaming trio — was computed from the outer layout alone, and a producer wall
// built from screen tiles rendered widgets that never received data. Not a wrong
// number: no number, ever, on the layout the feature exists for.
//
// These assert the SET, not "a set was returned". Two of them assert the set is
// EXACTLY what the layout needs, because the cheap way to make the positive ones
// pass is to union every view's types the moment any embed appears — which turns
// one tile into a subscription to everything, the opposite of the point.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

// layout-renderer.tsx pulls in the component tree at import time; the harness is
// installed before the dynamic import below so that evaluation has a DOM.
const teardown = installDom();
const { layoutChannelTypes } = await import("./layout-renderer.js");
const { MAX_EMBED_DEPTH } = await import("./embed-chain.js");

after(() => teardown());

const canvas = { width: 1920, height: 1080, fit: "contain" as const };

/** A view holding one object of `type`, plus whatever embeds are passed. */
function view(id: string, type: string, embeds: LayoutObject[] = []): View {
  return {
    id,
    name: id,
    kind: "custom",
    createdAt: "2026-01-01T00:00:00.000Z",
    layout: { version: 1, canvas, objects: [obj(`${id}-o`, { type }), ...embeds] },
  } as View;
}

function obj(id: string, config: Record<string, unknown>): LayoutObject {
  return { id, x: 0, y: 0, w: 1, h: 1, z: 0, config, style: {} } as unknown as LayoutObject;
}

const viewEmbed = (id: string, viewId: string | null) => obj(id, { type: "view-embed", viewId });
const screenEmbed = (id: string, outputId: string | null) => obj(id, { type: "screen-embed", outputId });

const layoutOf = (...objects: LayoutObject[]): LayoutDTO => ({ version: 1, canvas, objects });

const output = (id: string, viewId: string | null): Output => ({ id, name: id, viewId });

describe("the gates a layout computes", () => {
  test("see an obs badge that is only inside an embedded view", () => {
    const inner = view("v-inner", "obs-status");
    const types = layoutChannelTypes(layoutOf(viewEmbed("e1", "v-inner")), [inner], [], "v-outer");
    assert.ok(
      types.has("obs-status"),
      "the only obs-status in this layout is inside the embedded view, and the gate missed it",
    );
  });

  test("see a widget in a SCREEN tile, resolved through the output's routing", () => {
    const inner = view("v-routed", "spl-meter");
    const types = layoutChannelTypes(
      layoutOf(screenEmbed("e1", "out-1")),
      [inner],
      [output("out-1", "v-routed")],
      "v-outer",
    );
    assert.ok(types.has("spl-meter"), "the screen tile's routed view was never resolved");
  });

  test("see a widget nested inside a container inside a tile", () => {
    // Both recursions on one path: the container walk and the embed descent.
    const inner: View = {
      id: "v-inner",
      name: "inner",
      kind: "custom",
      createdAt: "2026-01-01T00:00:00.000Z",
      layout: {
        version: 1,
        canvas,
        objects: [
          {
            ...(obj("box", { type: "container" }) as unknown as Record<string, unknown>),
            children: [obj("r", { type: "reaper-status" })],
          } as unknown as LayoutObject,
        ],
      },
    } as View;
    const types = layoutChannelTypes(layoutOf(viewEmbed("e1", "v-inner")), [inner], [], "v-outer");
    assert.ok(types.has("reaper-status"), "a container inside a tile hid its children from the gate");
  });

  test("terminate when a view embeds ITSELF", () => {
    // The one that matters most: collectLayoutTypes runs inside a render, so a
    // runaway here freezes the tab on a wall nobody is standing next to. A
    // failure shows up as RangeError (stack exhausted), not as a wrong set.
    const self = view("v-self", "clock", [viewEmbed("e1", "v-self")]);
    const types = layoutChannelTypes(self.layout!, [self], [], "v-self");
    assert.ok(types.has("clock"));
  });

  test("terminate on a cycle that goes through a second view", () => {
    // A -> B -> A has no parent match anywhere in it, which is why the chain is
    // checked whole rather than one level up.
    const a = view("v-a", "clock", [viewEmbed("ea", "v-b")]);
    const b = view("v-b", "transcript-strip", [viewEmbed("eb", "v-a")]);
    const types = layoutChannelTypes(a.layout!, [a, b], [], "v-a");
    assert.ok(types.has("transcript-strip"), "the reachable second view was never collected");
  });

  test("stop at the same depth the renderer stops drawing at", () => {
    // Past MAX_EMBED_DEPTH the tile draws a refusal notice, so subscribing for
    // what it would have contained is a channel opened for nothing.
    assert.equal(MAX_EMBED_DEPTH, 3, "this test is written against a cap of three");
    const d = view("v-d", "osc-button");
    const c = view("v-c", "clock", [viewEmbed("ec", "v-d")]);
    const b = view("v-b", "clock", [viewEmbed("eb", "v-c")]);
    const types = layoutChannelTypes(
      layoutOf(viewEmbed("ea", "v-b")),
      [b, c, d],
      [],
      "v-a",
    );
    assert.ok(types.has("clock"), "the views within the cap were not collected");
    assert.ok(!types.has("osc-button"), "collected a view too deep to be drawn");
  });

  test("stay exactly as narrow as before when nothing is embedded", () => {
    // A layout with no embed must ask for its own types and nothing else: the
    // views and outputs it is handed are the whole system's, not its own.
    const types = layoutChannelTypes(
      layoutOf(obj("a", { type: "clock" }), obj("b", { type: "text", text: "hi" })),
      [view("v-unused", "obs-status")],
      [output("out-1", "v-unused")],
      "v-outer",
    );
    assert.deepEqual([...types].sort(), ["clock", "text"]);
  });

  test("report a screen tile that is itself inside an embedded view", () => {
    // The sole justification for deleting "view-embed" from the presence gate.
    // That entry was a stand-in for this descent; with it gone, a nested screen
    // tile's status dot is lit only because the descent reaches through the
    // view-embed and finds the tile. If it ever stops, presence goes dark inside
    // every nested tile and nothing else in the suite notices.
    const inner = view("v-inner", "clock", [screenEmbed("s1", "out-1")]);
    const types = layoutChannelTypes(
      layoutOf(viewEmbed("e1", "v-inner")),
      [inner],
      [output("out-1", null)],
      "v-outer",
    );
    assert.ok(
      types.has("screen-embed"),
      "the nested screen tile was invisible to the gate, so its status dot would never light",
    );
  });

  test("ignore a layout left behind on a view that is no longer custom", () => {
    // A slots view draws SlotsColumns, not objects — whatever `layout` it is
    // still carrying from when it was custom is not on any screen.
    const stale = { ...view("v-slots", "obs-status"), kind: "slots" } as View;
    const types = layoutChannelTypes(layoutOf(viewEmbed("e1", "v-slots")), [stale], [], "v-outer");
    assert.deepEqual([...types], ["view-embed"]);
  });

  test("ask for nothing extra when an embed points nowhere", () => {
    const types = layoutChannelTypes(
      layoutOf(viewEmbed("e1", null), screenEmbed("e2", "out-missing")),
      [view("v-unused", "obs-status")],
      [],
      "v-outer",
    );
    assert.deepEqual([...types].sort(), ["screen-embed", "view-embed"]);
  });
});
