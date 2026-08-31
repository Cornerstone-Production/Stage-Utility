// Three colour panels could be open at once.
//
// `open` is per-instance state and nothing coordinated the instances, so the
// Screens page — one swatch per display card — opened a panel per click and left
// them all on screen, each anchored to its own trigger and each editing
// something different. Measured in a browser before the fix: clicking three in a
// row left 1, then 2, then 3 panels in the document.
//
// One panel for the icon AND its colour, for the same reason a colour panel is
// one panel: they describe the same object. A preview in the colour being
// dragged, and a button that swaps the body for the icon set.
//
// WHY THIS FILE RENDERS RATHER THAN READS THE SOURCE. It used to be a regex over
// color-field.tsx — /const closers = new Set<\(\) => void>\(\)/ and friends. That
// is the vacuous kind of guard this repo keeps re-learning: changing
// `}, [open, setOpen]);` to `}, []);` inside useOnlyOnePanel breaks the
// coordination completely — three panels open at once — and every one of the
// five assertions stayed green, while merely RENAMING `closers` turned the suite
// red with the behaviour intact. jsdom can drive all of it, so it does.
//
// The accent flash is the same shape one level up: `--brand-accent` is ONE
// variable on the document root, and seventeen components call useStageState.
// Every one started with a null state, and applyAccentVar(undefined) REMOVES the
// override — so any component mounting mid-session stripped the accent off the
// whole page until its own fetch returned. The panel's saved colours list is one
// of those seventeen, which is why opening a picker flashed every
// accent-coloured thing on the page. That guard USED TO LIVE HERE too, as a
// regex over use-stage-state.ts looking for `if (!state) return;`, and went red
// the moment the accent moved into the shared store — where the rule it protects
// is now structural. It is three cases in
// `renderer/main/use-stage-state.test.tsx` that render the hook and read
// `--brand-accent` off the document, which is what a browser acts on.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

// The panel's saved-colour row reads the shared stage state, so a render of it
// opens a request and an SSE stream. Both are answered with nothing: this file
// is about which panels are on screen, not what is in them.
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

// After installDom(), never before: a static import evaluates first and React
// would come up with no document.
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ColorField } = await import("./color-field.js");
const { PaletteIcon } = await import("lucide-react");

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  await settle();
  teardown();
});
afterEach(async () => {
  cleanup();
  await settle();
});

const withQuery = (children: React.ReactNode) =>
  React.createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
    children,
  );

/** N colour fields side by side, as the Screens page draws one per card. */
const drawFields = (n: number, icon?: Parameters<typeof ColorField>[0]["icon"]) =>
  render(
    withQuery(
      React.createElement(
        "div",
        null,
        ...Array.from({ length: n }, (_, i) =>
          React.createElement(ColorField, {
            key: i,
            value: "#3b82f6",
            onChange: () => {},
            label: `Colour ${i + 1}`,
            icon,
          }),
        ),
      ),
    ),
  );

