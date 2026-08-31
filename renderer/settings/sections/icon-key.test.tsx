// One icon, one key.
//
// A Screens card keyed by output id and a sidebar console tab keyed by view id
// were two entries for what the operator sees as one thing, with the tab
// preferring its own. Set the tab's icon once and the card could never move it
// again — reported as the icon not reflecting for one of the consoles.
//
// A screen showing a CONTROL SURFACE now shares the view's key with the tab.
// Anything else is a screen in its own right and keeps its id.
//
// The last suite RENDERS the rail. The case named for the reported bug used to
// read `const railKey = "console-a"; assert.equal(iconKeyFor(…), railKey)` —
// a literal compared against itself, restating the first case and never once
// touching ConsoleRailIcon. Deleting the component's use of viewId and keying
// by anything else left it green. It now writes an entry under the key the CARD
// produces and asserts the RAIL draws it.
//
// Every id and glyph name below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";
import type { View } from "@main/types/views";

const teardown = installDom();

const view = (id: string, surface: "display" | "console") =>
  ({ id, name: id, kind: "custom", surface, ndiSource: null, createdAt: "" }) as unknown as View;

const VIEWS = [view("console-a", "console"), view("wall-b", "display")];

/** The glyph and colour the operator set, keyed as the SCREENS CARD keys them. */
const CHOSEN_GLYPH = "Star";
const CHOSEN_COLOUR = "rgb(229, 72, 77)";

// After installDom(), never before: a static import evaluates first and React
// would come up with no document.
const { iconKeyFor } = await import("./outputs-section.js");

const CARD_KEY = iconKeyFor({ id: "display-1", viewId: "console-a" }, VIEWS);

// The hook behind the rail hydrates the whole StageState over `fetch`. Answer it
// with a state carrying exactly one icon entry, under the card's key.
(globalThis as unknown as { fetch: unknown }).fetch = async () => {
  const payload = {
    appName: "Stage",
    accentColor: null,
    hourCycle: "12h",
    slotsByView: {},
    slotsByLayoutObject: {},
    iconGlyphs: { [CARD_KEY]: CHOSEN_GLYPH },
    iconColors: { [CARD_KEY]: CHOSEN_COLOUR },
  };
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};
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

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ConsoleRailIcon } = await import("../../components/console-rail-icon.js");
const { resolveIcon } = await import("../../components/icon-set.js");
const { SlidersHorizontalIcon } = await import("lucide-react");

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  cleanup();
  await settle();
  teardown();
});
afterEach(async () => {
  cleanup();
  await settle();
});

describe("where a screen's icon is stored", () => {
  test("a screen showing a control surface uses the VIEW's key", () => {
    assert.equal(iconKeyFor({ id: "display-1", viewId: "console-a" }, VIEWS), "console-a");
  });

  test("so two screens showing the same console share one icon", () => {
    const a = iconKeyFor({ id: "display-1", viewId: "console-a" }, VIEWS);
    const b = iconKeyFor({ id: "display-2", viewId: "console-a" }, VIEWS);
    assert.equal(a, b, "the same console would have two different icons");
  });

  test("a screen showing a wall-screen view keeps its OWN key", () => {
    // It is a screen, not a thing the sidebar lists.
    assert.equal(iconKeyFor({ id: "display-1", viewId: "wall-b" }, VIEWS), "display-1");
  });

  test("a screen showing nothing keeps its own key", () => {
    assert.equal(iconKeyFor({ id: "display-1", viewId: null }, VIEWS), "display-1");
    assert.equal(iconKeyFor({ id: "display-1" }, VIEWS), "display-1");
  });

  test("a screen pointed at a view this build cannot find keeps its own key", () => {
    // Rather than throwing, or keying by an id nothing resolves.
    assert.equal(iconKeyFor({ id: "display-1", viewId: "gone" }, VIEWS), "display-1");
  });
});

/** The path data of the glyph a container drew — what a lucide icon actually is. */
function glyphOf(root: HTMLElement): string {
  const svg = root.querySelector("svg");
  assert.ok(svg, "nothing drew a glyph");
  return svg.innerHTML;
}

/** The same, for an icon rendered on its own, so the comparison is version-proof. */
function glyphFor(icon: Parameters<typeof React.createElement>[0]): string {
  const c = render(React.createElement(icon)).container;
  const html = glyphOf(c);
  c.remove();
  return html;
}

describe("the console tab reads that same key", () => {
  const drawRail = (active: boolean) =>
    render(
      React.createElement(ConsoleRailIcon, { viewId: "console-a", label: "Console A", active }),
    ).container;

  test("the rail draws the glyph stored under the card's key", async () => {
    const chosen = resolveIcon(CHOSEN_GLYPH);
    assert.ok(chosen, `${CHOSEN_GLYPH} is not in the icon set`);
    assert.notEqual(
      glyphFor(chosen),
      glyphFor(SlidersHorizontalIcon),
      "the chosen glyph is indistinguishable from the fallback, so this proves nothing",
    );

    const container = drawRail(false);
    await settle();
    assert.equal(
      glyphOf(container),
      glyphFor(chosen),
      "the rail drew its fallback — it is not reading the key the Screens card writes",
    );
  });

  test("and the colour stored under it, while this console is the page shown", async () => {
    const container = drawRail(true);
    await settle();
    const svg = container.querySelector("svg");
    assert.ok(svg);
    assert.equal(svg.style.color, CHOSEN_COLOUR);
  });

  test("but stays quiet when it is not, so the rail still says where you are", async () => {
    const container = drawRail(false);
    await settle();
    const svg = container.querySelector("svg");
    assert.ok(svg);
    assert.equal(svg.style.color, "", "an inactive row wore the operator's colour");
  });
});
