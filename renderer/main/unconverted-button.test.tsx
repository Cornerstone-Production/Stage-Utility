// A stored Run an action Button, which the app no longer makes or presses, is drawn as an inert
// tile that says what is wrong, not as nothing (a hole in a console) and not as a control.
//
// Through the real ObjectContent, so the renderer's own fall-through is what is exercised.
// NOT unit-tested here, because jsdom cannot see it: how the tile looks.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installDom();
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

after(() => unmountAndTeardown(cleanup, teardown));

const stored = (config: unknown) => ({ id: "o1", x: 0, y: 0, w: 0.2, h: 0.2, z: 1, config, style: {} }) as never;

describe("a Run an action Button that was not converted", () => {
  test("reads Needs converting, and is not pressable", () => {
    cleanup();
    const { container } = render(
      React.createElement(ObjectContent as never, {
        o: stored({ type: "action-button", actionId: "obs.record", params: {}, label: "Record" }),
        ctx: makeRenderCtx({ interactive: true }),
      }),
    );
    assert.match(container.textContent ?? "", /Needs converting/);
    assert.equal(container.querySelector("button"), null, "nothing here may look or act like a control");
    fireEvent.click(container.querySelector("[data-unconverted-button]")!);
  });

  test("any other dropped type still draws nothing", () => {
    cleanup();
    const { container } = render(
      React.createElement(ObjectContent as never, { o: stored({ type: "retired-thing" }), ctx: makeRenderCtx({}) }),
    );
    assert.equal(container.querySelector("[data-unconverted-button]"), null);
  });
});
