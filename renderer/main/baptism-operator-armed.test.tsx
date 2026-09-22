// The armed half of the panel is what the operator actually touches — and it
// was untested. Reverting the `!state.armed` term on the Pause/Resume button's
// render gate left the whole suite green: nothing rendered would have told a
// reviewer the panel regressed to offering "Resume" on a segment that never
// started. (The OTHER `!state.armed` term, on the `paused` computation itself,
// is unreachable while armed — the gate hides the whole block that reads
// `paused` — so reverting it alone changes nothing this test or anything else
// can observe. Both terms stay, for the invariant they each document, but only
// the gate is what this test actually proves.)
//
// Driven through the real component with a stubbed fetch answering
// `GET /api/baptism` with an armed session — not a unit test of the boolean
// expressions in isolation, because the bug this guards is what the operator
// SEES, not what a helper returns.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects
// `actual` to build its failure message, and inspecting a live jsdom element
// does not terminate in any useful time (a failing assertion here hung for
// over 20 seconds before this file coerced every query to a boolean first).

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { BaptismOperator } = await import("./baptism-operator.js");
const { TooltipProvider } = await import("../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const ARMED_STATE: BaptismState = {
  mode: "grouped",
  phase: "baptism",
  personNumber: 2,
  baptismIndex: 0,
  armed: true,
  segmentStartedAt: null,
  segmentAccumMs: 0,
  sessionStartedAt: "2026-09-20T15:00:00.000Z",
  finishedAt: null,
  people: [
    { testimonyMs: 45_000, baptizeMs: 0 },
    { testimonyMs: 38_000, baptizeMs: 0 },
  ],
  pendingTestimonyMs: null,
  serviceTitle: "9am",
  serviceTypeId: "svc-1",
  planId: "plan-1",
};

function stubFetch(state: BaptismState) {
  return (async (input: string) => {
    const url = String(input);
    if (url.endsWith("/api/baptism")) return { ok: true, status: 200, json: async () => state, text: async () => "" };
    if (url.endsWith("/api/baptism/sessions")) return { ok: true, status: 200, json: async () => [], text: async () => "" };
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;
}

async function mount(state: BaptismState = ARMED_STATE): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(state);
  try {
    render(React.createElement(TooltipProvider, null, React.createElement(BaptismOperator)));
    await settle();
    await settle();
  } finally {
    globalThis.fetch = realFetch;
  }
}

beforeEach(() => cleanup());

test("armed offers the arming press, not Resume", async () => {
  await mount();

  // The primary button is the arming press, not one of the ordinary phase
  // actions a running or paused segment would offer.
  assert.equal(!!screen.queryByText("Baptize person 1"), true, "expected the arming press as the primary action");

  // Nothing here may read as a paused clock. There is nothing banked to resume —
  // offering "Resume" is the regression this test exists to catch.
  assert.equal(!!screen.queryByText("Resume"), false, "armed must not offer Resume — nothing has been paused");
  assert.equal(!!screen.queryByText("Pause"), false, "armed must not offer Pause either — no clock is running to stop");
});

test("once the first press starts a real clock, Pause is offered again", async () => {
  await mount({
    ...ARMED_STATE,
    armed: false,
    segmentStartedAt: "2026-09-20T15:10:00.000Z",
  });

  assert.equal(!!screen.queryByText("Baptize person 1"), false, "the arming press must not linger once armed clears");
  assert.equal(!!screen.queryByText("Pause"), true, "a running clock must offer Pause");
});
