// The charger widget follows a bay's level as it changes, with no stage-state
// frame behind it.
//
// Stage state carries the bays, but the server re-sends it only when something
// structural changes; a pack charging from 40 to 77 percent arrives on
// `wireless:chargers` alone. A widget that drew only the state's copy showed 40
// until somebody saved a layout.

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { installRenderDom, isPlumbing } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const bay = (battery: number): ChargerBayDTO => ({
  id: "c1::3", connectionId: "c1", bay: 3, chargerIndex: 1, connectionName: "Rack charger", name: null,
  online: true, battery, charging: true, cycles: null, health: null, tempC: null, timeToFullMinutes: null, fault: null, storageMode: null,
});

(globalThis as { fetch?: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  const body = isPlumbing(url) ? {} : url.includes("/api/integrations/wireless/chargers") ? [bay(40)] : {};
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx, DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

after(async () => {
  cleanup();
  await settle();
  teardown();
});

test("a charger bay's new level reaches the widget without a stage-state frame", async () => {
  const ctx = makeRenderCtx({ state: { ...DEFAULT_STAGE_STATE, chargerBays: [bay(40)] } });
  const obj = {
    id: "o1", x: 0, y: 0, w: 0.3, h: 0.1, z: 1,
    config: { type: "charger-battery", bays: [{ id: "c1::3" }], show: { battery: true } },
    style: {},
  } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o: obj, ctx }));
  await settle();
  assert.ok((container.textContent ?? "").includes("40%"), `did not draw the bay: ${container.textContent}`);
  await act(async () => FakeEventSource.last?.push("wireless:chargers", [bay(77)]));
  await settle();
  assert.ok((container.textContent ?? "").includes("77%"), `the widget held the old level: ${container.textContent}`);
});
