// Home's grid places cards on the rows it draws: the whole grid while editing,
// and with empty rows closed up otherwise.
//
// The arithmetic is in home-placement.test.ts; this is the other half, that
// HomeGridView actually USES it, and uses it the right way round. `gridRow` is an
// inline style on each cell, which jsdom reads (no stylesheet needed), so this
// can see a call site reverted to the raw boxes. What the page then LOOKS like
// (no blank band, rows at 120px) was driven in a browser.
//
// HomeGridView rather than HomeGrid, which needs the whole stage-state stream
// before it draws anything.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import type { LayoutObject } from "@main/types/views";
import { NoStream } from "../../test-fixtures/no-stream.js";
import { installDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { HomeGridView } = await import("./home-grid.js");
const { makeRenderCtx } = await import("../../main/test-render-ctx.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const clock = (id: string, row: number): LayoutObject =>
  ({
    id, x: 0, y: 0, w: 0.5, h: 0.2, z: 1,
    home: { size: "s", col: 1, row },
    config: { type: "clock" },
    style: {},
  }) as unknown as LayoutObject;

// Rows 1, 4 and 7: two empty rows between each.
const CARDS = [clock("a", 1), clock("b", 4), clock("c", 7)];

function draw(chrome?: () => null) {
  const { container } = render(
    React.createElement(HomeGridView, {
      layout: { version: 1, canvas: { width: 1920, height: 1080, background: null, fit: "responsive" }, objects: CARDS },
      cards: CARDS,
      chrome,
      ctx: makeRenderCtx({ home: true, interactive: true }),
    } as never),
  );
  const rows = [...container.querySelectorAll<HTMLElement>(".home-card")].map((c) => c.style.gridRow);
  const template = container.querySelector<HTMLElement>(".home-grid")!.style.gridTemplateRows;
  return { rows, template };
}

test("reading: empty rows close up, and the grid has no spare rows below", () => {
  const { rows, template } = draw();
  assert.deepEqual(rows, ["1 / span 1", "2 / span 1", "3 / span 1"]);
  assert.match(template, /^repeat\(3, /, template);
});

test("editing: the whole grid, empty rows and the two spare rows included", () => {
  const { rows, template } = draw(() => null);
  assert.deepEqual(rows, ["1 / span 1", "4 / span 1", "7 / span 1"]);
  assert.match(template, /^repeat\(9, /, template);
});
