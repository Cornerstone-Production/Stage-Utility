// lazy-preview-stable.test.tsx — the preview iframe survives the side panel
// opening and closing.
//
// The Screens card passes `following` only while its panel is open. LazyPreview
// once built a different element tree for each case, so React remounted the
// preview and the iframe reloaded on every toggle. The check is node identity:
// the very same <iframe> element must be in the document after `following`
// changes, in both directions.
//
// NOT covered here: the fade (jsdom loads no stylesheet, so opacity and
// transitions are unobservable) and that the iframe really does not re-navigate
// - both were driven in a browser.
//
// Nothing below passes a DOM node as an assert operand: node:assert inspects
// `actual` to build its failure message, and a live jsdom element does not finish.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { eventually, installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { LazyPreview, __previewLimits } = await import("./lazy-preview.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  __previewLimits.reset();
});

function card(following: { label: string } | undefined) {
  return React.createElement(LazyPreview, {
    viewId: "v1",
    outputId: "o1",
    onExpand: () => {},
    expandLabel: "Edit it",
    following,
  });
}

async function streamingIframe(container: HTMLElement): Promise<HTMLIFrameElement> {
  let el: HTMLIFrameElement | null = null;
  await eventually(() => {
    el = container.querySelector("iframe");
    assert.ok(el, "the preview never started streaming");
  });
  return el as unknown as HTMLIFrameElement;
}

test("opening the side panel keeps the same iframe", async () => {
  const { container, rerender } = render(card(undefined));
  const before = await streamingIframe(container);
  rerender(card({ label: "Show settings for X" }));
  const after = container.querySelector("iframe");
  assert.ok(after === before, "the iframe was remounted when `following` appeared");
  assert.ok(before.isConnected);
  // And the chrome did change: the follow label is on the card now.
  assert.ok(screen.getByRole("button", { name: "Show settings for X" }));
});

test("closing the side panel keeps the same iframe", async () => {
  const { container, rerender } = render(card({ label: "Show settings for X" }));
  const before = await streamingIframe(container);
  rerender(card(undefined));
  const after = container.querySelector("iframe");
  assert.ok(after === before, "the iframe was remounted when `following` went away");
  assert.ok(before.isConnected);
  assert.ok(screen.getByRole("button", { name: "Edit it" }));
});
