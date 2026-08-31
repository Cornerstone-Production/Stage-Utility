// The checklist object draws rows and a click on one lands.
//
// Rendered rather than reasoned about, because the defect this guards is
// precisely a widget that renders. This object shipped with no source at all: it
// drew `content.items`, nothing in the app ever created one, and so it read
// "No items yet" on every layout it was ever placed on. Unit tests over its
// pieces would all have passed.
//
// The repository has the same scar from the other direction — a "+ row" button
// that added a row the surrounding code filtered straight back out. A test that
// asserts a component's props, or that a handler exists, catches neither.
//
// WHAT THIS DOES NOT COVER, said plainly rather than implied: the component
// calls usePlanChecklist() directly, and mocking an ES module needs a test
// runner flag this repository does not set. So the seam "plan.rows is what gets
// handed to checklistRows" is one visible line and is not asserted here. The
// two halves either side of it are: `checklistRows` decides the source (below),
// and rows reaching the DOM and a click reaching the handler are exercised
// through the object's own-items path, which arrives by prop and uses the same
// rendering and the same toggle wiring.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/**
 * jsdom ships no EventSource, and rendering this object reaches one: the
 * checklist reads the current plan through useStageState, which subscribes to
 * the state stream. A stub that connects to nothing is right here — the rows
 * under test arrive by prop, and a live stream would make the test depend on a
 * server.
 */
class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/**
 * No network, for the same reason.
 *
 * useStageState fetches the state on mount. Left real, that request outlives the
 * test, settles after installDom's teardown has removed `window`, and surfaces
 * as an uncaughtException that fails the FILE while every test in it passes —
 * which is a confusing way to learn the test forgot to close something.
 */
(globalThis as unknown as { fetch: unknown }).fetch = async () =>
  ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" });

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ChecklistObject, checklistRows } = await import("./notes-objects.js");

/**
 * Let anything still in flight settle BEFORE the DOM is taken away.
 *
 * Unmounting stops the component reacting, but it does not cancel the request
 * useStageState already made. That promise resolves a tick later, and if the
 * document is gone by then it throws "window is not defined" from inside React
 * — reported as the FILE failing while every test in it passes, which points
 * nowhere near the cause.
 */
const settle = () => new Promise((r) => setTimeout(r, 0));

after(async () => {
  await settle();
  teardown();
});
beforeEach(() => cleanup());
afterEach(async () => {
  cleanup();
  await settle();
});

const PLAN = [
  { key: "Production wireless batteries fresh", text: "Wireless batteries fresh", done: false },
  { key: "Production co2 tank hooked up", text: "CO2 tank hooked up", done: true },
];

describe("which list the object shows", () => {
  test("the PLAN's rows, when the object has none of its own", () => {
    // The whole point of the change: an object with nothing stored is not empty,
    // it shows the checklist the operator keeps in Planning Center.
    const { rows } = checklistRows([], PLAN);
    assert.deepEqual(
      rows.map((r) => r.text),
      ["Wireless batteries fresh", "CO2 tank hooked up"],
      "an object with no items of its own still showed nothing",
    );
  });

  test("carries each row's tick across, not just its text", () => {
    assert.deepEqual(checklistRows([], PLAN).rows.map((r) => r.done), [false, true]);
  });

  test("keys a row by the plan row's key, so a tick can be addressed", () => {
    assert.equal(checklistRows([], PLAN).rows[0].id, "Production wireless batteries fresh");
  });

  test("an object's OWN items still win, so no stored data is hidden", () => {
    const own = [{ id: "a", text: "Something stored", done: false }];
    assert.deepEqual(checklistRows(own, PLAN).rows.map((r) => r.text), ["Something stored"]);
  });

  test("is empty only when BOTH are", () => {
    assert.deepEqual(checklistRows([], []).rows, []);
  });

  test("says WHERE the rows came from, so a tick cannot be routed to the other store", () => {
    // The caller needs this answer to decide whether a tick writes to the plan
    // or to the object's own items, and it was computing `own.length === 0` a
    // second time to get it. Two derivations of one decision is a checkbox that
    // moves and then moves back: rows drawn from the plan, tick written to the
    // object's store, and the next render putting the plan's value straight back.
    assert.equal(checklistRows([], PLAN).fromPlan, true);
    assert.equal(checklistRows([{ id: "a", text: "Stored", done: false }], PLAN).fromPlan, false);
    // Empty on BOTH sides is still the plan's list — an object with no items of
    // its own has no store of its own to tick into.
    assert.equal(checklistRows([], []).fromPlan, true);
  });
});

/** Render with items arriving by prop — the same rows path the plan source uses. */
function renderWith(items: { id: string; text: string; done: boolean }[] | undefined, editable = true) {
  return render(
    React.createElement(ChecklistObject, {
      objectId: "obj-1",
      config: { title: "Pre-service" },
      editable,
      all: items ? { "obj-1": { items } } : undefined,
      ts: {},
    }),
  );
}

describe("the rows reach the screen", () => {
  test("renders its title", () => {
    renderWith(undefined);
    assert.ok(screen.getByText("Pre-service"), "the title never reached the DOM");
  });

  test("draws a row per item, with a real checkbox", () => {
    renderWith([
      { id: "a", text: "Wireless batteries fresh", done: false },
      { id: "b", text: "CO2 tank hooked up", done: true },
    ]);
    assert.ok(screen.getByText("Wireless batteries fresh"));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    assert.equal(boxes.length, 2, `drew ${boxes.length} checkboxes for 2 rows`);
    assert.equal(boxes[1].checked, true, "a ticked row rendered unticked");
  });

  test("CLICKING a box changes it — the control does something", () => {
    // The assertion the "+ row" bug needed. A box that renders and does not move
    // is the failure mode this file exists for.
    renderWith([{ id: "a", text: "Wireless batteries fresh", done: false }]);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    assert.equal(box.checked, false);
    fireEvent.click(box);
    assert.equal(
      (screen.getByRole("checkbox") as HTMLInputElement).checked,
      true,
      "the checkbox did not move when it was clicked",
    );
  });

  test("a wall display cannot tick anything", () => {
    renderWith([{ id: "a", text: "Wireless batteries fresh", done: false }], false);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    assert.equal(box.disabled, true, "a passer-by could tick a row on a wall display");
  });
});

describe("the empty state points somewhere", () => {
  test("names what is missing, for somebody who can fix it", () => {
    // Not "No items yet". There is no way to add an item here, so saying the
    // list is empty without saying where the list comes from is the message that
    // let this widget sit dead on layouts for months.
    renderWith(undefined, true);
    assert.ok(screen.getByText(/no plan notes chosen/i), "the empty state points nowhere");
  });

  test("does not tell a wall display to go and change a setting", () => {
    renderWith(undefined, false);
    assert.ok(screen.getByText("Empty"), "a read-only screen showed operator instructions");
  });
});
