// The colour panel has to be re-placed when its BODY changes.
//
// It is `position: fixed` in a portal on the body, so nothing scrolls it back
// into view once it is put somewhere wrong. A swatch near the foot of a long
// column has no room below it, so the panel flips above the anchor at
// `a.top - h - 8` — a formula whose only variable is the height of the body it
// happens to be showing. "Change icon" replaces the colour body (saturation
// square, two sliders, hex box, palette) with the icon grid (search field, a
// 184px-max grid, footer), and the placement was computed with deps of
// `[anchor]` alone. The panel kept the top it had: a shorter grid left it
// floating clear of its own swatch, and a taller one ran off the bottom of the
// viewport.
//
// This file measures, which no other component test here does — jsdom lays
// nothing out, so both the anchor's rect and the panel's height are stubbed. The
// height stub follows what is actually RENDERED rather than a flag, so the swap
// it measures is the real one.

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

(globalThis as unknown as { fetch: unknown }).fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => "{}",
});
class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ColorField } = await import("./color-field.js");
const { PaletteIcon } = await import("lucide-react");

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A swatch near the foot of the window: nothing fits below it. */
const SWATCH_TOP = 700;
const SWATCH_BOTTOM = 728;
const GAP = 8; // what place() leaves between the panel and the anchor

/** Heights the stub reports for the two bodies, set per test. */
let colourBodyHeight = 320;
let gridHeight = 200;

before(() => {
  const rect = (top: number, bottom: number): DOMRect =>
    ({
      top,
      bottom,
      left: 272,
      right: 300,
      x: 272,
      y: top,
      width: 28,
      height: bottom - top,
      toJSON: () => ({}),
    }) as DOMRect;

  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return this.matches?.('button[aria-haspopup="dialog"]')
      ? rect(SWATCH_TOP, SWATCH_BOTTOM)
      : rect(0, 0);
  };

  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.hasAttribute("data-color-panel")) return 0;
      // Which body is on screen, read off the DOM rather than off a flag — the
      // colour body is the only one with sliders in it.
      return this.querySelector('[role="slider"]') ? colourBodyHeight : gridHeight;
    },
  });
});

after(async () => {
  await settle();
  teardown();
});
afterEach(async () => {
  cleanup();
  await settle();
});

const draw = () =>
  render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
      React.createElement(ColorField, {
        value: "#3b82f6",
        onChange: () => {},
        label: "Icon colour",
        icon: {
          glyph: PaletteIcon,
          current: "palette",
          onPick: () => {},
          onClear: () => {},
        },
      }),
    ),
  );

const panel = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>("[data-color-panel]");
  assert.ok(el, "no panel is open");
  return el;
};
const panelTop = (): number => Number.parseFloat(panel().style.top);
const panelHeight = (): number => panel().offsetHeight;

const openPanel = async () => {
  draw();
  await settle();
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  assert.ok(trigger, "no swatch to click");
  fireEvent.click(trigger);
  await settle();
};

const changeIcon = async () => {
  const btn = [...panel().querySelectorAll("button")].find((b) => b.textContent?.trim() === "Change icon");
  assert.ok(btn, 'no "Change icon" button');
  fireEvent.click(btn);
  await settle();
};

describe("a flipped panel follows its own body", () => {
  test("a SHORTER grid does not leave the panel floating clear of its swatch", async () => {
    colourBodyHeight = 320;
    gridHeight = 200;

    await openPanel();
    assert.equal(
      panelTop() + panelHeight(),
      SWATCH_TOP - GAP,
      "the colour body did not open flush above the swatch",
    );

    await changeIcon();
    // The claim is visual, so it is checked as a measurement: the panel's bottom
    // edge still sits one gap above the swatch. Left unplaced it keeps top=372
    // with a 200px body, ending 128px short of the swatch it belongs to.
    assert.equal(
      panelTop() + panelHeight(),
      SWATCH_TOP - GAP,
      `the grid left the panel ${SWATCH_TOP - GAP - (panelTop() + panelHeight())}px clear of its swatch`,
    );
  });

  test("a TALLER grid is not left running off the bottom of the viewport", async () => {
    colourBodyHeight = 100;
    gridHeight = 400;

    await openPanel();
    await changeIcon();

    assert.equal(
      panelTop() + panelHeight() <= window.innerHeight - GAP,
      true,
      `the panel ends at ${panelTop() + panelHeight()} in a ${window.innerHeight}px window`,
    );
    assert.equal(panelTop() + panelHeight(), SWATCH_TOP - GAP);
  });

  test("and goes back where it was when the colour body returns", async () => {
    colourBodyHeight = 320;
    gridHeight = 200;

    await openPanel();
    const before = panelTop();
    await changeIcon();
    assert.notEqual(panelTop(), before, "the swap moved nothing at all");

    const back = [...panel().querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Back to colour",
    );
    assert.ok(back);
    fireEvent.click(back);
    await settle();

    assert.equal(panelTop(), before, "the panel did not return to where the colour body had it");
  });
});
