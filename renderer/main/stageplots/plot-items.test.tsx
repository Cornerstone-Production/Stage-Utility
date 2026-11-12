// A plot's items, drawn by the one SVG component the editor, /stageplots and
// print share, and the legend read from them.
//
// What is NOT here: how big a label comes out on screen. Labels are sized in
// screen pixels against the SVG's measured width, and jsdom measures every
// element as 0 wide, so these tests draw at the fallback width. Label size,
// level labels on rotated items and the symbol drawings themselves are checked
// in a browser against the mockup.
//
// Every name below is invented. This is a public repository.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { SYMBOL_KINDS, type PlotItem } from "@main/types/stageplots";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();
const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { PlotSvg } = await import("./plot-svg.js");
const { legendRows, calloutKey } = await import("./legend.js");
const { PlotLegend } = await import("./plot-legend.js");

afterEach(cleanup);
after(() => teardown());

function item(over: Partial<PlotItem> & Pick<PlotItem, "id" | "type">): PlotItem {
  return { x: 100, y: 100, w: 80, h: 60, rotation: 0, label: "", color: null, notes: "", inputs: [], ...over };
}

function draw(items: PlotItem[], selectedId: string | null = null): SVGSVGElement {
  const { container } = render(React.createElement(PlotSvg, { plot: { name: "Standard", items }, background: null, fade: 0.4, selectedId }));
  return container.querySelector("svg")!;
}

describe("drawing items", () => {
  test("a box draws a rect, its label level outside the rotation", () => {
    const svg = draw([item({ id: "b", type: "box", label: "Drum riser", rotation: 30 })]);
    const g = svg.querySelector('[data-id="b"]')!;
    assert.equal(g.getAttribute("data-type"), "box");
    const rotated = g.querySelector("g[transform]")!;
    assert.match(rotated.getAttribute("transform") ?? "", /rotate\(30\)/);
    assert.ok(rotated.querySelector("rect"), "no rect");
    const label = [...g.querySelectorAll("text")].find((t) => t.textContent === "Drum riser")!;
    assert.ok(label, "no label");
    assert.equal(rotated.contains(label), false, "the label turns with the item");
  });

  test("a circle draws an ellipse", () => {
    const svg = draw([item({ id: "c", type: "circle" })]);
    assert.ok(svg.querySelector('[data-id="c"] ellipse'));
  });

  test("a zone draws a dashed rect", () => {
    const svg = draw([item({ id: "z", type: "zone", color: "#8e4ec6" })]);
    const rect = svg.querySelector('[data-id="z"] rect[stroke-dasharray]')!;
    assert.ok(rect, "no dashed rect");
    // jsdom writes a colour back as rgb(): the purple swatch is 142, 78, 198.
    assert.equal((rect as SVGElement).style.stroke, "rgb(142, 78, 198)");
  });

  test("a cable draws a polyline through its points, dashed when it says so", () => {
    const svg = draw([item({ id: "k", type: "cable", points: [[10, 20], [300, 40], [300, 400]], dashed: true, label: "Snake A" })]);
    const lines = [...svg.querySelectorAll('[data-id="k"] polyline')];
    const drawn = lines.find((l) => l.hasAttribute("stroke-dasharray"))!;
    assert.ok(drawn, "the cable is not dashed");
    assert.equal(drawn.getAttribute("points"), "10,20 300,40 300,400");
    assert.ok([...svg.querySelectorAll('[data-id="k"] text')].some((t) => t.textContent === "Snake A"));
  });

  test("a connection point draws its plate and socket", () => {
    const svg = draw([item({ id: "p", type: "conn", w: 25, h: 25, color: "#12a594" })]);
    assert.equal(svg.querySelectorAll('[data-id="p"] g[transform] circle').length, 2);
  });

  test("each of the nine symbols draws its own drawing", () => {
    const svg = draw(SYMBOL_KINDS.map((s, i) => item({ id: `s${i}`, type: "symbol", symbol: s })));
    const drawn = [...svg.querySelectorAll("[data-symbol]")];
    assert.deepEqual(drawn.map((g) => g.getAttribute("data-symbol")).sort(), [...SYMBOL_KINDS]);
    for (const g of drawn) assert.ok(g.children.length >= 2, `${g.getAttribute("data-symbol")} draws nothing`);
  });

  test("text: a label, a numbered callout, and a dimension line with its words", () => {
    const svg = draw([
      item({ id: "t1", type: "text", textKind: "label", label: "Load-in door" }),
      item({ id: "t2", type: "text", textKind: "callout", label: "Riser skirt faces the room", w: 23, h: 23 }),
      item({ id: "t3", type: "text", textKind: "dimension", label: "Stage width 32 ft", w: 400, h: 18 }),
      item({ id: "t4", type: "text", textKind: "callout", label: "Second", w: 23, h: 23 }),
    ]);
    assert.equal(svg.querySelector('[data-id="t1"] text')!.textContent, "Load-in door");
    assert.equal(svg.querySelector('[data-id="t2"] text')!.textContent, "1");
    assert.equal(svg.querySelector('[data-id="t4"] text')!.textContent, "2");
    assert.equal(svg.querySelectorAll('[data-id="t3"] path').length, 2);
    assert.equal(svg.querySelector('[data-id="t3"] text')!.textContent, "Stage width 32 ft");
    // Plex Mono on every numeral, inside a plot too.
    assert.equal(svg.querySelector('[data-id="t3"] tspan.font-mono')?.textContent, "32");
  });

  test("the selected item is drawn last, with its handles", () => {
    const items = [
      item({ id: "zone", type: "zone" }),
      item({ id: "sel", type: "box" }),
      item({ id: "text", type: "text", textKind: "label", label: "On top" }),
    ];
    const svg = draw(items, "sel");
    const order = [...svg.querySelectorAll("[data-items] > [data-id]")].map((g) => g.getAttribute("data-id"));
    assert.deepEqual(order, ["zone", "text", "sel"]);
    assert.ok(svg.querySelector('[data-id="sel"] [data-hd="size"]'));
    assert.ok(svg.querySelector('[data-id="sel"] [data-hd="rot"]'));
    assert.equal(svg.querySelectorAll("[data-hd]").length, 2, "an unselected item has handles");
  });

  test("a selected item's handles are drawn over its own label", () => {
    // Turned 55°, a drum kit's label sits on its corner handle: the handle must be on top to take the press.
    const svg = draw([item({ id: "k", type: "symbol", symbol: "drumkit", label: "Drum kit", rotation: 55 })], "k");
    const g = svg.querySelector('[data-id="k"]')!;
    const all = [...g.querySelectorAll("text, [data-hd]")];
    const label = all.findIndex((el) => el.textContent === "Drum kit");
    const handles = all.map((el, i) => (el.hasAttribute("data-hd") ? i : -1)).filter((i) => i >= 0);
    assert.ok(label >= 0 && handles.length === 2 && handles.every((i) => i > label), `label at ${label}, handles at ${handles}`);
  });

  test("the rotate handle goes under an item at the top edge, where above it would be off the plot", () => {
    const handleY = (it: PlotItem) => {
      const svg = draw([it], it.id);
      const rot = svg.querySelector('[data-hd="rot"]')!;
      return { cy: Number(rot.getAttribute("cy")), below: rot.hasAttribute("data-below") };
    };
    const top = handleY(item({ id: "t", type: "box", y: 0, h: 40 }));
    assert.ok(top.cy > 0 && top.below, `at the top edge the handle is at cy ${top.cy}`);
    const clear = handleY(item({ id: "c", type: "box", y: 300, h: 40 }));
    assert.ok(clear.cy < 0 && !clear.below, `with room above the handle is at cy ${clear.cy}`);
  });

  test("zones under shapes under cables under symbols under text, each in the order added", () => {
    const svg = draw([
      item({ id: "t", type: "text", textKind: "label", label: "x" }),
      item({ id: "s", type: "symbol", symbol: "amp" }),
      item({ id: "k", type: "cable", points: [[0, 0], [9, 9]], dashed: false }),
      item({ id: "b2", type: "box" }),
      item({ id: "z", type: "zone" }),
      item({ id: "b1", type: "circle" }),
    ]);
    const order = [...svg.querySelectorAll("[data-items] > [data-id]")].map((g) => g.getAttribute("data-id"));
    assert.deepEqual(order, ["z", "b2", "b1", "k", "s", "t"]);
  });
});

