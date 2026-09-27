// useOptionSources(), remounted the way the layout editor's action-button
// Inspector remounts it: once per selection.
//
// react-query's default staleTime is 0, so a bare useQuery re-fetches on every
// remount even when nothing behind it could plausibly have changed a moment
// later. Selecting between four action buttons issued ~28 GETs for lists none
// of them used — six sources, refetched on each of four selections (plus the
// first mount), all for a param picker nobody opened. Reverting
// OPTION_SOURCE_STALE_MS's use in useOptionSources() (or dropping it back to
// 0) turns this red.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useOptionSources } = await import("./automation-option-sources.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** Every route useOptionSources's six direct queries can hit — the ones this
 *  fix gives a staleTime. Stage state / service types are deliberately NOT
 *  counted: they live in the shared renderer/app/queries.ts, outside this
 *  module, so this fix does not touch their caching. */
const OPTION_ROUTES = [
  "/api/rosstalk/targets",
  "/api/rosstalk/commands",
  "/api/osc/targets",
  "/api/automation/plan-items",
  "/api/automation/propresenter-instances",
  "/api/automation/propresenter-macros",
];

function Harness() {
  useOptionSources();
  return null;
}

test("remounting the hook four times (like switching between four buttons) fetches each option source once, not four times", async () => {
  const counts = new Map<string, number>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const hit = OPTION_ROUTES.find((r) => url.includes(r));
    if (hit) counts.set(hit, (counts.get(hit) ?? 0) + 1);
    const body: unknown = url.includes("/api/rosstalk/commands") || url.includes("/api/automation/plan-items")
      ? []
      : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;

  try {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const el = () =>
      React.createElement(QueryClientProvider, { client }, React.createElement(Harness));

    // Four remounts, exactly the shape ActionButtonInspector produces when the
    // operator selects a different button on the canvas: the whole component
    // (and every hook in it, including this one) unmounts and remounts.
    for (let i = 0; i < 4; i++) {
      const view = render(el());
      await settle();
      view.unmount();
    }

    for (const route of OPTION_ROUTES) {
      assert.equal(counts.get(route) ?? 0, 1, `expected ${route} fetched once across four remounts, got ${counts.get(route) ?? 0}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
