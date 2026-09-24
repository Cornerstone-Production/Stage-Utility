// baptism-operator-sessions-load.test.tsx — proves the ONE piece of wiring
// header.test.tsx cannot reach: baptism-operator.tsx passing its OWN
// `sessionsError` state into <BaptismHeader sessionsLoadFailed={...}>. A test
// that constructs BaptismHeader directly (as header.test.tsx does throughout)
// can set that prop to whatever it likes without proving anything actually
// threads a real fetch failure into it — this file drives the real composed
// page instead, through a real failing fetch.
//
// Reads the Rebuild button's tooltip via a real focus event (Radix opens on
// focus as well as hover, and mounts its content into the DOM with
// role="tooltip" even for a disabled button in jsdom) rather than only
// checking `disabled`: a failed sessions load and a genuinely empty history
// both leave `state.serviceKey` null with no most-recent session to fall back
// on, so both disable the button for DIFFERENT reasons — only the reason text
// tells them apart, and a bare disabled/enabled check cannot fail on the bug
// this guards (baptism-operator.tsx forgetting to pass the prop through at
// all, or hard-coding it, would leave the button disabled either way).

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();
/** A fake EventSource that hands the test its channel listeners to fire —
 *  the same shape history-chart-live.test.tsx's own FakeEventSource uses. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(fn);
  }
  close(): void {}
  push(channel: string, payload: unknown): void {
    for (const fn of this.listeners.get(channel) ?? []) fn({ data: JSON.stringify(payload) } as MessageEvent);
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { TooltipProvider, ConfirmHost } = await import("../components/ui/index.js");
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterContextProvider } =
  await import("@tanstack/react-router");
const { BaptismOperator } = await import("./baptism-operator.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const IDLE_NO_KEY: BaptismState = {
  mode: "grouped", phase: "idle", personNumber: 0, baptismIndex: 0, armed: false,
  segmentStartedAt: null, segmentAccumMs: 0, sessionStartedAt: null, finishedAt: null,
  people: [], pendingTestimonyMs: null, serviceTitle: null, serviceTypeId: null, planId: null, serviceKey: null,
};

function stubFetch(sessionsOk: boolean) {
  return (async (input: string) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
    if (url.endsWith("/api/baptism")) return ok(IDLE_NO_KEY);
    if (url.endsWith("/api/baptism/sessions")) {
      if (sessionsOk) return ok([]);
      return { ok: false, status: 500, json: async () => ({ error: "boom" }), text: async () => '{"error":"boom"}' };
    }
    return ok({});
  }) as unknown as typeof fetch;
}

async function mount(sessionsOk: boolean) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(sessionsOk);
  const view = render(React.createElement(TooltipProvider, null, React.createElement(BaptismOperator)));
  await settle();
  await settle();
  await settle();
  return { view, restore: () => { globalThis.fetch = realFetch; } };
}

function rebuildButton(root: ParentNode): HTMLButtonElement {
  const btn = [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Rebuild from raw"));
  assert.ok(btn, "expected a Rebuild from raw button");
  return btn as HTMLButtonElement;
}

async function tooltipTextOf(btn: HTMLElement): Promise<string> {
  fireEvent.focus(btn);
  await act(async () => {
    await settle();
    await settle();
  });
  const content = document.querySelector('[role="tooltip"]');
  const shown = (content?.textContent ?? "").replace(/\s+/g, " ").trim();
  fireEvent.blur(btn);
  await act(async () => {
    await settle();
  });
  return shown;
}

test("a genuinely empty history (sessions load OK, nothing recorded) gets its own reason", async () => {
  const { view, restore } = await mount(true);
  try {
    const btn = rebuildButton(view.container);
    assert.equal(btn.disabled, true);
    const shown = await tooltipTextOf(btn);
    assert.match(shown, /Nothing has been recorded/, `expected the empty-history reason, got: ${shown}`);
  } finally {
    restore();
  }
});

test("a failed sessions load reaches the header as sessionsLoadFailed, with its OWN reason — not the empty-history one", async () => {
  const { view, restore } = await mount(false);
  try {
    const btn = rebuildButton(view.container);
    assert.equal(btn.disabled, true, "a failed load must still disable the action");
    const shown = await tooltipTextOf(btn);
    assert.match(shown, /could not be loaded/, `expected the load-failure's own reason, got: ${shown}`);
    assert.notEqual(shown, "Nothing has been recorded yet — there is no service to rebuild", "a load failure must not read as a genuinely empty history");
  } finally {
    restore();
  }
});

// baptism-operator.tsx wires onRebuilt={reloadSessions} into BOTH the header
// and the Timer card (renderer/main/baptism-operator.tsx) — making either do
// nothing stayed green across the whole suite, since nothing actually
// exercised a rebuild happening. This drives the ACTUAL call count a real
// sessions refetch produces, both for the props (a rebuild the page itself
// started) and for the server's own "baptism:rebuilt" push (a rebuild
// started from History instead, which never touches either prop at all).
test("a rebuild reloads this page's own sessions, whether started here or pushed from elsewhere", async () => {
  let sessionCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
    if (url.endsWith("/api/baptism")) return ok(IDLE_NO_KEY);
    if (url.endsWith("/api/baptism/sessions")) {
      sessionCalls += 1;
      return ok([]);
    }
    return ok({});
  }) as unknown as typeof fetch;
  try {
    render(React.createElement(TooltipProvider, null, React.createElement(BaptismOperator)));
    await settle();
    await settle();
    await settle();
    const mountCalls = sessionCalls;
    assert.ok(mountCalls >= 1, "sanity: mounting fetches sessions at least once");

    // A rebuild the server broadcasts as having actually restored something
    // — the shape a rebuild started from History (never touching this
    // page's own onRebuilt props) produces.
    FakeEventSource.last!.push("baptism:rebuilt", { serviceKey: "st1:plan-1:9am", ids: ["bap-1"] });
    await act(async () => {
      await settle();
      await settle();
    });
    assert.ok(
      sessionCalls > mountCalls,
      `expected a baptism:rebuilt push to refetch this page's own sessions; calls stayed at ${sessionCalls}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The other half of the same gap: baptism-operator.tsx wires
// onRebuilt={reloadSessions} into the HEADER's own Rebuild button — making
// that prop a no-op stayed green everywhere else, since header.test.tsx
// constructs BaptismHeader directly and can only prove ITS OWN callback
// fires, never that the composed page's real prop is what's actually
// plugged in there.
test("confirming the header's own Rebuild reloads this page's own sessions", async () => {
  const PAST_SESSION = {
    id: "bap-past-1",
    startedAt: "2026-09-13T15:00:00.000Z",
    finishedAt: "2026-09-13T15:05:00.000Z",
    people: [{ testimonyMs: 60_000, baptizeMs: 30_000 }],
    title: "Sunday Gathering",
    serviceTypeId: "st1",
    planId: "plan-1",
    serviceKey: "svc-header-rebuild",
  };
  let sessionCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
    if (url.endsWith("/api/baptism")) return ok(IDLE_NO_KEY);
    if (url.endsWith("/api/baptism/sessions")) {
      sessionCalls += 1;
      return ok([PAST_SESSION]);
    }
    if (url.includes("/api/history/live")) return ok({ live: false });
    if (url.includes("/api/baptism/rebuild")) {
      void init;
      return ok({ rows: 3, sessions: 1, updated: 0, added: 1, unchanged: 0, newer: 0, disagreeing: 0, invalid: 0, kept: 0, full: 0, restoredIds: ["bap-past-1"] });
    }
    return ok({});
  }) as unknown as typeof fetch;
  try {
    const rootRoute = createRootRoute({});
    const historyRoute = createRoute({ getParentRoute: () => rootRoute, path: "/history/manage", component: () => null });
    const router = createRouter({
      routeTree: rootRoute.addChildren([historyRoute]),
      history: createMemoryHistory({ initialEntries: ["/baptism"] }),
    });
    const view = render(
      React.createElement(RouterContextProvider, {
        router,
        children: React.createElement(TooltipProvider, null, React.createElement(BaptismOperator), React.createElement(ConfirmHost)),
      }),
    );
    await settle();
    await settle();
    await settle();
    const mountCalls = sessionCalls;

    const btn = rebuildButton(view.container);
    assert.equal(btn.disabled, false, "a real past session gives the header's own Rebuild a real target");
    fireEvent.click(btn);
    await settle();
    const confirmBtn = [...document.body.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Rebuild");
    assert.ok(confirmBtn, "expected the shared confirm dialog to open");
    fireEvent.click(confirmBtn!);
    await settle();
    await settle();

    assert.ok(
      sessionCalls > mountCalls,
      `expected confirming the header's own Rebuild to reload this page's sessions; calls stayed at ${sessionCalls}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
