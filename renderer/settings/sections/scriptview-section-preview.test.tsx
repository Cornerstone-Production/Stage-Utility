// The ScriptView layout editor: what its "Shows" list offers, and the ground its
// preview draws the rundown on.
//
// Both are things that render, keep every other test green, and are wrong:
//
//   the Time signature entry   delete one line of ELEMENTS and the switch is gone
//                              from the editor while the rundown, the spec and
//                              their tests all still work — there was simply no
//                              way left to turn the time signature off
//   the preview's kiosk ground the preview sits in the LIGHT app, where
//                              `--color-fg-strong` resolves to #000 unless
//                              `.kiosk-surface` re-declares it, so notes drew
//                              black on the near-black panel
//
// Driven through the real section with a stubbed fetch. NOTHING BELOW PASSES A DOM
// NODE AS AN ASSERT OPERAND — see scriptview-section-reads.test.tsx.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { ScriptViewSection } = await import("./scriptview-section.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const RUNDOWN: ScriptViewRundownDTO = {
  serviceTypeId: "st1",
  planId: "p1",
  planTitle: "Sunday",
  planSeriesTitle: null,
  planDates: null,
  items: [
    { id: "i1", title: "Opening song", itemType: "song", lengthSec: 300, sequence: 0, notesByCategory: { Audio: "Kick up" }, description: null },
  ],
  noteCategories: ["Audio"],
  serviceTimes: [],
  timeZone: null,
  isActivePlan: false,
};

function stubFetch() {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok({ pcoConfigured: true });
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/scriptview/layouts")) return ok([{ id: "svl1", name: "Audio", order: 0, columnRoles: ["r1"] }]);
    if (url.includes("/api/scriptview/config")) return ok({ serviceTypeIds: ["st1"] });
    if (url.includes("/api/scriptview/roles")) return ok([{ id: "r1", name: "Sound", members: ["Audio"] }]);
    if (url.includes("/api/scriptview/note-categories")) return ok(["Audio"]);
    if (url.includes("/api/scriptview/rundown")) return ok(RUNDOWN);
    return ok({});
  });
}

async function mountOpen(): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(ScriptViewSection)));
  for (let i = 0; i < 4; i++) await settle();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  await settle();
  await settle();
}

test("the Shows list offers a Time signature switch, on for a layout saved without it", async () => {
  const f = stubFetch();
  try {
    await mountOpen();
    fireEvent.click(screen.getByRole("button", { name: /^Shows, Audio/ }));
    await settle();
    // Names read from the rendered list, in order: the time signature sits with
    // the other two pieces of song meta, between BPM and Arrangement.
    const labels = Array.from(document.querySelectorAll("[role=dialog] *"))
      .filter((e) => e.children.length === 0)
      .map((e) => e.textContent ?? "");
    const at = (name: string) => labels.indexOf(name);
    assert.ok(at("Time signature") > -1, `no Time signature switch in: ${JSON.stringify(labels)}`);
    assert.ok(at("BPM") < at("Time signature") && at("Time signature") < at("Arrangement"), JSON.stringify(labels));
    // Eight on, Max SPL (opt-in) off: the layout has no showMeter field at all.
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /^8 of 9/);
  } finally {
    f.restore();
  }
});

test("the layout preview draws the rundown on a kiosk ground", async () => {
  const f = stubFetch();
  try {
    await mountOpen();
    const table = document.querySelector("table");
    assert.equal(!!table, true, "the preview drew no rundown table");
    assert.equal(!!table?.closest(".kiosk-surface"), true, "the preview is off the kiosk ground: department notes draw #000 in the light app");
  } finally {
    f.restore();
  }
});
