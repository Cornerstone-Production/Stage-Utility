// view-surface-handler.test.tsx — the view card's "what this view is for",
// driven through the REAL settings hook: useStageSettings inside a query client,
// the real confirm dialog, the real api.ts, and a stubbed fetch that records
// every request.
//
// This replaces source-text assertions over the handler. Three faithful
// regressions passed those: sending the wrong surface, sending before asking,
// and asking about the wrong view, and a `while` loop over screens slipped past
// a regex written for `for`. Here each is what the stub records or what the
// dialog shows, so each fails.
//
// Not here: that the handler reads the cache at click time rather than a
// snapshot the hook closed over. The server now refuses a stale list of screens
// (409 screens-changed, main/services/view-role.test.ts), and the re-ask is
// driven below, so a stale read is caught where it would do harm.
//
// The dialog is the real ConfirmHost and is answered with a click. jsdom loads
// no stylesheet, so nothing here proves how the dialog looks; that was driven in
// a browser.
//
// Every id and name is invented.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();

const { renderHook, screen, cleanup, fireEvent, act, waitFor } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ConfirmHost } = await import("../components/ui/index.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");
const { useStageSettings } = await import("./use-stage-settings.js");

type StageState = import("@main/types/stage").StageState;

after(() => unmountAndTeardown(cleanup, teardown));

const layout = { version: 1, canvas: { width: 1920, height: 1080 }, objects: [] };

/** A view listed BEFORE the one under test, so the hook's default selection is
 *  not the view being changed: asking about the selected view instead of the
 *  one clicked is one of the regressions this file exists for. */
function seedState(): StageState {
  return {
    views: [
      { id: "first-a", name: "Welcome loop", kind: "custom", surface: "display", layout },
      { id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", layout },
      { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", layout },
    ],
    outputs: [
      { id: "display-0", name: "Entry TV", viewId: "first-a" },
      { id: "display-1", name: "Lobby TV", viewId: "wall-a" },
      { id: "display-2", name: "Hallway TV", viewId: "wall-a" },
      { id: "display-3", name: "Booth panel", viewId: "ctl-a" },
      { id: "display-5", name: "Spare", viewId: null },
    ],
  } as unknown as StageState;
}

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

type Reply = { status: number; body: unknown };

/** GETs answer the seeded state at /api/state and an empty list elsewhere. A
 *  write answers from `writes`, one per write in order; past the end, 200 and
 *  the state. */
const isPlumbing = (url: string) => url.startsWith("/api/events");
const isWrite = (c: Call) => c.method !== "GET" && !isPlumbing(c.url);

function stubFetch(state: StageState, writes: Reply[] = []) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    const answer = (r: Reply) =>
      ({ ok: r.status < 400, status: r.status, statusText: String(r.status), json: async () => r.body, text: async () => "" }) as unknown as Response;
    if (method === "GET") return answer({ status: 200, body: url.endsWith("/api/state") ? state : [] });
    // The live-update subscription posts on its own schedule; on a slow runner it
    // lands mid-test. It is plumbing, not one of the handler's writes, so it is
    // answered apart and never takes one of the scripted replies.
    if (isPlumbing(url)) return answer({ status: 200, body: {} });
    const n = calls.filter(isWrite).length - 1;
    return answer(writes[n] ?? { status: 200, body: state });
  }) as typeof fetch;
  return {
    calls,
    /** The writes the handler made: every request that was not a read, nor the
     *  live-update subscription's. */
    writes: () => calls.filter(isWrite),
    restore: () => { globalThis.fetch = real; },
  };
}

/** Every client made, to clear after each test: a query's garbage-collection
 *  timer otherwise holds the file open for five minutes after the last test. */
const clients: InstanceType<typeof QueryClient>[] = [];

function mountHook(state: StageState) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  clients.push(client);
  client.setQueryData(["stage:getState"], state);
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children, React.createElement(ConfirmHost));
  return renderHook(() => useStageSettings(), { wrapper });
}

/** Start the handler without awaiting it: it waits on the dialog. */
function start(hook: ReturnType<typeof mountHook>, id: string, surface: "display" | "console"): Promise<void> {
  let done!: Promise<void>;
  act(() => { done = hook.result.current.handlers.handleSetViewSurface(id, surface); });
  return done;
}

const dialog = () => screen.queryByRole("alertdialog");

/** The confirm, once it is open and says `says`. Waited for rather than assumed
 *  after a fixed number of ticks: on a slow CI runner the ask, a 409 and the
 *  re-ask take more turns than on a laptop. */
