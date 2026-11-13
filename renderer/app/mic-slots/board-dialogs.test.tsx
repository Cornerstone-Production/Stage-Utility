// The Copy from dialog's plan list, rendered over a stubbed server: each plan is
// named by its date, and that date is the server's, as the switcher's is.
//
// The copy itself, and every other source, is driven through the page in
// mic-slots-page.test.tsx.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: node:assert inspects
// `actual` to build its message, and a live jsdom element does not finish.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";

import { installRenderDom, isPlumbing, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const PLAN = { serviceTypeId: "st-sun", serviceTypeName: "Sunday", planId: "p1", title: "Sunday", sortDate: "2026-09-13T14:00:00Z", dates: "September 13, 2026", isCurrent: true };

/** What GET /api/state answers: the app's zone and the server clock's. */
let stageState: { timezone: string | null; hostTimezone: string } = { timezone: null, hostTimezone: "UTC" };

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  let body: unknown = {};
  if (isPlumbing(url)) body = {};
  else if (url.includes("/api/plans/upcoming")) body = { plans: [PLAN], cacheAgeMs: 0 };
  else if (url.includes("/api/state")) body = stageState;
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CopyFromDialog } = await import("./board-dialogs.js");
const { planLabel } = await import("../../settings/sections/slots-target-pill.js");
const { __resetForTests } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { serverZoneApartFromBrowser } = await import("../../test-fixtures/zones.js");

let client: InstanceType<typeof QueryClient> | null = null;

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(CopyFromDialog, {
        title: "Copy every board",
        description: "From where",
        boards: [],
        onClose: () => {},
        onCopy: async () => true,
      }),
    ),
  );
}

/** Every label the dialog's source list offers, as strings. */
function offered(): string[] {
  const select = screen.getAllByLabelText("Copy from").find((el) => el.tagName === "SELECT") as HTMLSelectElement | undefined;
  return select ? [...select.options].map((o) => o.textContent ?? "") : [];
}

beforeEach(() => {
  cleanup();
  __resetForTests();
  __resetReplayCacheForTests();
});
afterEach(async () => {
  cleanup();
  await settle();
  client?.clear();
  client = null;
});
after(() => unmountAndTeardown(cleanup, teardown));

test("with no app time zone set, a plan is named by its date on the server's clock", async () => {
  const host = serverZoneApartFromBrowser(PLAN.sortDate);
  stageState = { timezone: null, hostTimezone: host };
  mount();
  await settle();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "A plan" }));
  });
  await settle();
  const want = `${planLabel(PLAN.sortDate, null, host)} · Sunday`;
  assert.ok(offered().includes(want), `want "${want}" among ${JSON.stringify(offered())}`);
});
