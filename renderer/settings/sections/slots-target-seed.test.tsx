// What the slot editor SEEDS FROM when the operator is on the Default side.
//
// Both editors used to mirror `stageState.slotsByView[id]` (and the inline one
// `slotsByLayoutObject[id]`) into the grid. That is the board IN EFFECT — the
// current plan's override when there is one — not the side being edited. On the
// Default side with a live override it therefore showed the OVERRIDE's rows,
// marked them saved, and the next Save wrote this week's exception onto the
// service type's standing board. The same read was repeated after apply-preset
// and after copy-slots, off `next.slotsByView`.
//
// The seed now comes from `useSlotsTarget().slotsForSide`, and that is what is
// under test here: the hook is driven for real, over a stubbed fetch answering
// the real `/api/views/:id/slot-targets` route shape, with an override present.
//
// NOT covered here, and driven in a browser instead: that use-stage-settings'
// `useResyncOn` mirror actually re-runs after `slotsTarget.invalidate()`
// resolves. That needs the whole settings hook — five query hooks, a live SSE
// state, `confirm()` and `toast()` — and there is no harness for it in this
// repo. What IS covered is the value it seeds from, which is where the wrong
// board came from.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** api.ts subscribes over SSE on mount; this connects to nothing. */
class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

const VIEW = "v-seed";
const TYPE = "st-seed";
const PLAN = "plan-seed";

/** A slot identified by its CHANNEL, because the ids are not what distinguishes
 *  the two boards — the rows are. */
function slot(channel: string): Slot {
  return {
    id: `slot-${channel}`,
    channel,
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] },
    deviceBinding: null,
    displayName: null,
    photoUrl: null,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
  } as unknown as Slot;
}

/** The board saved for THIS PLAN. Different rows from the default, on purpose. */
let overrideSlots: Slot[] | null = [slot("week")];

const STATE = {
  appName: "Stage",
  accentColor: null,
  hourCycle: "12h",
  serviceTypeId: TYPE,
  serviceTypeName: "Sunday",
  planId: PLAN,
  planDates: "September 13, 2026",
  timezone: "UTC",
  // Deliberately the OVERRIDE's rows: this is the board in effect, and it is
  // exactly what the old seed read.
  slotsByView: { [VIEW]: [slot("week")] },
  slotsByLayoutObject: {},
} as unknown as StageState;

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  const body = url.includes("/slot-targets")
    ? {
        scope: "view",
        key: VIEW,
        serviceTypeId: TYPE,
        serviceTypeName: "Sunday",
        planId: PLAN,
        planDates: "September 13, 2026",
        planSortDate: "2026-09-13T14:00:00Z",
        defaultSlots: [slot("standing")],
        overrideSlots,
      }
    : url.includes("/api/state")
      ? STATE
      : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useSlotsTarget } = await import("./slots-target-pill.js");
const { __resetForTests } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

/**
 * Let the hydrate and the slot-targets read settle inside act().
 *
 * Several macrotasks, not one: the state hydrate, the query's fetch and the
 * re-render it causes are three separate turns, and a single tick left whichever
 * case ran FIRST reading "…" — a test that passed or failed on order.
 */
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

/** Renders the channels the grid would be seeded with, and a way to switch side. */
function Probe({ side }: { side: "default" | "plan" }): React.ReactElement {
  const t = useSlotsTarget("view", VIEW);
  React.useEffect(() => {
    t.setSide(side);
    // Set once per requested side; `t` is a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side]);
  return React.createElement(
    "div",
    { "data-testid": "seed" },
    (t.slotsForSide ?? []).map((s) => s.channel).join(",") || (t.slotsForSide ? "empty" : "…"),
  );
}

/** The client the current case mounted, so afterEach can drop its timers. */
let client: InstanceType<typeof QueryClient> | null = null;

function mount(side: "default" | "plan") {
  // gcTime 0, and cleared below. react-query keeps a garbage-collection timeout
  // per cached query, and a live timeout keeps Node's loop alive: with the
  // default five minutes this file rendered its results and then sat there until
  // it was killed, which is the failure mode this repo has already paid for once.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe, { side }),
    ),
  );
}

beforeEach(() => {
  cleanup();
  __resetForTests();
  __resetReplayCacheForTests();
  overrideSlots = [slot("week")];
});
afterEach(async () => {
  cleanup();
  await settle();
  client?.clear();
  client = null;
});
after(async () => {
  await settle();
  teardown();
});

describe("the rows the editor seeds from", () => {
  test("the Default side shows the DEFAULT even while an override is in effect", async () => {
    mount("default");
    await settle();
    assert.equal(
      screen.getByTestId("seed").textContent,
      "standing",
      "the in-effect board is this week's exception; seeding the editor from it showed the override's rows as if they were the default, and the next Save wrote them onto the service type's standing board",
    );
  });

  test("the plan side shows the plan's own board", async () => {
    mount("plan");
    await settle();
    assert.equal(screen.getByTestId("seed").textContent, "week");
  });

  test("the plan side falls back to the default when the plan has no board", async () => {
    overrideSlots = null;
    mount("plan");
    await settle();
    assert.equal(
      screen.getByTestId("seed").textContent,
      "standing",
      "a plan with no exception is editing a copy of the default, not an empty grid",
    );
  });
});
