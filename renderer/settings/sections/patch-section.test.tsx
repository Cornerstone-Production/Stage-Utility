// patch-section.test.tsx — a failed read on the Patch page says so.
//
// A failed `patch:get` used to put an EMPTY patch file in front of the
// operator: a blank Analog sheet that looked like a new install, and that Save
// would have written over the real patch. A failed stage-state read hid
// "This week" as though no plan were loaded. Neither said a word.
//
// Driven through the real component with a stubbed fetch. NOTHING BELOW PASSES
// A DOM NODE AS AN ASSERT OPERAND — node:assert inspects `actual` to build its
// failure message, and inspecting a live jsdom element does not finish in any
// useful time. Every query is coerced to a boolean or a string first.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { PatchSection } = await import("./patch-section.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
// The weekly panel reads the page's one stage state, which is cached for the
// whole page; without the resets, a case that failed that read hands the
// failure to the next.
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const FILE: PatchFile = {
  sheets: [
    {
      id: "analog",
      name: "Stage left",
      kind: "analog",
      devices: [],
      endpoints: [],
      variants: [],
      assignments: { byServiceType: {}, byPlan: {} },
    },
  ],
  updatedAt: "2026-09-20T12:00:00.000Z",
};

const PLAN = { serviceTypeId: "st1", planId: "p1", planTitle: "Sunday" };

/** Answer the page's reads, throwing on the one named. */
function stubFetch(failing: "patch" | "state" | null) {
  return stubFetchWithLog((url) => {
    if (url.endsWith("/api/patch")) {
      if (failing === "patch") throw new TypeError("fetch failed");
      return ok(FILE);
    }
    if (url.includes("/api/state")) {
      if (failing === "state") throw new TypeError("fetch failed");
      return ok({ ...PLAN, allowedServiceTypeIds: [], pcoConfigured: true });
    }
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    return ok({});
  });
}

async function mount(): Promise<void> {
  render(React.createElement(PatchSection));
  await settle();
  await settle();
}

test("a failed patch read says so and offers no editable empty patch", async () => {
  const f = stubFetch("patch");
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the patch/i);
    // The editor is absent entirely — not a blank sheet a Save would write back.
    assert.equal(!!screen.queryByLabelText("Sheet name"), false, "must not offer an empty sheet to edit");
    assert.equal(!!screen.queryByRole("button", { name: "Analog" }), false, "must not draw the blank default sheet");
    assert.ok(
      f.logs.some((l) => l.tag === "patch" && /the patch/i.test(l.message)),
      `expected a [patch] line naming the patch — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("a failed stage-state read says the plan could not load, not that there is none", async () => {
  const f = stubFetch("state");
  try {
    await mount();
    assert.equal(!!screen.queryByRole("button", { name: "Stage left" }), true, "the patch itself loaded");
    assert.match(alerts(), /Couldn't load the current plan/i);
    assert.ok(
      // Its own line. The Weekly assignment panel reads the same stage state and
      // logs "…the Plan tab enables", which a bare /plan/ would accept instead.
      f.logs.some((l) => l.tag === "patch" && /the current plan/i.test(l.message)),
      `expected a [patch] line naming the plan — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("control: both reads load, This week is offered and nothing alerts", async () => {
  const f = stubFetch(null);
  try {
    await mount();
    assert.equal(!!screen.queryByRole("button", { name: "Stage left" }), true);
    assert.equal(!!screen.queryByRole("option", { name: /This week/ }), true, "a loaded plan offers This week");
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});
