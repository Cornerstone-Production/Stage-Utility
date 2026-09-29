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

/** Every presence POST, with the fake clock's time when fetch received it. */
const presencePosts: { at: number; body: Record<string, unknown> }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/state") {
    return { ok: true, status: 200, json: async () => stageState(), text: async () => "" };
  }
  if (url === "/api/displays/presence" && init?.method === "POST") {
    presencePosts.push({ at: Date.now(), body: JSON.parse(String(init.body)) });
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
 *  un-mocked by `mock.timers.enable({ apis: ["setTimeout", "Date"] })` below. */
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
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
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
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
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

    // Unregistering flips anyPlaying() back to false. A slower cadence must
    // not push out the ping already pending: it still fires VIDEO_HEARTBEAT_MS
    // after the last one, and only the one after it waits the slow 60s.
    unregister();

    await act(async () => {
      mock.timers.tick(VIDEO_HEARTBEAT_MS - 1);
      await flush();
    });
    assert.equal(presencePosts.length, 2, "the pending ping must not fire early");

    await act(async () => {
      mock.timers.tick(1);
      await flush();
    });
    assert.equal(presencePosts.length, 3, "unregistering must keep the pending ping, not push it out to 60s");
    assert.equal("video" in presencePosts[2]!.body, false, "expected no video field once unregistered");

    await act(async () => {
      mock.timers.tick(59_999);
      await flush();
    });
    assert.equal(presencePosts.length, 3, "after that ping, nothing playing is the slow cadence again");

    await act(async () => {
      mock.timers.tick(1);
      await flush();
    });
    assert.equal(presencePosts.length, 4, "expected the next ping 60s after the last one");
  } finally {
    mock.timers.reset();
  }
});

test("a picture flapping between playing and not still pings at least every 60s", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    window.history.replaceState({}, "", "/display-1");
    await act(async () => {
      render(
        React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(TooltipProvider, null, React.createElement(StageView))),
      );
      await flush();
    });
    assert.equal(presencePosts.length, 1, "expected the initial ping on mount");

    // A widget that plays for 9 s, then loses its picture for 30 s while its
    // retry backs off, ten times over. Every flip changes the cadence, and
    // each one used to restart the wait, so the 10 s cadence never came due
    // and the 60 s one never had the chance: one ping in 390 s, well past
    // the server's 90 s presence TTL.
    const report = { feedId: "feed-1", via: "webrtc" as const, decoded: 270, dropped: 0, stalls: 0, width: 1280, height: 720 };
    const advance = async (ms: number) => {
      // One second at a time, so a POST's recorded time is within a second of
      // when its timer fired rather than the end of a long tick.
      for (let t = 0; t < ms; t += 1000) {
        await act(async () => {
          mock.timers.tick(1000);
          await flush();
        });
      }
    };
    for (let cycle = 0; cycle < 10; cycle++) {
      const unregister = registerPlayback("obj-1", async () => report);
      await advance(9_000);
      unregister();
      await advance(30_000);
    }

    const times = presencePosts.map((p) => p.at);
    const gaps = times.slice(1).map((at, i) => at - times[i]!);
    gaps.push(Date.now() - times[times.length - 1]!);
    const longest = Math.max(...gaps);
    assert.ok(longest <= 60_000, `expected a ping at least every 60 s; the longest gap was ${longest} ms over ${presencePosts.length} pings`);
  } finally {
    mock.timers.reset();
  }
});

test("a playback sampler that never answers delays the heartbeat by at most 2 s, and the beat goes without video", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const unregister = registerPlayback("obj-1", () => new Promise(() => {}));
  try {
    window.history.replaceState({}, "", "/display-1");
    await act(async () => {
      render(
        React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(TooltipProvider, null, React.createElement(StageView))),
      );
      await flush();
    });
    assert.equal(presencePosts.length, 0, "sanity: the mount ping is waiting on the sampler");

    await act(async () => {
      mock.timers.tick(2_000);
      await flush();
    });
    assert.equal(presencePosts.length, 1, "the mount ping must go out 2 s later, not wait on the sampler forever");
    assert.equal("video" in presencePosts[0]!.body, false, "a beat that gave up on the samplers carries no video field");

    // To the next ping's due time, then past its 2 s wait, as two ticks: a
    // mock tick runs every callback at the tick's END time, so a timer set
    // inside one long tick would land late.
    await act(async () => {
      mock.timers.tick(VIDEO_HEARTBEAT_MS - 2_000);
      await flush();
    });
    assert.equal(presencePosts.length, 1, "sanity: the next ping is waiting on the sampler");
    await act(async () => {
      mock.timers.tick(2_000);
      await flush();
    });
    assert.equal(presencePosts.length, 2, "the next ping must go out within the interval plus 2 s");
    assert.equal(presencePosts[1]!.at, VIDEO_HEARTBEAT_MS + 2_000);
    assert.equal("video" in presencePosts[1]!.body, false);
  } finally {
    unregister();
    mock.timers.reset();
  }
});

test("a preview never heartbeats, playing video or not", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
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
