// How RundownTable's `textScale` meets the two things that react to width: the
// fit (which shrinks type until the columns fit) and the shape (stacked, compact
// or full by the width available).
//
//  - Above 100% the fit must stand down. Left running it shrinks the type back
//    until the columns fit, so A+ on a wide column set would do nothing.
//  - The shape is chosen from the width the table can actually use, which inside
//    CSS `zoom` is the wrapper's width divided by the scale. 150% on 1100px is a
//    733px table, and draws the compact shape (no Clock column), not the full one.
//
// jsdom does no layout, so both are driven by giving it the measurements a
// browser would: the ResizeObserver reports a width, and scrollWidth/clientWidth
// say the columns overflow. What is NOT proved here is how any of it looks;
// that is driven in a browser. NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();

const WRAP_WIDTH = 1100;
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  private readonly cb: (e: { contentRect: { width: number } }[]) => void;
  constructor(cb: (e: { contentRect: { width: number } }[]) => void) {
    this.cb = cb;
  }
  observe(): void {
    this.cb([{ contentRect: { width: WRAP_WIDTH } }]);
  }
  unobserve(): void {}
  disconnect(): void {}
};
// The columns overflow their box by 3x, whatever the size.
const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
Object.defineProperty(proto, "clientWidth", { get: () => WRAP_WIDTH, configurable: true });
Object.defineProperty(proto, "scrollWidth", { get: () => WRAP_WIDTH * 3, configurable: true });

const { render, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { RundownTable } = await import("./rundown-table.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(cleanup);

const ITEMS = [{ id: "i1", title: "Welcome", itemType: "item", lengthSec: 60, sequence: 0, notesByCategory: {}, description: null }];
const COLUMNS = [
  { key: "clock", header: "Clock", render: () => "9:00" },
  { key: "title", header: "Item", render: (it: { title: string }) => it.title },
];

async function mount(textScale: number) {
  await act(async () => {
    render(React.createElement(RundownTable, { items: ITEMS, columns: COLUMNS, textScale } as never));
  });
  const table = document.querySelector("table");
  return {
    drawsTable: !!table,
    fontSize: table ? table.style.fontSize : null,
    zoom: table ? (table.parentElement as HTMLElement).style.zoom : null,
    clockColumn: !!table && (table.textContent ?? "").includes("Clock"),
    stacked: !table,
  };
}

test("at 100% the fit still shrinks overflowing columns", async () => {
  const r = await mount(1);
  assert.ok(r.fontSize && parseFloat(r.fontSize) < 100, `the fit should have shrunk the type, got ${r.fontSize}`);
});

test("above 100% the fit stands down: the type is the size asked for, not shrunk back", async () => {
  const r = await mount(1.5);
  assert.equal(r.fontSize, "100%");
  assert.equal(r.zoom, "1.5");
});

test("below 100% the fit still applies, to the already-reduced size", async () => {
  const r = await mount(0.8);
  assert.ok(r.fontSize && parseFloat(r.fontSize) < 100, `got ${r.fontSize}`);
});

test("the shape follows the width the table can use: 1100px is full at 100% but compact at 150%", async () => {
  assert.equal((await mount(1)).clockColumn, true, "full shape carries the Clock column");
  cleanup();
  assert.equal((await mount(1.5)).clockColumn, false, "733px usable is the compact shape, which drops it");
});

test("and stacked once the usable width falls under 640px: 1100px at 200%", async () => {
  assert.equal((await mount(2)).stacked, true);
});
