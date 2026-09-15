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

import { installDom } from "../test-dom.js";

const teardown = installDom();

// The widget reads its bays from the render context, not from a stream, but
// `ObjectContent` reaches hooks that open one on other branches.
class NoStream {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx, DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");

after(() => {
  cleanup();
  teardown();
});

const BASE_BAY = {
  id: "c1::7",
  connectionId: "c1",
  bay: 7,
  chargerIndex: 1,
  connectionName: "Rack charger",
  name: "MA: 5-8 · Bay 7",
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

/** Render the charger object over one bay and return the text it drew. */
function textFor(bay: Partial<ChargerBayDTO>, show: Record<string, boolean> = { battery: true, charging: true }): string {
  cleanup();
  const merged = { ...BASE_BAY, ...bay };
  const ctx = makeRenderCtx({
    state: { ...DEFAULT_STAGE_STATE, chargerBays: [merged] },
  });
  const obj = {
    id: "o1",
    x: 0, y: 0, w: 0.3, h: 0.1, z: 1,
    config: { type: "charger-battery", bays: [{ id: merged.id }], show },
    style: {},
  } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o: obj, ctx }));
  return container.textContent ?? "";
}

describe("the charger widget draws a faulted bay as faulted", () => {
  test("the error code is on screen", () => {
    const text = textFor({ fault: "Error 007" });
    assert.ok(
      text.includes("Error 007"),
      `a faulted bay drew no fault. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("and it does not pretend the bay is empty", () => {
    // "empty" is what a spare shelf reads. A pack that has failed in the dock is
    // the opposite of a bay with nothing in it.
    assert.ok(!textFor({ fault: "Error 007" }).includes("empty"));
  });

  test("a bay with no battery in it still reads empty", () => {
    assert.ok(textFor({ online: false }).includes("empty"));
  });

  test("a healthy bay draws its figures and no fault", () => {
    const text = textFor({ battery: 100, fault: null });
    assert.ok(text.includes("100%"));
    assert.ok(!text.includes("Error"));
  });
});

describe("time to full and storage mode", () => {
  test("a charging bay says when it will be ready", () => {
    const text = textFor({ battery: 62, charging: true, timeToFullMinutes: 83 });
    assert.ok(
      text.includes("1:23"),
      `"will this pack be ready before the service" went unanswered. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("a full bay reports no time to full and draws none", () => {
    assert.ok(!textFor({ battery: 100, timeToFullMinutes: null }).includes(":"));
  });

  test("storage mode explains a shelf of bays stopped at 40%", () => {
    const text = textFor({ battery: 40, storageMode: true });
    assert.ok(
      text.includes("storage"),
      `nothing explained why a full charger stopped at 40%. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("and a charger not in storage mode says nothing about it", () => {
    assert.ok(!textFor({ battery: 100, storageMode: false }).includes("storage"));
  });
});

describe("the bay label", () => {
  test("the operator's connection name still wins", () => {
    assert.ok(textFor({}).includes("Rack charger · Bay 7"));
  });

  test("an unnamed connection falls back to the charger's own DEVICE_ID", () => {
    // This is what used to read "Charger 1 · Bay 7" while the unit itself was
    // called "MA: 5-8".
    const text = textFor({ connectionName: null });
    assert.ok(
      text.includes("MA: 5-8 · Bay 7"),
      `the device's own name went unused. Saw: ${JSON.stringify(text)}`,
    );
  });

  test("and with neither, the index is still better than nothing", () => {
    assert.ok(textFor({ connectionName: null, name: null }).includes("Charger 1 · Bay 7"));
  });
});
