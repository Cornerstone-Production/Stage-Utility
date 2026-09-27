// The layout data layer reads a source only when something on screen draws it.
//
// Every layout surface — Home, a custom View on a wall, a console, a Screens
// preview — goes through useLayoutData, and useLayoutData and seven other
// surfaces go through useDashboardState. Six sources in there were read and
// subscribed unconditionally, so a Home of status cards and a wall showing one
// clock both fetched the baptism timer, the plan rundown, the service timeline,
// the integration list and two ProPresenter snapshots, and held their channels
// for as long as the page was up. ProPresenter's status is the expensive one:
// the server keeps its fallback poll at full rate while ANY client subscribes.
//
// Reads are counted per endpoint, never as a total: the state stream and the
// hooks that were already gated issue reads of their own, and a total would move
// with every one of them. Subscriptions are read from what the client REPORTS to
// the server (/api/events/subscribe), not from the EventSource: api.ts attaches a
// cache listener for every hydrated channel on its own, deliberately unreported,
// so the wire listeners say nothing about what the server sends.
//
// gate-render-parity.test.ts is the other half. It holds every widget arm to the
// gate for each channel it reads, so a new widget reading ctx.baptism fails there
// rather than drawing a timer that never fills. What it cannot see is whether a
// gate does anything at all — that is here.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
// One that delivers, so a case can push a live frame. None of the others do.
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

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
const { useLayoutData } = await import("./layout-renderer.js");
const { useDashboardState, useProPresenterStatus } = await import("./use-dashboard-state.js");
const { LAYOUT_OBJECTS, usesPropInstance } = await import("./layout-objects.js");
const { DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
const { HOME_VIEW_ID, defaultHomeLayout } = await import("@main/services/home-view");

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

describe("useDashboardState, which eight surfaces call for the stage state and PCO Live", () => {
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

/** Every type the registry marks as reading a ProPresenter instance — derived,
 *  so a new one that the gate in useLayoutData forgets fails here. */
const PRO_TYPES = Object.keys(LAYOUT_OBJECTS).filter((t) => usesPropInstance(t as keyof typeof LAYOUT_OBJECTS));

/**
 * Each source useLayoutData gates, the read and channel it costs, and every
 * widget type that draws it. The spec: a layout holding one of `openers` pays
 * for the source, and a layout holding none of them does not.
 *
 * The plan rundown names no channel. It refetches on `stage:state-changed`,
 * which every layout surface holds anyway for the stage state itself, so the
 * read is the whole of what it costs.
 */
const SOURCES: Record<string, { read: string; channel: string | null; openers: readonly string[] }> = {
  baptism: { read: "/api/baptism", channel: "baptism:state", openers: ["baptism-timer"] },
  integrations: { read: "/api/integrations", channel: "integrations:state-changed", openers: ["integration-status"] },
  planItems: { read: "/api/pco/plan-items", channel: null, openers: ["service-order", "service-pacing"] },
  propInstances: { read: "/api/propresenter/instances", channel: "propresenter:instances", openers: PRO_TYPES },
  propresenter: { read: "/api/propresenter/status", channel: "propresenter:status", openers: PRO_TYPES },
  serviceTimeline: {
    read: "/api/service-timeline/current",
    channel: "service-timeline:history",
    openers: ["people-graph", "service-pacing"],
  },
};

let nextId = 0;
function object(type: string): LayoutObject {
  const spec = LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS];
  assert.ok(spec, `${type} is not a registered object type`);
  return { id: `o${nextId++}`, x: 0, y: 0, w: 0.5, h: 0.5, z: 1, config: spec.config(), style: spec.style() };
}

function layoutOf(...types: string[]): LayoutDTO {
  return { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: types.map(object) };
}

/** A clock and a caption: the wall screen that should cost nothing extra. */
const PLAIN = () => layoutOf("clock", "text");

/** useLayoutData as a custom View calls it: its layout, and its own id. */
const useViewData = (layout?: LayoutDTO) => useLayoutData(layout, "v-under-test");

/** Every source a layout paid for although nothing placed draws it. */
async function unwanted(): Promise<string[]> {
  const channels = await subscribed();
  const out: string[] = [];
  for (const [name, s] of Object.entries(SOURCES)) {
    if (count(s.read) > 0) out.push(`${name}: read ${s.read} ${count(s.read)} time(s)`);
    if (s.channel && channels.has(s.channel)) out.push(`${name}: subscribed ${s.channel}`);
  }
  return out;
}

describe("a layout that draws none of a source neither reads it nor subscribes to it", () => {
  test("a wall showing a clock and a caption", async () => {
    await mount(useViewData, PLAIN());
    assert.deepEqual(await unwanted(), []);
  });

  test("Home's default cards", async () => {
    await mount((l) => useLayoutData(l, HOME_VIEW_ID), defaultHomeLayout() as LayoutDTO);
    assert.deepEqual(await unwanted(), []);
  });
});

describe("a placed widget still gets its source", () => {
  for (const [name, s] of Object.entries(SOURCES)) {
    for (const type of s.openers) {
      // The harness sends no SSE frames, so this is the mount read alone.
      test(`${name}: a lone ${type} reads ${s.read} on mount`, async () => {
        await mount(useViewData, layoutOf(type));
        assert.equal(count(s.read), 1, `${type} draws ${name}; ${s.read} was read ${count(s.read)} time(s)`);
      });
    }

    const first = s.openers[0];
    test(`${name}: a ${first} added to an open layout opens the source, and removing it closes it`, async () => {
      const { rerender } = await mount(useViewData, PLAIN());
      const before = count(s.read);
      await rerender(layoutOf("clock", first));
      assert.equal(count(s.read) - before, 1, `adding ${first} to an open layout never read ${s.read}`);
      if (s.channel) {
        assert.ok((await subscribed()).has(s.channel), `adding ${first} never subscribed ${s.channel}`);
        await rerender(PLAIN());
        assert.ok(!(await subscribed()).has(s.channel), `removing ${first} left ${s.channel} subscribed`);
      }
    });
  }

  test("planItems: a plan that changed while nothing drew it is read once when a widget arrives", async () => {
    // Why usePlanItems gates its fetch and not its listener: the listener keeps
    // tracking the plan while off, so the replayed frame that follows switching
    // on names a plan it has already seen, and only the mount read goes out. A
    // gated listener comes back knowing no plan and reads a second time.
    const { rerender } = await mount(useViewData, PLAIN());
    FakeEventSource.last!.push("stage:state-changed", { ...STATE, planId: "p1" });
    await settle();
    assert.equal(count("/api/pco/plan-items"), 0, "a plan change read the rundown with nothing drawing it");
    await rerender(layoutOf("clock", "service-order"));
    assert.equal(count("/api/pco/plan-items"), 1, "switching on read the rundown more than once");
  });

  test("a widget inside an embedded view opens its source for the layout that embeds it", async () => {
    STATE = {
      ...DEFAULT_STAGE_STATE,
      views: [
        {
          id: "v-embedded",
          name: "Baptisms",
          kind: "custom",
          createdAt: "2026-01-01T00:00:00.000Z",
          layout: layoutOf("baptism-timer"),
        } as View,
      ],
    };
    const embed = object("view-embed");
    embed.config = { ...embed.config, viewId: "v-embedded" } as LayoutObjectConfig;
    await mount(useViewData, { ...PLAIN(), objects: [embed] });
    assert.equal(count("/api/baptism"), 1, "the embedded baptism timer never got its read");
    assert.ok((await subscribed()).has("baptism:state"), "the embedded baptism timer's channel was never subscribed");
  });

  test("the layout editor, which passes no layout, reads and subscribes every source for its previews", async () => {
    await mount(() => useLayoutData());
    const channels = await subscribed();
    for (const [name, s] of Object.entries(SOURCES)) {
      assert.equal(count(s.read), 1, `the editor's ${name} preview read ${s.read} ${count(s.read)} time(s)`);
      if (s.channel) assert.ok(channels.has(s.channel), `the editor never subscribed ${s.channel}`);
    }
  });
});
