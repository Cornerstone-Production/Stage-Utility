// A widget added on Home draws the theme's ink, not the wall's white.
//
// Home's add gives a widget its wall style less the colour (see
// home-cards.test.ts). That alone fixed nothing for a text widget: the renderer
// fell back to white for a style with no colour, so a Text or Current item on a
// light Home was still white on white. The fallback is now a custom property
// Home's card frame sets to the theme's text colour.
//
// jsdom resolves no custom properties, so this cannot assert a painted colour;
// that was checked in a browser in both themes. What it can check is the real
// chain: the real CardFrame holding the real ObjectContent, with the style
// Home's add writes.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import type { LayoutObject } from "@main/types/views";

import { installDom } from "../../test-dom.js";
import { NoStream } from "../../test-fixtures/no-stream.js";

const teardown = installDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ObjectContent, DEFAULT_INK } = await import("../../main/layout-renderer.js");
const { makeRenderCtx } = await import("../../main/test-render-ctx.js");
const { CardFrame } = await import("./home-grid.js");
const { addCard } = await import("./home-cards.js");

after(() => {
  cleanup();
  teardown();
});

const CTX = makeRenderCtx({ home: true });

/** The span a Text widget draws its words in, inside Home's real frame. */
function homeText(o: LayoutObject): { frame: HTMLElement; span: HTMLElement } {
  const { container } = render(
    React.createElement(CardFrame as never, { o }, React.createElement(ObjectContent as never, { o, ctx: CTX })),
  );
  const frame = container.firstElementChild as HTMLElement;
  const span = [...frame.querySelectorAll<HTMLElement>("span")].find((s) => s.textContent?.trim());
  assert.ok(span, "the Text widget drew no words, so this proves nothing about their colour");
  return { frame, span };
}

describe("a Text widget added on Home", () => {
  test("draws the ink Home's frame names, and the frame names the theme's", () => {
    const o = addCard([], "text", "t")[0];
    const { frame, span } = homeText(o);
    assert.equal(span.style.color, DEFAULT_INK, "the words carry a colour of their own, not Home's ink");
    assert.equal(frame.style.getPropertyValue("--layout-ink"), "var(--color-fg)", "Home's frame does not set the theme's ink");
    cleanup();
  });

  test("a colour the operator picked still wins", () => {
    const o = addCard([], "text", "t")[0];
    const { span } = homeText({ ...o, style: { ...o.style, color: "#ff0000" } } as LayoutObject);
    assert.equal(span.style.color, "rgb(255, 0, 0)");
    cleanup();
  });
});
