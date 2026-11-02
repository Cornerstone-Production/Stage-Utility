// The widget shelf as a component: what a tile does, what the search box does with
// Enter and Escape, how the group list and the pane agree, and what folding leaves.
//
// The real editor around it (the shelf sitting under the canvas, Cmd/Ctrl-F, no
// popover) is layout-editor-shelf.test.tsx. NOT tested here, and why: that the shelf
// scrolls inside a fixed 206px, that the group list follows the pane's scroll, that
// tiles are 44px under a coarse pointer and the list narrows under 560px. jsdom
// loads no stylesheet and reports every offsetTop/offsetHeight as 0, so a test of
// any of them would pass whether or not it worked. They were driven in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent, within } = await import("@testing-library/react");
const React = await import("react");
const { WidgetShelf, opensShelfSearch } = await import("./widget-shelf.js");
const { PALETTE_GROUPS, LAYOUT_OBJECTS } = await import("../main/layout-objects.js");

after(() => {
  cleanup();
  teardown();
});
afterEach(() => cleanup());

const ALL_TYPES = PALETTE_GROUPS.flatMap((g) => g.types);
const noop = () => {};

interface Spy {
  added: string[];
  dragged: string[];
  lefts: string[];
  folded: boolean[];
}

function Harness({ spy, types = ALL_TYPES, dimmed = new Set<LayoutObjectType>(), startFolded = false }: {
  spy: Spy; types?: LayoutObjectType[]; dimmed?: Set<LayoutObjectType>; startFolded?: boolean;
}) {
  const [folded, setFolded] = React.useState(startFolded);
  const ref = React.useRef<HTMLInputElement | null>(null);
  return React.createElement(WidgetShelf, {
    types,
    dimmed,
    hideUnconfigured: false,
    onToggleHideUnconfigured: noop,
    onAdd: (t: string) => spy.added.push(t),
    onDragStart: (t: string) => spy.dragged.push(t),
    onDragEnd: noop,
    folded,
    onFoldedChange: (f: boolean) => { spy.folded.push(f); setFolded(f); },
    focusSignal: 0,
    searchRef: ref,
    onLeave: () => { spy.lefts.push("left"); },
  } as never);
}

const spyOf = (): Spy => ({ added: [], dragged: [], lefts: [], folded: [] });
const tile = (root: HTMLElement, label: string) =>
  within(root).getByRole("button", { name: new RegExp(`^${label}:`) });