async function opened(says?: RegExp): Promise<HTMLElement> {
  return waitFor(
    () => {
      const d = dialog();
      assert.ok(d, "no confirm opened");
      if (says) assert.match(d.textContent!, says);
      return d;
    },
    { timeout: 5000 },
  );
}

beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
});

describe("making a view a control surface", () => {
  test("the dialog names the screens showing the view, and nothing is sent while it is open", async () => {
    const f = stubFetch(seedState());
    try {
      const hook = mountHook(seedState());
      await settle();
      const done = start(hook, "wall-a", "console");
      await opened(/Make "Lobby loop" a control surface\?/);
      assert.match(dialog()!.textContent!, /Buttons will work on "Lobby TV" and "Hallway TV"/);
      assert.deepEqual(f.writes(), [], "a write went out before the operator answered");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await settle();
      await done;
    } finally {
      f.restore();
    }
  });

  test("declining sends nothing", async () => {
    const f = stubFetch(seedState());
    try {
      const hook = mountHook(seedState());
      await settle();
      const done = start(hook, "wall-a", "console");
      await opened();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await settle();
      await done;
      assert.deepEqual(f.writes(), []);
    } finally {
      f.restore();
    }
  });

  test("confirming sends exactly one POST to the view's surface route, with the surface and the screens named", async () => {
    const f = stubFetch(seedState());
    try {
      const hook = mountHook(seedState());
      await settle();
      const done = start(hook, "wall-a", "console");
      await opened();
      fireEvent.click(screen.getByRole("button", { name: "Make it a control surface" }));
      await settle();
      await done;
      assert.deepEqual(f.writes(), [
        { method: "POST", url: "/api/views/wall-a/surface", body: { surface: "console", screens: ["display-1", "display-2"] } },
      ]);
    } finally {
      f.restore();
    }
  });
});

describe("making a view a wall display", () => {
  test("names its screens as wall displays, and sends display", async () => {
    const f = stubFetch(seedState());
    try {
      const hook = mountHook(seedState());
      await settle();
      const done = start(hook, "ctl-a", "display");
      await opened(/"Booth panel" becomes read-only/);
      fireEvent.click(screen.getByRole("button", { name: "Make it a wall view" }));
      await settle();
      await done;
      assert.deepEqual(f.writes(), [
        { method: "POST", url: "/api/views/ctl-a/surface", body: { surface: "display", screens: ["display-3"] } },
      ]);
    } finally {
      f.restore();
    }
  });
});

describe("a view no screen shows", () => {
  test("asks nothing, and sends that it asked about no screens", async () => {
    const state = seedState();
    state.outputs = state.outputs.filter((o) => o.viewId !== "wall-a");
    const f = stubFetch(state);
    try {
      const hook = mountHook(state);
      await settle();
      const done = start(hook, "wall-a", "console");
      await settle();
      await done;
      assert.equal(dialog(), null, "a confirm opened with nothing to confirm");
      assert.deepEqual(f.writes(), [
        { method: "POST", url: "/api/views/wall-a/surface", body: { surface: "console", screens: [] } },
      ]);
    } finally {
      f.restore();
    }
  });
});

describe("the screens changed while the dialog was open", () => {
  test("a 409 asks again, naming the screens as the server has them, and sends those", async () => {
    const f = stubFetch(seedState(), [
      {
        status: 409,
        body: {
          error: "The screens showing this view changed while you were deciding.",
          code: "screens-changed",
          screens: [
            { id: "display-1", name: "Lobby TV" },
            { id: "display-2", name: "Hallway TV" },
            { id: "display-5", name: "Spare" },
          ],
        },
      },
    ]);
    try {
      const hook = mountHook(seedState());
      await settle();
      const done = start(hook, "wall-a", "console");
      await opened();
      fireEvent.click(screen.getByRole("button", { name: "Make it a control surface" }));
      const again = await opened(/changed while you were deciding/).catch(() => null);
      assert.ok(again, "no second confirm after the 409");
      assert.match(again.textContent!, /Buttons will work on "Lobby TV", "Hallway TV", "Spare"/);
      fireEvent.click(screen.getByRole("button", { name: "Make it a control surface" }));
      await settle();
      await done;
      assert.deepEqual(f.writes().map((c) => c.body), [
        { surface: "console", screens: ["display-1", "display-2"] },
        { surface: "console", screens: ["display-1", "display-2", "display-5"] },
      ]);
    } finally {
      f.restore();
    }
  });
});
