// The charger widget has to SAY the three things the driver now knows.
//
// Rendered rather than reasoned about, because the defect is a widget that draws
// perfectly and tells you nothing. Bay 7 of a real SBC220 has a failed pack in
// it. It answers BATT_DETECTED YES, so it is not "empty"; every numeric it
// answers is a marker, so every figure it draws is a dash. Before this it drew a
// row of dashes, which reads as "no data yet" — the same thing a charger that
// has only just connected draws.
//
// WHAT THIS DOES NOT COVER: jsdom loads no stylesheet, so `var(--red-10)` on the
// fault and the truncation of a long label are not asserted here — they resolve
// to nothing and every offsetHeight is 0. Those were checked in a browser
// against a real charger connection. What IS here is the part jsdom can answer
// honestly: which text reaches the DOM for which bay state.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { eventually, installRenderDom, isPlumbing, readLedger, unmountAndTeardown } from "../test-dom.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installRenderDom();

// The widget draws the render context's bays until `wireless:chargers` answers,
// and its read of /api/integrations/wireless/chargers answers the same bays, as
// the server would. Everything else this reaches is answered empty.
(globalThis as { EventSource?: unknown }).EventSource = NoStream;
let served: ChargerBayDTO[] = [];
const reads = readLedger();
(globalThis as { fetch?: unknown }).fetch = async (input: unknown) => {
  // The live-update subscription posts on its own schedule; it is not a read the widget waits on.
  if (isPlumbing(String(input))) return { ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "{}" };
  reads.begin(String(input));
  const body = String(input).includes("/api/integrations/wireless/chargers") ? served : {};
  return reads.answer({ ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) });
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx, DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");

// Unmount, let React finish what the renders started, then take the DOM away. A fixed wait
// here was a guess at how long the effect flush takes; it flushes after the DOM is gone on a
// machine slow enough, and the file fails with "window is not defined".
after(() => unmountAndTeardown(cleanup, teardown));

const BASE_BAY = {
  id: "c1::7",
  connectionId: "c1",
  bay: 7,
  chargerIndex: 1,
  connectionName: "Rack charger",
  name: "RF: 5-8 · Bay 7",
  online: true,
  battery: null,
  charging: null,
  cycles: null,
  health: null,
  tempC: null,
  timeToFullMinutes: null,
  fault: null,
  storageMode: null,
} satisfies ChargerBayDTO;

/** Render the charger object over one bay and return the text it drew. The render is inside
 *  act, and the widget's own read of the bays is waited for, so nothing it started is left
 *  for React's scheduler to run after the test has ended. */
async function textFor(bay: Partial<ChargerBayDTO>, show: Record<string, boolean> = { battery: true, charging: true }): Promise<string> {
  cleanup();
  const merged = { ...BASE_BAY, ...bay };
  served = [merged];
  const ctx = makeRenderCtx({
    state: { ...DEFAULT_STAGE_STATE, chargerBays: [merged] },
  });
  const obj = {
    id: "o1",
    x: 0, y: 0, w: 0.3, h: 0.1, z: 1,
    config: { type: "charger-battery", bays: [{ id: merged.id }], show },
    style: {},
  } as never;
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(React.createElement(ObjectContent as never, { o: obj, ctx })));
  });
  await eventually(reads.landed);
  return container.textContent ?? "";
}

describe("the charger widget draws a faulted bay as faulted", () => {
  test("the error code is on screen", async () => {
    const text = await textFor({ fault: "Error 007" });
    assert.ok(
      text.includes("Error 007"),
      `a faulted bay drew no fault. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("and it does not pretend the bay is empty", async () => {
    // "empty" is what a spare shelf reads. A pack that has failed in the dock is
    // the opposite of a bay with nothing in it.
    assert.ok(!(await textFor({ fault: "Error 007" })).includes("empty"));
  });

  test("a bay with no battery in it still reads empty", async () => {
    assert.ok((await textFor({ online: false })).includes("empty"));
  });

  test("a healthy bay draws its figures and no fault", async () => {
    const text = await textFor({ battery: 100, fault: null });
    assert.ok(text.includes("100%"));
    assert.ok(!text.includes("Error"));
  });
});

describe("time to full and storage mode", () => {
  test("a charging bay says when it will be ready", async () => {
    const text = await textFor({ battery: 62, charging: true, timeToFullMinutes: 83 });
    assert.ok(
      text.includes("1:23"),
      `"will this pack be ready before the service" went unanswered. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("a full bay reports no time to full and draws none", async () => {
    assert.ok(!(await textFor({ battery: 100, timeToFullMinutes: null })).includes(":"));
  });

  test("storage mode explains a shelf of bays stopped at 40%", async () => {
    const text = await textFor({ battery: 40, storageMode: true });
    assert.ok(
      text.includes("storage"),
      `nothing explained why a full charger stopped at 40%. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("and a charger not in storage mode says nothing about it", async () => {
    assert.ok(!(await textFor({ battery: 100, storageMode: false })).includes("storage"));
  });
});

describe("the bay label", () => {
  test("the operator's connection name still wins", async () => {
    assert.ok((await textFor({})).includes("Rack charger · Bay 7"));
  });

  test("an unnamed connection falls back to the charger's own DEVICE_ID", async () => {
    // This is what used to read "Charger 1 · Bay 7" while the unit itself was
    // called "RF: 5-8".
    const text = await textFor({ connectionName: null });
    assert.ok(
      text.includes("RF: 5-8 · Bay 7"),
      `the device's own name went unused. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("and with neither, the index is still better than nothing", async () => {
    assert.ok((await textFor({ connectionName: null, name: null })).includes("Charger 1 · Bay 7"));
  });
});
