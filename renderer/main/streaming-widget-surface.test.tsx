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

import { installDom, settle } from "../test-dom.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installDom();
// settle() below act-wraps a state update outside of render() itself (the
// hydrate read's rejection), and React only recognizes that as inside a test
// once it is told so explicitly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Home's card reads live state through the app's SSE hook, which opens an
// EventSource on mount. jsdom has none, and what this is about is which
// composition gets drawn — the card is fed from the context either way, so a
// stub that never emits is the whole requirement.
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

after(() => {
  cleanup();
  teardown();
});

// Nothing connected, on both surfaces. Home's card reads live state through the
// app's SSE hooks rather than the context, so this is the one state both agree
// on — which leaves the COMPOSITION as the only thing that can differ, and the
// composition is what this is about.

function ctx(home: boolean) {
  return makeRenderCtx({ home, now: Date.parse("2026-08-22T18:00:00.000Z") });
}

const OBJ = {
  id: "o1",
  x: 0, y: 0, w: 0.2, h: 0.06, z: 1,
  config: { type: "home-streaming-resi" },
  style: {},
} as never;

/**
 * `known` is false until the widget's OWN status hooks have settled — no
 * `fetch` stub here, so the hydrate read rejects on its own and `known` still
 * goes true, exactly as it does when a real integration is unreachable. That
 * settling is what turns "not yet known" into the genuine "Offline" this file
 * is about; without the await, every case here would read the placeholder
 * dash instead.
 */
async function textOf(home: boolean): Promise<string> {
  cleanup();
  const { container } = render(React.createElement(ObjectContent as never, { o: OBJ, ctx: ctx(home) }));
  await settle();
  return container.textContent ?? "";
}

describe("a Resi status widget", () => {
  test("on HOME has a third line saying where Resi stands", async () => {
    const text = await textOf(true);
    assert.match(text, /Offline/, "the state word is missing");
    assert.match(text, /Resi not connected/, "Home lost the connection line");
  });

  test("anywhere else it is the wall widget: the word, and no third line", async () => {
    // The same line OBS status and REAPER status draw beside it. The connection
    // line is what makes the tile three-deep and small, and a wall wants one
    // word read from across a room.
    const text = await textOf(false);
    assert.match(text, /Offline/);
    assert.ok(!/not connected/.test(text), "the wall widget kept Home's third line");
  });

  test("and the two really are different — this is not asserting nothing", async () => {
    assert.notEqual(await textOf(true), await textOf(false));
  });
});
