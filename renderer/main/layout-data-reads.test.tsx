// The layout data layer reads a source only when something on screen draws it.
//
// useDashboardState is what Home's route, the context bar, ScriptView, the SPL
// rundown and every layout surface call for the stage state. It also read
// ProPresenter's status and held its channel, for all of them, although only the
// dashboard and stage-display views and ProPresenter widgets draw it. That
// channel's subscribers keep the server's ProPresenter fallback poll at full
// rate, so every operator tab kept it there.
//
// Reads are counted per endpoint, never as a total: the state stream issues
// reads of its own, and a total would move with them. Subscriptions are read
// from what the client REPORTS to the server (/api/events/subscribe), not from
// the EventSource: api.ts attaches a cache listener for every hydrated channel on
// its own, deliberately unreported, so the wire listeners say nothing about what
// the server sends.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();

/** Every request path, query stripped, in order. */
let reads: string[] = [];
const count = (path: string) => reads.filter((p) => p === path).length;
/** Each channel set the client reported, oldest first. */
let reports: string[][] = [];

let STATE: StageState;

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const path = String(url).split("?")[0];
  if (path === "/api/events/subscribe") {
    reports.push((JSON.parse(String(init?.body)) as { channels: string[] }).channels);
  } else {
    reads.push(path);
  }
  const body =
    path === "/api/state"
      ? STATE
      : path === "/api/integrations"
        ? { descriptors: [], states: [] }
        : path === "/api/propresenter/instances"
          ? { list: [], status: {}, conn: {} }
          : path.includes("transcript")
            ? []
            : // Null for everything else: every hook here takes an empty answer as
              // "nothing yet", where a bare {} is a malformed manifest to some.
              null;
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { useDashboardState, useProPresenterStatus } = await import("./use-dashboard-state.js");
const { DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

STATE = DEFAULT_STAGE_STATE;

/**
 * The channels the server is currently told this client renders.
 *
 * The report is debounced 200 ms after the channel set last changed, and reads
 * the set when it fires, so the newest report after that wait is the set as it
 * stands.
 */
async function subscribed(): Promise<Set<string>> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 230));
  });
  assert.ok(reports.length > 0, "the client never reported its channels — nothing below would mean anything");
  return new Set(reports[reports.length - 1]);
}

/** Render a component that only calls `useHooks`, and let its reads land. */
async function mount(useHooks: (layout?: LayoutDTO) => void, layout?: LayoutDTO) {
  function Probe({ layout: l }: { layout?: LayoutDTO }) {
    useHooks(l);
    return null;
  }
  let rerender!: (next?: LayoutDTO) => Promise<void>;
  await act(async () => {
    const r = render(React.createElement(Probe, { layout }));
    rerender = async (next?: LayoutDTO) => {
      await act(async () => {
        r.rerender(React.createElement(Probe, { layout: next }));
      });
      await settle();
      await settle();
    };
  });
  await settle();
  await settle();
  return { rerender };
}

beforeEach(() => {
  reads = [];
  reports = [];
  STATE = DEFAULT_STAGE_STATE;
});
afterEach(async () => {
  cleanup();
  await settle();
  resetStageState();
  resetReplayCache();
});
after(() => unmountAndTeardown(cleanup, teardown));

describe("useDashboardState, which six surfaces call for the stage state and PCO Live", () => {
  test("neither reads nor subscribes to ProPresenter's status", async () => {
    await mount(() => useDashboardState());
    assert.equal(count("/api/pco/live"), 1, "the PCO Live read is what this hook is for — it was not made");
    assert.equal(count("/api/propresenter/status"), 0, "a surface that never draws ProPresenter read its status");
    assert.ok(!(await subscribed()).has("propresenter:status"), "a surface that never draws ProPresenter holds its channel");
  });

  test("useProPresenterStatus reads and subscribes for a surface that draws it", async () => {
    await mount(() => useProPresenterStatus());
    assert.equal(count("/api/propresenter/status"), 1);
    assert.ok((await subscribed()).has("propresenter:status"));
  });

  test("useProPresenterStatus switched off reads nothing and subscribes to nothing", async () => {
    await mount(() => useProPresenterStatus(false));
    assert.equal(count("/api/propresenter/status"), 0);
    assert.ok(!(await subscribed()).has("propresenter:status"));
  });
});
