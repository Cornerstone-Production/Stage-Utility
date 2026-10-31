// The label on the four console buttons: cue, action, OSC and RossTalk.
//
// NOT unit-tested here, and checked in a browser instead: that a long label
// actually WRAPS inside the button, sits centred on both axes, keeps clear of the
// edges and never spills over them. That is the layout engine at work, and jsdom
// has none: it loads no stylesheet and reports every offsetWidth and offsetHeight
// as 0, so a guard over those would pass whatever the CSS says. It was driven in
// the layout editor and on a console, dark and light, with a label long enough to
// take four lines and a single word longer than the button.
//
// What jsdom CAN answer honestly is which element draws the label and what INLINE
// style it carries — ButtonLabel sets its alignment, padding and size cap inline,
// not from a class. That is worth pinning, because the defect was four buttons
// each drawing a bare text node or span that took its line alignment from the
// widget's own text-align, so a wrapped label sat left of centre on a button set
// to left, and a fifth button copying one of them would start the same way. The
// widget below is set to text-align LEFT on purpose: the label must not follow it.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

after(() => unmountAndTeardown(cleanup, teardown));

const LONG = "Start the sermon countdown and bring up the lower thirds";

const CONFIGS = {
  "cue-button": { type: "cue-button", cue: "", label: LONG, showDevice: true },
  "osc-button": { type: "osc-button", targetId: null, label: LONG, address: "/x", args: [], feedback: null },
  "rosstalk-button": { type: "rosstalk-button", targetId: null, commandId: null, params: {}, label: LONG },
} as const;

function mount(config: (typeof CONFIGS)[keyof typeof CONFIGS]) {
  cleanup();
  const ctx = makeRenderCtx({ interactive: true });
  const o = { id: "o1", x: 0, y: 0, w: 0.2, h: 0.2, z: 1, config, style: { textAlign: "left" } } as never;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    React.createElement(QueryClientProvider as never, { client: qc }, React.createElement(ObjectContent as never, { o, ctx })),
  );
}

describe("a console button's label", () => {
  for (const [type, config] of Object.entries(CONFIGS)) {
    test(`${type}: centred, padded, capped at the button's width, and clipped by the button`, () => {
      const { getByText } = mount(config);
      const label = getByText(LONG) as HTMLElement;
      assert.equal(label.style.textAlign, "center", "the label must centre its lines whatever the widget's text-align is");
      assert.equal(label.style.maxWidth, "100%", "the label must not grow past the button");
      assert.notEqual(label.style.paddingLeft, "", "the label needs room between the text and the button's edge");
      assert.equal(label.style.overflowWrap, "anywhere", "a word longer than the button must break");
      assert.equal(label.style.maxHeight, "100%", "the label must not grow taller than the button");
      assert.equal(label.style.overflow, "hidden", "the label must clip its own end rather than spill over the button's edge");
      const button = label.closest("button") as HTMLElement;
      assert.ok(button, "the label is not inside a button");
      assert.equal(button.style.overflow, "hidden", "the button must clip what still does not fit");
    });
  }
});
