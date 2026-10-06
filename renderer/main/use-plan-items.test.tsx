// usePlanItems must not re-fetch the plan on a replayed "stage:state-changed",
// and usePlanItemsStatus must read again after a failed read.
//
// The bug: the effect that refetches on a plan change compared the pushed
// `planId` against a ref that starts `undefined`, with no check on
// `onNotification`'s `replayed` flag. "stage:state-changed" is a hydrated
// channel (sse-channels.ts), so mounting into an already-open SSE stream
// replays its cached frame at once — a planId that (almost) always differs
// from the fresh `undefined` ref, so every mount fired a second, redundant
// `pco:getPlanItems` on top of the one the mount effect already issues.
//
// Driven through the REAL renderer/lib/api.ts over a fake EventSource, the
// same way use-status-channel.test.tsx proves its own replay-vs-live case —
// a stub of api.ts has no replay cache and would prove nothing.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

let planItemsReads = 0;
/** How many of the next plan-items reads fail, as a dropped connection would. */
let planItemsFailures = 0;
(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  // The invoke case for "pco:getPlanItems" issues GET /api/pco/plan-items.
  if (url.includes("/api/pco/plan-items")) {
    planItemsReads++;
    if (planItemsFailures > 0) {
      planItemsFailures--;
      throw new TypeError("fetch failed");
    }
  }
  return { ok: true, status: 200, json: async () => ({ items: [], columns: [] }), text: async () => "{}" };
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { usePlanItems, usePlanItemsStatus } = await import("./use-plan-items.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(async () => {
  cleanup();
  await settle();
});

function Probe(): React.ReactElement {
  usePlanItems();
  return React.createElement("output");
}

async function mount(): Promise<void> {
  render(React.createElement(Probe));
  await settle();
  await settle();
}

test("mount reads the plan once; a warm stage:state-changed replay reads it no more", async () => {
  planItemsReads = 0;
  __resetReplayCacheForTests();

  // Decoy mount: warms the replay cache with planId "p1", then goes away.
  await mount();
  await act(async () => FakeEventSource.last!.push("stage:state-changed", { planId: "p1" }));
  await settle();
  cleanup();
  await settle();

  const before = planItemsReads;
  // The real mount under test: "stage:state-changed" now has a cached frame,
  // handed to this mount as a replay.
  await mount();
  assert.equal(planItemsReads - before, 1, "exactly one read on mount, not two");
});

test("a live planId change reads the plan once more; the same planId does not", async () => {
  planItemsReads = 0;
  __resetReplayCacheForTests();

  await mount();
  await act(async () => FakeEventSource.last!.push("stage:state-changed", { planId: "p1" }));
  await settle();
  cleanup();
  await settle();

  await mount();
  let reads = planItemsReads;

  // Same planId, live — nothing changed, no read.
  await act(async () => FakeEventSource.last!.push("stage:state-changed", { planId: "p1" }));
  await settle();
  assert.equal(planItemsReads, reads, "an unchanged planId must not re-read the plan");

  // A different planId, live — a real plan switch, worth exactly one read.
  await act(async () => FakeEventSource.last!.push("stage:state-changed", { planId: "p2" }));
  await settle();
  assert.equal(planItemsReads, reads + 1, "a live planId change must read the plan once");
});

/** Renders what usePlanItemsStatus reports, as attributes a test can read. */
function StatusProbe({ enabled = true }: { enabled?: boolean }): React.ReactElement {
  const { known, failed } = usePlanItemsStatus(enabled, 15);
  return React.createElement("output", { "data-known": String(known), "data-failed": String(failed) });
}

const status = () => {
  const el = document.querySelector("output");
  return { known: el?.getAttribute("data-known"), failed: el?.getAttribute("data-failed") };
};

/** Real time, a few retry periods: the hook's retry is a timer, and this is the
 *  file's own 15 ms stand-in for its minute. */
async function waitRetries(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

test("a failed read is tried again, and stops once it has answered", async () => {
  planItemsReads = 0;
  planItemsFailures = 2;
  __resetReplayCacheForTests();

  render(React.createElement(StatusProbe));
  await settle();
  assert.deepEqual(status(), { known: "true", failed: "true" }, "the first read failed and says so");

  await waitRetries(8);
  assert.deepEqual(status(), { known: "true", failed: "false" }, "a later read answered, and the failure is gone");
  assert.equal(planItemsReads, 3, "two failures, then the read that worked");

  await waitRetries(4);
  assert.equal(planItemsReads, 3, "an answered read is not read again");
});

test("a hook that is switched off does not retry a failure", async () => {
  planItemsReads = 0;
  planItemsFailures = 1;
  __resetReplayCacheForTests();

  const view = render(React.createElement(StatusProbe, { enabled: true }));
  await settle();
  assert.equal(status().failed, "true");
  const afterFailure = planItemsReads;

  view.rerender(React.createElement(StatusProbe, { enabled: false }));
  await waitRetries(6);
  assert.equal(planItemsReads, afterFailure, "off means no reads, retries included");
});
