// renderer/main/stage-view-preview-live.test.tsx — a Screens-card preview tells
// its card whether it is live, through the REAL StageView, and answers when the
// card asks.
//
// The writer half of preview-messages.ts (the reader half is pinned in
// lazy-preview-stable.test.tsx). Live means drawn with a state AND an event
// stream delivering: a page that has drawn and then lost its stream must say
// `live: false`, or a frozen frame on a kept Screens page passes for live.
//
// Harness after stage-view-presence.test.tsx: a stubbed EventSource and fetch,
// the providers renderer/main/index.tsx wraps the view in. In jsdom the page is
// its own parent, so what the preview posts to its card lands on this window's
// postMessage, which is spied.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, mock, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  onopen: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  if (url === "/api/state") return { ok: true, status: 200, json: async () => stageState(), text: async () => "" };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { StageView } = await import("./stage-view.js");
const { __resetForTests } = await import("./use-stage-state.js");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { __sseFallback } = await import("../lib/api.js");
const { PREVIEW_MSG } = await import("./preview-messages.js");

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

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

/** Every live report the page posted to its card, oldest first. */
let reports: { live: boolean; since: number | null }[] = [];
/** The `shared` of each, in step. */
let reportsShared: boolean[] = [];

beforeEach(() => {
  cleanup();
  __resetForTests();
  reports = [];
  reportsShared = [];
  __sseFallback.noteStream(false);
  mock.method(window, "postMessage", (data: { type?: string; live: boolean; since: number | null; shared: boolean }) => {
    if (data?.type === PREVIEW_MSG.LIVE) {
      reports.push({ live: data.live, since: data.since });
      reportsShared.push(data.shared);
    }
  });
});
afterEach(async () => {
  cleanup();
  mock.restoreAll();
  await flush();
});
after(async () => {
  cleanup();
  await flush();
  teardown();
});

async function renderAt(path: string) {
  window.history.replaceState({}, "", path);
  await act(async () => {
    render(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(TooltipProvider, null, React.createElement(StageView))),
    );
    await flush();
  });
}

test("a preview says it is live once drawn on a delivering stream, and not live when the stream drops", async () => {
  await renderAt("/preview-v1?output=display-1");
  assert.equal(reports.some((r) => r.live), false, "said live with no stream delivering");

  await act(async () => __sseFallback.noteStream(true));
  assert.deepEqual(reports.at(-1), { live: true, since: null }, "drawn on a delivering stream, and not live");

  await act(async () => __sseFallback.noteStream(false));
  const last = reports.at(-1);
  assert.equal(last?.live, false, "the stream dropped and the preview still said live");
  assert.equal(typeof last?.since, "number", "a dropped stream did not say since when");
});

test("asked by its card, a preview answers with where it stands", async () => {
  await renderAt("/preview-v1?output=display-1");
  await act(async () => __sseFallback.noteStream(true));
  const before = reports.length;
  await act(async () => {
    const event = new MessageEvent("message", { data: { type: PREVIEW_MSG.ASK, viewId: "v1" }, origin: window.location.origin });
    // jsdom's constructor refuses a window as `source`; the page checks it is its parent.
    Object.defineProperty(event, "source", { value: window.parent });
    window.dispatchEvent(event);
  });
  assert.equal(reports.length, before + 1, "the preview did not answer its card");
  assert.deepEqual(reports.at(-1), { live: true, since: null });
});

test("a real display never reports", async () => {
  await renderAt("/display-1");
  await act(async () => __sseFallback.noteStream(true));
  assert.deepEqual(reports, [], "a wall display posted preview reports to nobody");
});

test("an ask from any window but the page's own parent goes unanswered", async () => {
  await renderAt("/preview-v1?output=display-1");
  await act(async () => __sseFallback.noteStream(true));
  const before = reports.length;
  await act(async () => {
    const event = new MessageEvent("message", { data: { type: PREVIEW_MSG.ASK, viewId: "v1" }, origin: window.location.origin });
    Object.defineProperty(event, "source", { value: {} });
    window.dispatchEvent(event);
  });
  assert.equal(reports.length, before, "the preview answered a window that is not its card");
});

test("a preview says whether its stream is the shared one", async () => {
  await renderAt("/preview-v1?output=display-1");
  __sseFallback.setShared(true);
  await act(async () => __sseFallback.noteStream(true));
  assert.equal(reportsShared.at(-1), true);
  await act(async () => __sseFallback.setShared(false, "worker abandoned: test"));
  assert.equal(reportsShared.at(-1), false, "a preview that fell off the shared stream did not say so");
  __sseFallback.setShared(false, "no SharedWorker in this browser");
});
