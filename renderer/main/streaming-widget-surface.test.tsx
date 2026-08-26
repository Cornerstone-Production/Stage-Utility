// One streaming widget, two presentations, chosen by the surface.
//
// "Resi status" and "YouTube status" are what the palette offers under their own
// groups, so an operator picks them for a console as readily as for Home. On a
// console they sit beside OBS status and REAPER status — wall widgets, one word
// in caps — and for a release they drew Home's small three-line mono card there
// instead, which is what "does not match the custom layout widgets" meant.
//
// Before that they drew the WALL composition everywhere, and Home had the
// mismatched tile. Fixing either end by changing the type is how it ping-pongs;
// the surface is what differs, so the surface is what decides.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

// Home's card reads live state through the app's SSE hook, which opens an
// EventSource on mount. jsdom has none, and what this is about is which
// composition gets drawn — the card is fed from the context either way, so a
// stub that never emits is the whole requirement.
class NoStream {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");

after(() => {
  cleanup();
  teardown();
});

// Nothing connected, on both surfaces. Home's card reads live state through the
// app's SSE hooks rather than the context, so this is the one state both agree
// on — which leaves the COMPOSITION as the only thing that can differ, and the
// composition is what this is about.

function ctx(home: boolean) {
  return {
    home,
    now: Date.parse("2026-08-22T18:00:00.000Z"),
    skewMs: 0,
    H: 1080,
    interactive: false,
    resi: null,
    youtube: null,
    obs: null,
    state: { outputs: [] },
  } as never;
}

const OBJ = {
  id: "o1",
  x: 0, y: 0, w: 0.2, h: 0.06, z: 1,
  config: { type: "home-streaming-resi" },
  style: {},
} as never;

function textOf(home: boolean): string {
  cleanup();
  const { container } = render(React.createElement(ObjectContent as never, { o: OBJ, ctx: ctx(home) }));
  return container.textContent ?? "";
}

describe("a Resi status widget", () => {
  test("on HOME has a third line saying where Resi stands", () => {
    const text = textOf(true);
    assert.match(text, /Offline/, "the state word is missing");
    assert.match(text, /Resi not connected/, "Home lost the connection line");
  });

  test("anywhere else it is the wall widget: the word, and no third line", () => {
    // The same line OBS status and REAPER status draw beside it. The connection
    // line is what makes the tile three-deep and small, and a wall wants one
    // word read from across a room.
    const text = textOf(false);
    assert.match(text, /Offline/);
    assert.ok(!/not connected/.test(text), "the wall widget kept Home's third line");
  });

  test("and the two really are different — this is not asserting nothing", () => {
    assert.notEqual(textOf(true), textOf(false));
  });
});