const triggers = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')];
const panels = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-color-panel]")];
const panel = (): HTMLElement => {
  assert.equal(panels().length, 1, `expected exactly one panel, found ${panels().length}`);
  return panels()[0];
};
const inPanel = (text: string): HTMLButtonElement => {
  const el = [...panel().querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(el, `no "${text}" button in the panel`);
  return el;
};

describe("one colour panel at a time", () => {
  test("clicking a second trigger leaves ONE panel in the document", async () => {
    drawFields(2);
    await settle();

    fireEvent.click(triggers()[0]);
    await settle();
    assert.equal(panels().length, 1, "the first click did not open a panel");

    fireEvent.click(triggers()[1]);
    await settle();
    assert.equal(
      panels().length,
      1,
      "both panels stayed open — nothing coordinated the two instances",
    );
  });

  test("three in a row still leaves one, which is the case that was measured", async () => {
    drawFields(3);
    await settle();

    for (const t of triggers()) {
      fireEvent.click(t);
      await settle();
    }
    assert.equal(panels().length, 1, `clicking three in a row left ${panels().length} panels`);
  });

  test("the panel left open is the one that was clicked LAST", async () => {
    drawFields(2);
    await settle();

    fireEvent.click(triggers()[0]);
    await settle();
    fireEvent.click(triggers()[1]);
    await settle();

    assert.equal(panel().getAttribute("aria-label"), "Colour 2");
    assert.equal(triggers()[0].getAttribute("aria-expanded"), "false");
    assert.equal(triggers()[1].getAttribute("aria-expanded"), "true");
  });

  test("closing the last one leaves none, so a stale closer cannot linger", async () => {
    drawFields(2);
    await settle();

    fireEvent.click(triggers()[0]);
    await settle();
    fireEvent.keyDown(document, { key: "Escape" });
    await settle();
    assert.equal(panels().length, 0, "Escape left the panel up");

    // If the closed panel stayed in the register it would shut this one too.
    fireEvent.click(triggers()[1]);
    await settle();
    assert.equal(panels().length, 1, "a closed panel was still closing the others");
  });
});

describe("the icon and its colour are one panel", () => {
  const iconProps = () => {
    const picked: string[] = [];
    const cleared: number[] = [];
    return {
      picked,
      cleared,
      icon: {
        glyph: PaletteIcon,
        current: "palette",
        onPick: (name: string) => picked.push(name),
        onClear: () => cleared.push(1),
      },
    };
  };

  test("the colour body and the icon grid swap, and swap back", async () => {
    drawFields(1, iconProps().icon);
    await settle();
    fireEvent.click(triggers()[0]);
    await settle();

    // The colour body's own control, present only while the colour is shown.
    assert.ok(panel().querySelector('[role="slider"]'), "the colour body is not on screen");

    fireEvent.click(inPanel("Change icon"));
    await settle();
    assert.equal(panels().length, 1, "the swap opened a second panel");
    assert.equal(
      panel().querySelector('[role="slider"]'),
      null,
      "the colour body is still there under the grid",
    );

    fireEvent.click(inPanel("Back to colour"));
    await settle();
    assert.ok(panel().querySelector('[role="slider"]'), "there is no way back to the colour");
  });

  test("picking an icon reports it and returns to the colour", async () => {
    const { picked, icon } = iconProps();
    drawFields(1, icon);
    await settle();
    fireEvent.click(triggers()[0]);
    await settle();
    fireEvent.click(inPanel("Change icon"));
    await settle();

    // A grid cell: the only buttons in the panel carrying the icon's name.
    const glyph = panel().querySelector<HTMLButtonElement>("button[title]");
    assert.ok(glyph, "the grid drew no icons");
    const name = glyph.title;
    fireEvent.click(glyph);
    await settle();

    assert.deepEqual(picked, [name], "the pick never reached the caller");
    assert.ok(
      panel().querySelector('[role="slider"]'),
      "picking dead-ended in the grid instead of going back to the colour",
    );
  });

  test("clearing back to the built-in icon also returns to the colour", async () => {
    const { cleared, icon } = iconProps();
    drawFields(1, icon);
    await settle();
    fireEvent.click(triggers()[0]);
    await settle();
    fireEvent.click(inPanel("Change icon"));
    await settle();

    fireEvent.click(inPanel("Use the default"));
    await settle();

    assert.deepEqual(cleared, [1], "the clear never reached the caller");
    assert.ok(
      panel().querySelector('[role="slider"]'),
      "clearing dead-ended in the grid instead of going back to the colour",
    );
  });

  test("there is no second popup left to open", () => {
    // The standalone picker was deleted with the two-menu flow. A file that came
    // back would mean two ways to change one icon again.
    assert.equal(existsSync(new URL("../icon-picker.tsx", import.meta.url)), false);
  });
});

describe("the panel is a dialog, and now behaves like one", () => {
  // THE BUG. This panel has carried role="dialog" since it was written and none
  // of what that role promises: focus never moved into it, Tab was never
  // trapped, and closing it dropped focus on <body>. A keyboard operator opened
  // the picker and their next Tab started at the top of the page, walking every
  // control the panel is covering.
  //
  // WHAT JSDOM CANNOT SAY: nothing is laid out, so "the panel is on screen where
  // focus went" is not checkable and is not asserted — the placement suite next
  // door is equally explicit about that. What IS checkable is where
  // document.activeElement is, and that is the whole of this finding.

  /**
   * Where focus is, in a few words.
   *
   * assert.equal on two DOM NODES is not an option here: when they differ, the
   * runner serialises both to build its diff, and serialising a jsdom element
   * walks the whole document — the process was SIGKILLed at 20s on the very
   * failure these guards exist to produce. So identity is asserted as a boolean
   * and this supplies the message.
   */
  const where = (el: Element | null): string => {
    if (!el) return "nothing";
    if (el === document.body) return "<body>";
    const id = el.id ? `#${el.id}` : "";
    const role = el.getAttribute("role");
    return `<${el.tagName.toLowerCase()}${id}${role ? ` role=${role}` : ""}>`;
  };

  /** Everything in the panel a Tab can land on, in order. */
  const stops = (): HTMLElement[] =>
    [
      ...panel().querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);

  test("THE GUARD: focus moves into the panel when it opens", async () => {
    drawFields(1);
    await settle();
    fireEvent.click(triggers()[0]);
    await settle();
    assert.ok(
      document.activeElement === panel(),
      `opening the panel left focus on ${where(document.activeElement)} rather than the dialog — the next Tab walks the page behind it`,
    );
  });

  test("THE GUARD: Tab cycles inside the panel instead of walking out of it", async () => {
    drawFields(1);
    await settle();
    fireEvent.click(triggers()[0]);
    await settle();

    const inside = stops();
    // More than one, or the wrap has nothing to wrap between and both
    // assertions below would be trivially true.
    assert.ok(inside.length > 1, `the panel has ${inside.length} tab stops, so this asserts nothing`);
    const first = inside[0];
    const last = inside[inside.length - 1];

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    assert.ok(
      document.activeElement === first,
      `Tab off the last control landed on ${where(document.activeElement)} — it left the dialog`,
    );

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    assert.ok(
      document.activeElement === last,
      `Shift+Tab off the first control landed on ${where(document.activeElement)} — it left the dialog`,
    );
  });

  test("THE GUARD: closing puts focus back on the swatch, not on <body>", async () => {
    drawFields(1);
    await settle();
    const swatch = triggers()[0];
    fireEvent.click(swatch);
    await settle();

    fireEvent.keyDown(document, { key: "Escape" });
    await settle();
    assert.equal(panels().length, 0, "Escape did not close the panel, so this asserts nothing");
    assert.ok(
      document.activeElement === swatch,
      `closing the panel left focus on ${where(document.activeElement)} instead of the control that opened it`,
    );
  });

  test("THE GUARD: and it finds the swatch again after the node has been replaced", async () => {
    // The trap this repository has hit before: the node that opened a dialog can
    // be gone by the time the dialog closes. This panel commits as you drag and
    // saves an icon in place, so the card the swatch sits in can be re-rendered
    // while the panel is up — and focus() on a detached node does nothing at
    // all, silently.
    //
    // The swap is done to the DOM directly because that IS the condition: a new
    // element in the same place, carrying the same id. An implementation holding
    // the node it was given passes every other test in this describe and fails
    // this one.
    drawFields(1);
    await settle();
    const stale = triggers()[0];
    fireEvent.click(stale);
    await settle();

    const fresh = stale.cloneNode(true) as HTMLButtonElement;
    assert.ok(fresh.id, "the swatch carries no id, so there is nothing to look it up by");
    stale.replaceWith(fresh);

    fireEvent.keyDown(document, { key: "Escape" });
    await settle();
    assert.ok(
      document.activeElement === fresh,
      `focus went to ${where(document.activeElement)} — the swatch node that was on the page when the panel OPENED, and that node is no longer in the document`,
    );
  });
});