describe("the legend", () => {
  const ORANGE = "#f76b15";
  const items = [
    item({ id: "w1", type: "symbol", symbol: "wedge", label: "Floor wedge", color: ORANGE }),
    item({ id: "b", type: "box" }),
    item({ id: "w2", type: "symbol", symbol: "wedge", label: "Floor wedge", color: ORANGE }),
    item({ id: "w3", type: "symbol", symbol: "wedge", label: "Floor wedge", color: null }),
    item({ id: "t", type: "text", textKind: "label", label: "Load-in door" }),
    item({ id: "d", type: "text", textKind: "dimension", label: "10 ft" }),
    item({ id: "c1", type: "text", textKind: "callout", label: "First note" }),
    item({ id: "k", type: "cable", points: [[0, 0], [9, 9]], dashed: true, label: "Snake A", color: "#0091ff" }),
    item({ id: "c2", type: "text", textKind: "callout", label: "Second note" }),
  ];

  test("legendRows groups two orange Floor wedges as one row with count 2 and leaves out unlabelled shapes and text", () => {
    assert.deepEqual(legendRows(items), [
      { label: "Floor wedge", color: ORANGE, type: "symbol", symbol: "wedge", count: 2 },
      { label: "Floor wedge", color: null, type: "symbol", symbol: "wedge", count: 1 },
      { label: "Snake A", color: "#0091ff", type: "cable", dashed: true, count: 1 },
    ]);
  });

  test("calloutKey numbers callouts in insertion order", () => {
    assert.deepEqual(calloutKey(items), [
      { n: 1, text: "First note" },
      { n: 2, text: "Second note" },
    ]);
  });

  test("a connection point's glyph draws its socket in the plot's paper, not the panel's colour", () => {
    // The panel colour is translucent in dark theme, and a socket filled with it vanished.
    const { container } = render(React.createElement(PlotLegend, { items: [item({ id: "p", type: "conn", label: "FP-3" })] }));
    const socket = container.querySelector("[data-socket]") as SVGElement | null;
    assert.ok(socket !== null, "no socket");
    assert.equal(socket.style.fill, "var(--su-plot-paper)");
  });

  test("the legend panel lists the rows, the count and the callout key", () => {
    const { container } = render(React.createElement(PlotLegend, { items }));
    const rows = [...container.querySelectorAll('[data-testid="legend-row"]')].map((r) => r.textContent);
    assert.deepEqual(rows, ["Floor wedge×2", "Floor wedge", "Snake A"]);
    const key = [...container.querySelectorAll('[data-testid="callout-key"]')].map((r) => r.textContent);
    assert.deepEqual(key, ["1First note", "2Second note"]);
  });
});
