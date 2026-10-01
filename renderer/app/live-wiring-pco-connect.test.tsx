// The operator app refetches what depends on Planning Center when PCO
// CONNECTS — not on every integrations:state-changed message while it is
// connected.
//
// The channel carries every integration's state and fires on a change to any
// of them: about every twenty seconds on prod on a Sunday (27 Sep 2026). The
// handler checked "is PCO connected?" rather than "did it just connect?", so
// each message re-downloaded the stage state (60 KB), the service types and the
// plans, in every open tab, for as long as the tab stayed open.
//
// Driven through the real hook and the real onNotification, with pushes on a
// fake EventSource; what is counted is invalidateQueries on the three keys.

import { strict as assert } from "node:assert";
import { after, beforeEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { render, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useStageLiveWiring } = await import("./live-wiring.js");
const { QUERY_KEYS } = await import("./queries.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");

/** Every client a case made, cleared at the end: a live one holds cache timers
 *  that keep the process from exiting after the last case. */
const clients: InstanceType<typeof QueryClient>[] = [];
after(() => {
  for (const qc of clients) qc.clear();
  unmountAndTeardown(cleanup, teardown);
});
beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});

const states = (pco: "connected" | "disconnected", otherMessage = "ok") => [
  { id: "planning-center", enabled: true, connection: pco, message: null, config: {} },
  // Some other integration whose change is what fired the message.
  { id: "companion", enabled: true, connection: "error", message: otherMessage, config: {} },
];

/** Mount the wiring with a query client whose invalidations are counted. */
function mount(serviceTypesLoaded: boolean) {
  const qc = new QueryClient();
  clients.push(qc);
  if (serviceTypesLoaded) qc.setQueryData(QUERY_KEYS.serviceTypes, [{ id: "41227", name: "Weekend" }]);
  const invalidated: string[] = [];
  const real = qc.invalidateQueries.bind(qc);
  qc.invalidateQueries = ((filters?: { queryKey?: readonly unknown[] }) => {
    invalidated.push(String(filters?.queryKey?.[0]));
    return real(filters);
  }) as typeof qc.invalidateQueries;
  function Wired() {
    useStageLiveWiring(null);
    return null;
  }
  render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(Wired)));
  return { invalidated };
}

const push = (payload: unknown) => act(async () => FakeEventSource.last?.push("integrations:state-changed", payload));

test("messages while PCO stays connected refetch nothing", async () => {
  const { invalidated } = mount(true);
  await settle();
  for (let i = 0; i < 5; i++) await push(states("connected", `change ${i}`));
  assert.deepEqual(invalidated, []);
});

test("PCO connecting refetches the stage state, the service types and the plans once", async () => {
  const { invalidated } = mount(true);
  await settle();
  await push(states("disconnected"));
  await push(states("connected"));
  await push(states("connected", "later change"));
  assert.deepEqual(invalidated.sort(), ["stage:getState", "stage:listPlans", "stage:listServiceTypes"].sort());
});

test("a page that opened while PCO was down refetches on the first message saying it is up", async () => {
  // The first message a page hears cannot say whether PCO JUST connected; a
  // page holding no service types opened without it.
  const { invalidated } = mount(false);
  await settle();
  await push(states("connected"));
  assert.equal(invalidated.length, 3);
});
