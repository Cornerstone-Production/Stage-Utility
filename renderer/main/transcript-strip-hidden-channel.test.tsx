// The transcript-strip object's hideChannels filter, against an UNNAMED
// ProdCom channel.
//
// The bug: the inspector's chips are built from mergeChannels(), whose label
// falls back to the channel id when ProdCom sends no name (channel-color.ts's
// `c.name ?? c.id`) — the same fallback channelLabel() uses to read a line
// back. The renderer's filter instead compared `l.channelName ?? ""` alone, so
// switching off the only chip offered for an unnamed channel ("ch-7") stored
// hideChannels: ["ch-7"], and every line from that channel kept rendering:
// "ch-7" was never anywhere in a bare channelName comparison. Reverting the
// filter in layout-renderer.tsx's "transcript-strip" case back to
// `l.channelName ?? ""` turns this red.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

after(() => {
  cleanup();
  teardown();
});

const UNNAMED_LINE = {
  id: "l1",
  channel: "ch-7",
  channelName: null,
  color: null,
  text: "hello",
  isFinal: true,
  at: new Date().toISOString(),
};

function stripText(hideChannels?: string[]): string {
  cleanup();
  const ctx = makeRenderCtx({ transcript: [UNNAMED_LINE] });
  const obj = {
    id: "o1",
    x: 0, y: 0, w: 0.5, h: 0.2, z: 1,
    config: { type: "transcript-strip", mode: "latest", hideChannels },
    style: {},
  } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o: obj, ctx }));
  return container.textContent ?? "";
}

describe("transcript-strip hiding an unnamed ProdCom channel", () => {
  test("with nothing hidden, the unnamed channel's line renders", () => {
    // mergeChannels labels an unnamed channel by its raw id — this is the
    // chip the operator sees and toggles, and the same id channelLabel()
    // reads back for the line, e.g. "ch-7: hello".
    assert.ok(stripText(undefined).includes("hello"));
  });

  test("hiding that same label drops the line", () => {
    assert.equal(
      stripText(["ch-7"]),
      "",
      "the chip for the unnamed channel was switched off but its line still rendered",
    );
  });

  test("hiding an unrelated label leaves it showing", () => {
    assert.ok(stripText(["some-other-channel"]).includes("hello"));
  });
});
