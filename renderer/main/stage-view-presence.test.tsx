// renderer/main/stage-view-presence.test.tsx — the presence heartbeat's own
// cadence and its `video` field, driven through the REAL StageView effect
// rather than by reading stage-view.tsx's source. A source-text guard would
// pass on the exact defect it exists for — a wrong constant read but never
// scheduled, a `video` key spelled right but always undefined — so this
// renders the real component, fakes the clock, and asserts on the actual
// POST bodies fetch received.
//
// Modeled on stage-view-paths.test.tsx's own harness (StubEventSource, a
// stubbed fetch, the two providers renderer/main/index.tsx wraps the view
// in), narrowed to the one effect this file is about. `mock.timers` is
// enabled here, which stage-view-paths.test.tsx's shared `settle()` (a REAL
// setTimeout) cannot cross — this file drains with `setImmediate` instead,
// left un-mocked, the same pattern video-object.test.tsx's `settleFake` uses.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, mock, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

const presencePosts: { body: Record<string, unknown> }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/state") {
    return { ok: true, status: 200, json: async () => stageState(), text: async () => "" };
  }
  if (url === "/api/displays/presence" && init?.method === "POST") {
    presencePosts.push({ body: JSON.parse(String(init.body)) });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { StageView } = await import("./stage-view.js");
const { __resetForTests } = await import("./use-stage-state.js");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { __resetPlaybackRegistryForTests, registerPlayback, VIDEO_HEARTBEAT_MS } = await import("./video/playback-reports.js");

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** Drains the real microtask queue without depending on the fake clock this
 *  file controls — `setImmediate` is a different API than `setTimeout`, left
 *  un-mocked by `mock.timers.enable({ apis: ["setTimeout"] })` below. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

function stageState(): Record<string, unknown> {
  return {
    serviceTypeName: "Weekend", planTitle: "A plan", planSeriesTitle: null, planDates: null,
    showQr: false, remoteUrl: null, appName: "Stage Utility", appLogo: null,
    appLogoMonochrome: false, emptySlotLogo: null, defaultAvatar: null,
    pcoConfigured: true, hourCycle: "12h", accentColor: null,
    views: [{ id: "v1", name: "Mic board", kind: "slots" }],
    outputs: [{ id: "display-1", name: "Stage left", viewId: "v1" }],
    resolvedByOutput: {
      "display-1": { viewId: "v1", kind: "slots", ndiSource: null, viewName: "Mic board", blackout: false, locked: false, hideTopBar: false },
    },
    slotsByView: {}, slotsByLayoutObject: {}, notesByObject: {},
    barItems: [], savedColors: [], captionChannelColors: {},
    allowedServiceTypeIds: [], checklistNoteCategories: [], checklistNoteTeams: [],
  };
}

after(async () => {
  cleanup();
  await flush();
  teardown();
});
beforeEach(() => {
  cleanup();
  __resetForTests();
  __resetPlaybackRegistryForTests();
  presencePosts.length = 0;
});
afterEach(async () => {
  cleanup();
  await flush();
});

test("nothing playing: the heartbeat's slow (60s) cadence, and no video field", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    window.history.replaceState({}, "", "/display-1");
    await act(async () => {
      render(
        React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(TooltipProvider, null, React.createElement(StageView))),
      );
      await flush();
    });

    assert.equal(presencePosts.length, 1, "expected the initial ping on mount");
    assert.equal("video" in presencePosts[0]!.body, false, "expected no video field with nothing registered");

    await act(async () => {
      mock.timers.tick(59_999);
      await flush();
    });
    assert.equal(presencePosts.length, 1, "the slow cadence must not fire early");

    await act(async () => {
      mock.timers.tick(1);
      await flush();
    });
    assert.equal(presencePosts.length, 2, "expected the second ping at 60s");
    assert.equal("video" in presencePosts[1]!.body, false);
  } finally {
    mock.timers.reset();
  }
});

test("something playing: the heartbeat speeds up to VIDEO_HEARTBEAT_MS and carries a video field; unregistering slows it back down", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    window.history.replaceState({}, "", "/display-1");
    await act(async () => {
      render(
        React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(TooltipProvider, null, React.createElement(StageView))),
      );
      await flush();
    });
    assert.equal(presencePosts.length, 1);

    const report = { feedId: "feed-1", via: "hls" as const, decoded: 30, dropped: 1, stalls: 0, width: 1920, height: 1080 };
    // registerPlayback flips anyPlaying() false -> true, which reschedules the
    // pending (slow, 60s) timer immediately, the same way the pco:live
    // listener already reschedules the moment `near` flips — the widget does
    // not have to wait out whatever was left of the 60s wait it interrupted.
    const unregister = registerPlayback("obj-1", async () => report);

    await act(async () => {
      mock.timers.tick(VIDEO_HEARTBEAT_MS - 1);
      await flush();
    });
    assert.equal(presencePosts.length, 1, "must not fire before VIDEO_HEARTBEAT_MS");

    await act(async () => {
      mock.timers.tick(1);
      await flush();
    });
    assert.equal(presencePosts.length, 2, "expected the sped-up ping at VIDEO_HEARTBEAT_MS, not 60s later");
    assert.deepEqual(presencePosts[1]!.body.video, [report]);

    // Unregistering flips anyPlaying() back to false, rescheduling immediately
    // onto the slow cadence again, timed from THIS moment.
    unregister();

    await act(async () => {
      mock.timers.tick(59_999);
      await flush();
    });
    assert.equal(presencePosts.length, 2, "expected no ping this soon once nothing is playing again");

    await act(async () => {
      mock.timers.tick(1);
      await flush();
    });
    assert.equal(presencePosts.length, 3, "expected the next ping exactly 60s after unregistering");
    assert.equal("video" in presencePosts[2]!.body, false, "expected no video field once unregistered");
  } finally {
    mock.timers.reset();
  }
});

test("a preview never heartbeats, playing video or not", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    window.history.replaceState({}, "", "/preview-v1");
    const unregister = registerPlayback("obj-1", async () => ({
      feedId: "feed-1", via: "hls" as const, decoded: 1, dropped: 0, stalls: 0, width: 100, height: 100,
    }));
    try {
      await act(async () => {
        render(
          React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(TooltipProvider, null, React.createElement(StageView))),
        );
        await flush();
      });
      await act(async () => {
        mock.timers.tick(10 * 60_000);
        await flush();
      });
      assert.equal(presencePosts.length, 0, "a preview iframe must never heartbeat, video playing or not");
    } finally {
      unregister();
    }
  } finally {
    mock.timers.reset();
  }
});
