// header.test.tsx — the Baptisms header's Rebuild from raw action: which
// service it targets, when it is disabled, and that it confirms before
// writing and reports what the server actually changed.
//
// NOT proved here: the rendered TOOLTIP TEXT, or anything about the header's
// layout — see this file's own header comment for why (position: sticky, the
// ResizeObserver measurement, jsdom laying nothing out). Radix's Tooltip only
// mounts its content while open, and opening it in jsdom needs Radix's own
// hover/focus machinery — a different component's job to prove. What IS
// proved is the fact CLAUDE.md names ("a button that only errors is the
// failure"): the DISABLED attribute itself, driven through a stubbed fetch
// and the real confirm()/ConfirmHost flow, never a hand-rolled dialog stub.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { TooltipProvider, ConfirmHost } = await import("../../../components/ui/index.js");
const { BaptismHeader, describeBaptismRebuild } = await import("./header.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const IDLE: BaptismState = {
  mode: "grouped",
  phase: "idle",
  personNumber: 0,
  baptismIndex: 0,
  armed: false,
  segmentStartedAt: null,
  segmentAccumMs: 0,
  sessionStartedAt: null,
  finishedAt: null,
  people: [],
  pendingTestimonyMs: null,
  serviceTitle: null,
  serviceTypeId: null,
  planId: null,
  serviceKey: null,
};

function session(overrides: Partial<BaptismSession> = {}): BaptismSession {
  return {
    id: "bap-1",
    startedAt: "2026-09-20T15:00:00.000Z",
    finishedAt: "2026-09-20T15:17:23.000Z",
    people: [],
    title: "Sunday Gathering",
    serviceTypeId: null,
    planId: null,
    serviceKey: "weekend:plan-1:1100",
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  body: unknown;
}

/** `currentServiceKey` answers GET /api/service-timeline/current (null when
 *  nothing is recording); `rebuildAnswer` answers POST /api/baptism/rebuild. */
function stubFetch(opts: { currentServiceKey?: string | null; rebuildAnswer?: unknown } = {}) {
  const calls: FetchCall[] = [];
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => "" });
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ url, body });
    if (url.includes("/api/service-timeline/current")) {
      return ok(opts.currentServiceKey ? { serviceKey: opts.currentServiceKey, endedAt: null, items: [] } : null);
    }
    if (url.includes("/api/baptism/rebuild")) {
      return ok(opts.rebuildAnswer ?? { rows: 3, sessions: 1, updated: 1, added: 0, kept: 0 });
    }
    return ok({});
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function mount(
  state: BaptismState,
  sessions: BaptismSession[] = [],
  opts: Parameters<typeof stubFetch>[0] = {},
) {
  const { fetchFn, calls } = stubFetch(opts);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  let rebuiltCount = 0;
  const view = render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(BaptismHeader, {
        state,
        sessions,
        onRebuilt: () => {
          rebuiltCount += 1;
        },
      }),
      React.createElement(ConfirmHost),
    ),
  );
  await settle();
  return {
    view,
    calls,
    rebuiltCount: () => rebuiltCount,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

function rebuildButton(root: ParentNode): HTMLButtonElement {
  const btn = [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Rebuild from raw"));
  assert.ok(btn, "expected a Rebuild from raw button in the header's action group");
  return btn as HTMLButtonElement;
}

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const findButton = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((b) => text(b) === label) as HTMLElement | undefined;

test("nothing recorded yet disables the action, with no server round trip needed to know that", async () => {
  const { view, calls, restore } = await mount(IDLE, []);
  try {
    assert.equal(rebuildButton(view.container).disabled, true);
    fireEvent.click(rebuildButton(view.container));
    await settle();
    assert.equal(calls.some((c) => c.url.includes("/api/baptism/rebuild")), false, "a disabled button must not reach the server");
  } finally {
    restore();
  }
});

test("targets the current session's serviceKey when the page is showing one", async () => {
  const state: BaptismState = { ...IDLE, phase: "idle", finishedAt: "2026-09-20T15:17:23.000Z", serviceKey: "svc-current" };
  const { view, calls, restore } = await mount(state, [session({ serviceKey: "svc-old" })], { currentServiceKey: null });
  try {
    assert.equal(rebuildButton(view.container).disabled, false);
    fireEvent.click(rebuildButton(view.container));
    await settle();
    fireEvent.click(findButton(document.body, "Rebuild")!);
    await settle();
    const rebuild = calls.find((c) => c.url.includes("/api/baptism/rebuild"));
    assert.ok(rebuild, "expected a POST to /api/baptism/rebuild");
    assert.deepEqual(rebuild!.body, { serviceKey: "svc-current" });
  } finally {
    restore();
  }
});

test("falls back to the most recent past session's serviceKey when state.serviceKey is null", async () => {
  const { view, calls, restore } = await mount(IDLE, [session({ serviceKey: "svc-past" })], { currentServiceKey: null });
  try {
    assert.equal(rebuildButton(view.container).disabled, false);
    fireEvent.click(rebuildButton(view.container));
    await settle();
    fireEvent.click(findButton(document.body, "Rebuild")!);
    await settle();
    const rebuild = calls.find((c) => c.url.includes("/api/baptism/rebuild"));
    assert.deepEqual(rebuild!.body, { serviceKey: "svc-past" });
  } finally {
    restore();
  }
});

test("disabled while the target service is still recording", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-live" };
  const { view, restore } = await mount(state, [], { currentServiceKey: "svc-live" });
  try {
    assert.equal(rebuildButton(view.container).disabled, true, "a live service must disable the action rather than only error on click");
  } finally {
    restore();
  }
});

test("a DIFFERENT service recording live does not disable this one", async () => {
  const state: BaptismState = { ...IDLE, phase: "idle", finishedAt: "2026-09-20T15:17:23.000Z", serviceKey: "svc-finished" };
  const { view, restore } = await mount(state, [], { currentServiceKey: "svc-someone-else-is-recording" });
  try {
    assert.equal(rebuildButton(view.container).disabled, false);
  } finally {
    restore();
  }
});

test("cancelling the confirm reaches neither the server nor onRebuilt", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-a" };
  const { view, calls, rebuiltCount, restore } = await mount(state, [], { currentServiceKey: null });
  try {
    fireEvent.click(rebuildButton(view.container));
    await settle();
    fireEvent.click(findButton(document.body, "Cancel")!);
    await settle();
    assert.equal(calls.some((c) => c.url.includes("/api/baptism/rebuild")), false);
    assert.equal(rebuiltCount(), 0);
  } finally {
    restore();
  }
});

test("confirming calls onRebuilt so Past sessions and Trends can refresh", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-a" };
  const { view, rebuiltCount, restore } = await mount(state, [], {
    currentServiceKey: null,
    rebuildAnswer: { rows: 5, sessions: 2, updated: 1, added: 1, kept: 0 },
  });
  try {
    fireEvent.click(rebuildButton(view.container));
    await settle();
    fireEvent.click(findButton(document.body, "Rebuild")!);
    await settle();
    assert.equal(rebuiltCount(), 1, "onRebuilt must fire exactly once after a successful rebuild");
  } finally {
    restore();
  }
});

test("describeBaptismRebuild names updated, added, newer and kept — never just a bare count", () => {
  assert.equal(
    describeBaptismRebuild({ rows: 5, sessions: 6, updated: 1, added: 1, newer: 1, kept: 3 }),
    "Rebuilt from raw: 1 updated, 1 added, 1 newer than their rows, 3 left alone",
  );
});