describe("the widget shelf", () => {
  test("clicking a tile adds that widget", () => {
    const spy = spyOf();
    const { container } = render(React.createElement(Harness, { spy }));
    fireEvent.click(tile(container, LAYOUT_OBJECTS["clock"].label));
    assert.deepEqual(spy.added, ["clock"]);
  });

  test("dragging a tile reports the type, for the canvas to place on drop", () => {
    const spy = spyOf();
    const { container } = render(React.createElement(Harness, { spy }));
    const el = tile(container, LAYOUT_OBJECTS["clock"].label);
    assert.equal(el.getAttribute("draggable"), "true");
    fireEvent.dragStart(el, { dataTransfer: { setData: noop, effectAllowed: "" } });
    assert.deepEqual(spy.dragged, ["clock"]);
    assert.deepEqual(spy.added, [], "a drag must not also add");
  });

  test("Enter adds the first match, and only that tile is outlined while a query is typed", () => {
    const spy = spyOf();
    const { container, getByLabelText } = render(React.createElement(Harness, { spy }));
    const box = getByLabelText("Search widgets");
    assert.equal(container.querySelectorAll(".ring-accent").length, 0, "nothing is outlined with no query");
    fireEvent.change(box, { target: { value: "clock" } });
    const outlined = [...container.querySelectorAll(".ring-accent")];
    assert.equal(outlined.length, 1, "exactly one tile is outlined");
    fireEvent.keyDown(box, { key: "Enter" });
    assert.equal(spy.added.length, 1);
    // The outlined tile IS what Enter added.
    assert.equal(outlined[0]!.getAttribute("aria-label")?.startsWith(`${LAYOUT_OBJECTS[spy.added[0] as LayoutObjectType].label}:`), true);
  });

  test("Enter with nothing matching adds nothing", () => {
    const spy = spyOf();
    const { getByLabelText } = render(React.createElement(Harness, { spy }));
    const box = getByLabelText("Search widgets");
    fireEvent.change(box, { target: { value: "zzqqxx" } });
    fireEvent.keyDown(box, { key: "Enter" });
    assert.deepEqual(spy.added, []);
  });

  test("a group's name finds its widgets", () => {
    const spy = spyOf();
    const { container, getByLabelText } = render(React.createElement(Harness, { spy }));
    fireEvent.change(getByLabelText("Search widgets"), { target: { value: "REAPER" } });
    const reaper = PALETTE_GROUPS.find((g) => g.label === "REAPER")!.types.length;
    assert.ok(reaper > 0);
    assert.ok(container.querySelectorAll("[data-section=\"REAPER\"] button").length === reaper);
  });

  test("Escape clears the query, and Escape on an empty query leaves the box", () => {
    const spy = spyOf();
    const { getByLabelText } = render(React.createElement(Harness, { spy }));
    const box = getByLabelText("Search widgets") as HTMLInputElement;
    box.focus();
    fireEvent.change(box, { target: { value: "clock" } });
    fireEvent.keyDown(box, { key: "Escape" });
    assert.equal(box.value, "");
    assert.equal(spy.lefts.length, 0, "the first Escape only clears");
    assert.ok(document.activeElement === box, "the search box is not focused");
    fireEvent.keyDown(box, { key: "Escape" });
    assert.equal(spy.lefts.length, 1);
    assert.ok(document.activeElement !== box, "the second Escape hands the keyboard back");
  });

  test("clicking a group makes it the current one", () => {
    const spy = spyOf();
    const { getByRole } = render(React.createElement(Harness, { spy }));
    const nav = getByRole("navigation", { name: "Widget groups" });
    const second = PALETTE_GROUPS[1]!.label;
    const first = PALETTE_GROUPS[0]!.label;
    assert.equal(within(nav).getByRole("button", { name: new RegExp(`^${first}`) }).getAttribute("aria-current"), "true");
    fireEvent.click(within(nav).getByRole("button", { name: new RegExp(`^${second.replace(/[/()]/g, "\\$&")}`) }));
    const current = [...nav.querySelectorAll("button")].filter((b) => b.getAttribute("aria-current") === "true");
    assert.equal(current.length, 1);
    assert.ok(current[0]!.textContent?.startsWith(second));
  });

  test("a group with nothing left after the search is listed, dimmed, with a count of 0", () => {
    const spy = spyOf();
    const { getByRole, getByLabelText } = render(React.createElement(Harness, { spy }));
    fireEvent.change(getByLabelText("Search widgets"), { target: { value: "REAPER" } });
    const nav = getByRole("navigation", { name: "Widget groups" });
    const buttons = [...nav.querySelectorAll("button")];
    assert.equal(buttons.length, PALETTE_GROUPS.length, "every group stays in the list");
    const empty = buttons.filter((b) => b.getAttribute("data-empty") === "true");
    assert.equal(empty.length, PALETTE_GROUPS.length - 1);
    assert.ok(empty.every((b) => b.textContent?.endsWith("0")));
  });

  test("the readout names the widget under the pointer, and says when its integration is not set up", () => {
    const spy = spyOf();
    const dimmed = new Set<LayoutObjectType>(["obs-status"]);
    const { container, getByText, queryByText } = render(React.createElement(Harness, { spy, dimmed }));
    fireEvent.mouseEnter(tile(container, LAYOUT_OBJECTS["clock"].label));
    getByText(LAYOUT_OBJECTS["clock"].blurb);
    assert.ok(queryByText(/integration is not set up/) === null, "a configured widget should not say it is not set up");
    fireEvent.mouseEnter(tile(container, LAYOUT_OBJECTS["obs-status"].label));
    getByText(/integration is not set up/);
  });

  test("folded, it is one line with the count, and Widgets unfolds it", () => {
    const spy = spyOf();
    const { container, getByRole, queryByLabelText } = render(React.createElement(Harness, { spy, startFolded: true }));
    assert.ok(queryByLabelText("Search widgets") === null, "the search box should not be drawn");
    assert.ok(container.textContent?.includes(`${ALL_TYPES.length} widgets`));
    fireEvent.click(getByRole("button", { name: /^Widgets/ }));
    assert.deepEqual(spy.folded, [false]);
    assert.ok(queryByLabelText("Search widgets"));
    fireEvent.click(getByRole("button", { name: /^Fold/ }));
    assert.deepEqual(spy.folded, [false, true]);
  });
});

describe("which keydown opens the shelf's search", () => {
  const key = (over: Partial<Parameters<typeof opensShelfSearch>[0]>) =>
    ({ key: "f", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, target: document.body, ...over }) as Parameters<typeof opensShelfSearch>[0];
  const el = (tag: string, type?: string) => {
    const e = document.createElement(tag);
    if (type) (e as HTMLInputElement).type = type;
    return e;
  };

  test("Cmd+F and Ctrl+F, either case", () => {
    assert.equal(opensShelfSearch(key({}), null), true);
    assert.equal(opensShelfSearch(key({ metaKey: false, ctrlKey: true }), null), true);
    assert.equal(opensShelfSearch(key({ key: "F" }), null), true);
  });

  test("not a bare F, not Cmd+A, not with Shift or Alt", () => {
    assert.equal(opensShelfSearch(key({ metaKey: false }), null), false);
    assert.equal(opensShelfSearch(key({ key: "a" }), null), false);
    assert.equal(opensShelfSearch(key({ shiftKey: true }), null), false);
    assert.equal(opensShelfSearch(key({ altKey: true }), null), false);
  });

  test("not from another text field, but from the shelf's own search, a checkbox or a button", () => {
    const search = el("input", "search");
    assert.equal(opensShelfSearch(key({ target: el("input", "text") }), search), false);
    assert.equal(opensShelfSearch(key({ target: el("input", "number") }), search), false);
    assert.equal(opensShelfSearch(key({ target: el("textarea") }), search), false);
    assert.equal(opensShelfSearch(key({ target: search }), search), true);
    assert.equal(opensShelfSearch(key({ target: el("input", "checkbox") }), search), true);
    assert.equal(opensShelfSearch(key({ target: el("button") }), search), true);
  });
});
