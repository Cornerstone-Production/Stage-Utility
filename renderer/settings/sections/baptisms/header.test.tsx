// header.test.tsx — the Baptisms header's Rebuild from raw action: which
// service it targets, when it is disabled and why, that it confirms before
// writing naming the service, and that it reports what the server actually
// changed — success and failure alike.
//
// NOT proved here: the header's LAYOUT — position: sticky, the ResizeObserver
// measurement, the action group's wrap — jsdom lays out nothing and loads no
// stylesheet. Driven in a real browser instead.
//
// The rendered TOOLTIP TEXT, on the other hand, IS provable here: Radix opens
// its tooltip on keyboard focus as well as hover, and `fireEvent.focus` on the
// trigger mounts the content into the DOM with `role="tooltip"` — including on
// a DISABLED button (jsdom does not enforce a real browser's "a disabled
// element cannot receive focus," which is exactly what makes this usable for a
// disabled Rebuild button's own reason). `tooltipTextOf` below does this. A
// few tests still call `baptismRebuildDisabledReason` directly rather than
// through a mount, where checking that EVERY reason the function can produce
// is textually distinct is the point, not any one rendered instance of it.
//
// "Live" is answered by the server (GET /api/history/live), never guessed
// from a record this page happens to already hold — the header re-asks on
// mount, on a target change, on every "service-timeline:history" push
// (treated as a HINT to re-ask, never an answer), and on a slow backstop
// interval while blocked, for the two ways a service can stop recording with
// no push ever following (see header-live-e2e.test.tsx, which drives that
// backstop against the REAL recorders rather than a stub).

import { strict as assert } from "node:assert";
import { after, afterEach, mock, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installRenderDom();

/** A minimal fake EventSource that can push a named channel's payload on
 *  demand — what the "a push is a hint, never an answer" tests below use to
 *  prove it. `FakeEventSource.last` is whichever instance api.ts's SSE
 *  client most recently constructed. */
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
const { TooltipProvider, ConfirmHost, Toaster } = await import("../../../components/ui/index.js");
const { BaptismHeader } = await import("./header.js");
const { describeBaptismRebuild, baptismRebuildDisabledReason } = await import("./rebuild.js");
const { rebuildButtonsIn, tooltipTextOf } = await import("./rebuild-button-test-helpers.js");

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

/** `live` answers GET /api/history/live (a plain boolean, a function of the
 *  requested serviceKey, or a function returning `null` to leave that request
 *  hanging until `releaseLive` below fires it) — a plain boolean or per-key
 *  function resolves IMMEDIATELY, which is what most tests want; `null` lets a
 *  test observe the "checking" state before choosing when the answer lands.
 *  `rebuildAnswer` answers POST /api/baptism/rebuild, or throws its value as a
 *  4xx/5xx body when `rebuildStatus` is set — including its own `code`, the
 *  same machine-readable field the real `error()` helper puts on the wire for
 *  ServiceIsLiveError ("live") and NoRawRowsError ("no-raw-rows"), which are
 *  BOTH 409s and must not be told apart by status alone. */
function stubFetch(
  opts: {
    live?: boolean | ((serviceKey: string) => boolean | null);
    rebuildAnswer?: unknown;
    rebuildStatus?: number;
  } = {},
) {
  const calls: FetchCall[] = [];
  const pendingLive: (() => void)[] = [];
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const ok = (json: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    });
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ url, body });
    if (url.includes("/api/history/live")) {
      const key = new URL(url, "http://localhost").searchParams.get("serviceKey") ?? "";
      const live = typeof opts.live === "function" ? opts.live(key) : (opts.live ?? false);
      if (live === null) {
        return new Promise<ReturnType<typeof ok>>((resolve) => {
          pendingLive.push(() => resolve(ok({ live: false })));
        });
      }
      return ok({ live });
    }
    if (url.includes("/api/baptism/rebuild")) {
      if (opts.rebuildStatus && opts.rebuildStatus >= 400) {
        const a = opts.rebuildAnswer as { error?: string; code?: string } | undefined;
        const errBody: { error: string; code?: string } = { error: a?.error ?? "Rebuild refused" };
        if (a?.code) errBody.code = a.code;
        return ok(errBody, opts.rebuildStatus);
      }
      return ok(opts.rebuildAnswer ?? { rows: 3, sessions: 1, updated: 1, added: 0, unchanged: 0, newer: 0, disagreeing: 0, invalid: 0, kept: 0 });
    }
    return ok({});
  }) as unknown as typeof fetch;
  return { fetchFn, calls, releasePendingLive: () => { while (pendingLive.length) pendingLive.shift()!(); } };
}

async function mount(
  state: BaptismState,
  sessions: BaptismSession[] = [],
  opts: Parameters<typeof stubFetch>[0] & { sessionsLoadFailed?: boolean } = {},
) {
  const { fetchFn, calls, releasePendingLive } = stubFetch(opts);
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
        sessionsLoadFailed: opts.sessionsLoadFailed ?? false,
        onRebuilt: () => {
          rebuiltCount += 1;
        },
      }),
      React.createElement(ConfirmHost),
      React.createElement(Toaster),
    ),
  );
  await settle();
  await settle(); // one more turn for the live-check's own fetch to resolve and re-render
  return {
    view,
    calls,
    releasePendingLive,
    rebuiltCount: () => rebuiltCount,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

function rebuildButton(root: ParentNode): HTMLButtonElement {
  const btn = rebuildButtonsIn(root)[0];
  assert.ok(btn, "expected a Rebuild from raw button in the header's action group");
  return btn;
}

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const findButton = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((b) => text(b) === label) as HTMLElement | undefined;

/** The NEWEST toast only — matches history-rebuild-from-raw.test.tsx's own
 *  helper exactly: toasts linger across tests in one jsdom document, so
 *  reading the whole document would let a PREVIOUS test's message satisfy an
 *  assertion about this one. */
function lastToast(): string {
  const all = [...document.querySelectorAll(".text-footnote")];
  return all.length ? text(all[all.length - 1]!) : "NO TOAST";
}

/** Lets a resolved fetch promise and the state update it triggers land, WITHOUT
 *  going through settle()'s own `setTimeout` — see plan-attachment-retry.test.tsx
 *  and session-chart-refetch.test.tsx, which established this idiom: once
 *  mock.timers fakes setTimeout/setInterval, settle()'s internal
 *  `setTimeout(resolve, 0)` never fires on its own, and `await settle()` hangs
 *  forever. setImmediate stays real throughout, so this is the one flush that
 *  works both with and without fake timers enabled. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
  }
}

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
  const { view, calls, restore } = await mount(state, [session({ serviceKey: "svc-old" })], { live: false });
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
  const { view, calls, restore } = await mount(IDLE, [session({ serviceKey: "svc-past" })], { live: false });
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

test("disabled while the SERVER says the target is live", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-live" };
  const { view, restore } = await mount(state, [], { live: true });
  try {
    assert.equal(rebuildButton(view.container).disabled, true, "the server's own 'live' answer must disable the action rather than only error on click");
  } finally {
    restore();
  }
});

test("a DIFFERENT service being live does not disable this one", async () => {
  const state: BaptismState = { ...IDLE, phase: "idle", finishedAt: "2026-09-20T15:17:23.000Z", serviceKey: "svc-finished" };
  const { view, restore } = await mount(state, [], { live: (key) => key === "svc-someone-else-is-recording" });
  try {
    assert.equal(rebuildButton(view.container).disabled, false);
  } finally {
    restore();
  }
});

test("cancelling the confirm reaches neither the server nor onRebuilt", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-a" };
  const { view, calls, rebuiltCount, restore } = await mount(state, [], { live: false });
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
    live: false,
    rebuildAnswer: { rows: 5, sessions: 2, updated: 1, added: 1, unchanged: 0, newer: 0, disagreeing: 0, invalid: 0, kept: 0 },
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

test("describeBaptismRebuild names updated, added, newer, disagreeing and kept — never just a bare count", () => {
  assert.equal(
    describeBaptismRebuild({
      rows: 5,
      sessions: 6,
      updated: 1,
      added: 1,
      unchanged: 0,
      newer: 1,
      disagreeing: 1,
      invalid: 0,
      kept: 3,
      full: 0,
    }),
    "Rebuilt from raw: 1 updated, 1 added, 1 newer than their rows, 1 disagreeing with the rows, 3 left alone",
  );
});

test("describeBaptismRebuild names a full store only when it turned any session away", () => {
  assert.equal(
    describeBaptismRebuild({
      rows: 3,
      sessions: 1,
      updated: 0,
      added: 1,
      unchanged: 0,
      newer: 0,
      disagreeing: 0,
      invalid: 0,
      kept: 0,
      full: 2,
    }),
    "Rebuilt from raw: 0 updated, 1 added, the store is full, so 2 were not added",
  );
  assert.doesNotMatch(
    describeBaptismRebuild({
      rows: 3,
      sessions: 1,
      updated: 0,
      added: 1,
      unchanged: 0,
      newer: 0,
      disagreeing: 0,
      invalid: 0,
      kept: 0,
      full: 0,
    }),
    /full/,
    "full:0 must not mention the store being full at all",
  );
});

// ── "live" is asked of the server, and a push is a hint, never an answer ───

test("the target service has ENDED (server says not live) — the button is usable", async () => {
  const state: BaptismState = { ...IDLE, finishedAt: "2026-09-20T15:17:23.000Z", serviceKey: "svc-done" };
  const { view, restore } = await mount(state, [], { live: false });
  try {
    assert.equal(rebuildButton(view.container).disabled, false, "disabled for a service the server says has ended");
  } finally {
    restore();
  }
});

test("target LIVE, then an unrelated push arrives — stays disabled (a push is a hint to re-ask, not an answer)", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-live" };
  const { view, calls, restore } = await mount(state, [], { live: (key) => key === "svc-live" });
  try {
    assert.equal(rebuildButton(view.container).disabled, true, "precondition: live");
    const before = calls.filter((c) => c.url.includes("/api/history/live")).length;
    await act(async () => {
      FakeEventSource.last?.push("service-timeline:history", { serviceKey: "svc-last-week", endedAt: "2026-09-13T16:30:00.000Z" });
    });
    await settle();
    const after = calls.filter((c) => c.url.includes("/api/history/live")).length;
    assert.ok(after > before, "a push must trigger a re-ask, not be read as the answer");
    assert.equal(rebuildButton(view.container).disabled, true, "still live — an unrelated broadcast must not enable it");
  } finally {
    restore();
  }
});

test("target finished last week; a push about THAT service arrives — the re-ask confirms it is still not live", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-last-week", finishedAt: "2026-09-13T15:17:23.000Z" };
  const { view, restore } = await mount(state, [], { live: false });
  try {
    assert.equal(rebuildButton(view.container).disabled, false, "precondition: not live");
    await act(async () => {
      FakeEventSource.last?.push("service-timeline:history", { serviceKey: "svc-last-week", endedAt: "2026-09-13T16:30:00.000Z" });
    });
    await settle();
    assert.equal(rebuildButton(view.container).disabled, false, "a push about a long-finished service must not disable it");
  } finally {
    restore();
  }
});

// ── A target change drops the previous key's answer, rather than inherit it ─

test("a target change reads as 'checking', never the previous key's own answer, until its own answer arrives", async () => {
  const opts = {
    // A reads as not-live immediately; B's own answer is held open (see
    // stubFetch's own `null` contract) so the test can observe the gap.
    live: (key: string) => (key === "svc-b" ? null : false),
  };
  const { view, restore } = await mount({ ...IDLE, serviceKey: "svc-a" }, [], opts);
  try {
    assert.equal(rebuildButton(view.container).disabled, false, "precondition: A reads as not live");
    const beforeSwitch = await tooltipTextOf(rebuildButton(view.container));
    assert.doesNotMatch(beforeSwitch, /[Cc]hecking/, "precondition: not already showing 'checking'");

    // Re-render with a DIFFERENT target while B's own answer is still held
    // open — if the previous key's "not live" survived the switch, the
    // button would read enabled here, which is exactly the race a click
    // could turn into a 409.
    const { rerender } = view;
    const React2 = React;
    rerender(
      React2.createElement(
        TooltipProvider,
        null,
        React2.createElement(BaptismHeader, {
          state: { ...IDLE, serviceKey: "svc-b" },
          sessions: [],
          onRebuilt: () => {},
        }),
        React2.createElement(ConfirmHost),
        React2.createElement(Toaster),
      ),
    );
    await settle();

    assert.equal(rebuildButton(view.container).disabled, true, "a target change must not read as enabled before its OWN answer arrives");
    const shown = await tooltipTextOf(rebuildButton(view.container));
    assert.match(shown, /[Cc]hecking/, `expected a 'checking' reason during the gap, got: ${shown}`);
  } finally {
    restore();
  }
});

// The BACKSTOP's own ask has no cancellation on the in-flight promise once
// the target moves to B — clearInterval only stops FUTURE ticks, never one
// already fired. A's backstop tick landing after B has already gotten its
// own correct answer must not overwrite it: that stranded B at "checking"
// forever, because the backstop itself was written to skip scheduling while
// checking, so nothing was left to ever ask again.
test("A's late backstop answer landing after the target has moved to B does not strand B at 'checking'", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let askedAOnce = false;
  const { fetchFn, releasePendingLive } = stubFetch({
    live: (key) => {
      if (key !== "svc-a") return false; // B always resolves not-live immediately
      if (!askedAOnce) {
        askedAOnce = true;
        return true; // A's own initial ask: live, so its backstop starts
      }
      return null; // A's backstop tick: held open until released below
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    const view = render(
      React.createElement(TooltipProvider, null,
        React.createElement(BaptismHeader, { state: { ...IDLE, serviceKey: "svc-a" }, sessions: [], onRebuilt: () => {} }),
        React.createElement(ConfirmHost)),
    );
    await flush();
    assert.equal(rebuildButton(view.container).disabled, true, "precondition: A is live");

    // A's backstop fires and its own ask is now the pending one.
    await act(async () => { mock.timers.tick(30_000); });
    await flush();

    // The target moves to B before A's backstop answer lands.
    view.rerender(
      React.createElement(TooltipProvider, null,
        React.createElement(BaptismHeader, { state: { ...IDLE, serviceKey: "svc-b" }, sessions: [], onRebuilt: () => {} }),
        React.createElement(ConfirmHost)),
    );
    await flush();
    assert.equal(rebuildButton(view.container).disabled, false, "precondition: B's own answer (not live) must already have landed");

    // A's stale backstop answer finally arrives.
    releasePendingLive();
    await flush();

    assert.equal(
      rebuildButton(view.container).disabled,
      false,
      "B's own correct answer must not be overwritten by A's late, stale backstop answer",
    );
  } finally {
    globalThis.fetch = realFetch;
    mock.timers.reset();
  }
});

// ── A failed ask gets its own reason, and does not silently pass as "live" ──

test("a failed live check disables the button with its OWN reason, not a silent 'still recording'", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    calls.push(String(input));
    if (String(input).includes("/api/history/live")) {
      return { ok: false, status: 503, json: async () => ({ error: "Service Unavailable" }), text: async () => "{}" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  }) as unknown as typeof fetch;
  try {
    const state: BaptismState = { ...IDLE, finishedAt: "2026-09-13T15:17:23.000Z", serviceKey: "svc-last-week" };
    const view = render(
      React.createElement(TooltipProvider, null,
        React.createElement(BaptismHeader, { state, sessions: [], onRebuilt: () => {} }),
        React.createElement(ConfirmHost)),
    );
    await settle();
    await settle();
    await settle();
    assert.equal(rebuildButton(view.container).disabled, true, "an ask failure must not read as usable");
    const shown = await tooltipTextOf(rebuildButton(view.container));
    assert.match(shown, /[Cc]ould not check/, `expected the ask-failure's own reason, got: ${shown}`);
    assert.notEqual(
      shown,
      "This service is still recording — rebuild once it ends",
      "an ask failure must not read as though the server itself said 'live'",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── The slow backstop interval, for a "live" answer with no push behind it ──

test("re-asks on a slow interval while live, and stops once the answer is not live", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let live = true;
  const { fetchFn, calls } = stubFetch({ live: () => live });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    const state: BaptismState = { ...IDLE, serviceKey: "svc-live" };
    render(
      React.createElement(TooltipProvider, null,
        React.createElement(BaptismHeader, { state, sessions: [], onRebuilt: () => {} }),
        React.createElement(ConfirmHost)),
    );
    await flush();
    const asksAt = () => calls.filter((c) => c.url.includes("/api/history/live")).length;
    const afterMount = asksAt();

    await act(async () => { mock.timers.tick(30_000); });
    await flush();
    assert.ok(asksAt() > afterMount, "the slow backstop must re-ask after 30 seconds while the answer is 'live'");

    // The service ends; the NEXT tick should be the last one — no push is
    // involved anywhere in this test, which is the exact gap the backstop
    // exists for (a live-poller tick can close a service with none due).
    live = false;
    await act(async () => { mock.timers.tick(30_000); });
    await flush();
    const afterWentNotLive = asksAt();

    await act(async () => { mock.timers.tick(120_000); });
    await flush();
    assert.equal(asksAt(), afterWentNotLive, "the interval must be cleared once the answer is 'not live', not keep polling forever");
  } finally {
    globalThis.fetch = realFetch;
    mock.timers.reset();
  }
});

// ── The confirm names the service, and each disabled reason is its own ─────

test("the confirm names the target service's title and date", async () => {
  const state: BaptismState = {
    ...IDLE,
    serviceKey: "svc-a",
    sessionStartedAt: "2026-09-20T15:00:00.000Z",
    serviceTitle: "Sunday Gathering",
  };
  const { view, restore } = await mount(state, [], { live: false });
  try {
    fireEvent.click(rebuildButton(view.container));
    await settle();
    const dialog = text(document.body);
    assert.match(dialog, /Sunday Gathering/, `the confirm did not name the service: ${dialog}`);
    assert.match(dialog, /Sep 20/, `the confirm named the service but not its date: ${dialog}`);
    fireEvent.click(findButton(document.body, "Cancel")!);
  } finally {
    restore();
  }
});

test("baptismRebuildDisabledReason tells all six states apart, never one bleeding into another's text", () => {
  const live = baptismRebuildDisabledReason({ targetServiceKey: "svc-a", liveStatus: "live", sessionsLoadFailed: false, mostRecentSession: null });
  const checking = baptismRebuildDisabledReason({ targetServiceKey: "svc-a", liveStatus: "checking", sessionsLoadFailed: false, mostRecentSession: null });
  const failed = baptismRebuildDisabledReason({ targetServiceKey: "svc-a", liveStatus: "failed", sessionsLoadFailed: false, mostRecentSession: null });
  const loadFailed = baptismRebuildDisabledReason({ targetServiceKey: null, liveStatus: "not-live", sessionsLoadFailed: true, mostRecentSession: null });
  const noKeyOnNewest = baptismRebuildDisabledReason({ targetServiceKey: null, liveStatus: "not-live", sessionsLoadFailed: false, mostRecentSession: { serviceKey: null } });
  const nothingRecorded = baptismRebuildDisabledReason({ targetServiceKey: null, liveStatus: "not-live", sessionsLoadFailed: false, mostRecentSession: null });
  const enabled = baptismRebuildDisabledReason({ targetServiceKey: "svc-a", liveStatus: "not-live", sessionsLoadFailed: false, mostRecentSession: null });

  const reasons = [live, checking, failed, loadFailed, noKeyOnNewest, nothingRecorded];
  assert.equal(new Set(reasons).size, 6, `expected six distinct reasons, got: ${JSON.stringify(reasons)}`);
  assert.match(live!, /still recording/);
  assert.match(checking!, /[Cc]hecking/);
  assert.match(failed!, /[Cc]ould not check/);
  assert.match(loadFailed!, /could not be loaded/);
  assert.match(noKeyOnNewest!, /no linked service/);
  assert.match(nothingRecorded!, /Nothing has been recorded/);
  assert.equal(enabled, null, "a non-live target with sessions available must not be disabled at all");
});

// ── The result toast, the refusal toast, and the pre-post recheck ──────────

test("a successful rebuild toasts what changed", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-a" };
  const { view, restore } = await mount(state, [], {
    live: false,
    rebuildAnswer: { rows: 5, sessions: 2, updated: 1, added: 1, unchanged: 0, newer: 0, disagreeing: 0, invalid: 0, kept: 0 },
  });
  try {
    fireEvent.click(rebuildButton(view.container));
    await settle();
    fireEvent.click(findButton(document.body, "Rebuild")!);
    await settle();
    await settle();
    const shown = lastToast();
    assert.notEqual(shown, "NO TOAST", "expected a toast after a successful rebuild");
    assert.match(shown, /1 updated, 1 added/, `the toast did not report what changed: ${shown}`);
  } finally {
    restore();
  }
});

// A 409 specifically gets its own message (see "a 409 the recheck did not
// catch" below) — this is the OTHER kind of failure, anything else the
// server could answer with, which must still toast rather than read as a
// silent no-op.
test("a refused rebuild toasts the failure, not a silent no-op", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-a" };
  const { view, restore } = await mount(state, [], {
    live: false,
    rebuildStatus: 500,
    rebuildAnswer: { error: "That recording could not be rebuilt, and nothing was changed. The log says why." },
  });
  try {
    fireEvent.click(rebuildButton(view.container));
    await settle();
    fireEvent.click(findButton(document.body, "Rebuild")!);
    await settle();
    await settle();
    const shown = lastToast();
    assert.notEqual(shown, "NO TOAST", "expected a toast after a refused rebuild");
    assert.match(shown, /Rebuild failed/, `a refusal must not read as silent success: ${shown}`);
  } finally {
    restore();
  }
});

test("a confirm left open across the target starting to record again does not post — the pre-post recheck catches it", async () => {
  let raceToLive = false;
  const { view, calls, restore } = await mount({ ...IDLE, serviceKey: "svc-a" }, [], { live: () => raceToLive });
  try {
    assert.equal(rebuildButton(view.container).disabled, false, "precondition: not live when the confirm opens");
    fireEvent.click(rebuildButton(view.container));
    await settle();
    // The operator reads the confirm; meanwhile the target starts recording.
    raceToLive = true;
    fireEvent.click(findButton(document.body, "Rebuild")!);
    await settle();
    await settle();
    assert.equal(calls.some((c) => c.url.includes("/api/baptism/rebuild")), false, "the recheck must stop this from posting into a 409");
    const shown = lastToast();
    assert.notEqual(shown, "NO TOAST", "expected a refusal toast");
    assert.match(shown, /started recording again/, `expected the race-specific refusal, got: ${shown}`);
  } finally {
    restore();
  }
});

test("a 409 the recheck did not catch still refuses cleanly and marks the target live", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-a" };
  const { view, restore } = await mount(state, [], {
    live: false, // the recheck itself says not-live — the POST is what refuses
    rebuildStatus: 409,
    rebuildAnswer: { error: "That service is recording right now — it cannot be rebuilt until it ends.", code: "live" },
  });
  try {
    fireEvent.click(rebuildButton(view.container));
    await settle();
    fireEvent.click(findButton(document.body, "Rebuild")!);
    await settle();
    await settle();
    const shown = lastToast();
    assert.match(shown, /started recording again/, `expected the 409-specific refusal, not a generic one: ${shown}`);
    assert.equal(rebuildButton(view.container).disabled, true, "a 409 the client did not predict must still mark the target live");
  } finally {
    restore();
  }
});

// A session recorded before the raw layer existed has a timeline record but
// no baptism.csv — POST /api/baptism/rebuild refuses that with 409 too
// (NoRawRowsError), for a completely different reason than "still recording"
// (ServiceIsLiveError). That is exactly this header's own fallback target on
// a freshly upgraded server until the first new session lands, so treating
// every 409 as "started recording again" toasted the wrong message, flipped
// the button to disabled, and re-enabled it 30 seconds later only to repeat
// on the next click.
test("a no-raw-rows 409 shows the server's own sentence and leaves the button enabled — not 'started recording again'", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-pre-raw-layer" };
  const { view, restore } = await mount(state, [], {
    live: false,
    rebuildStatus: 409,
    rebuildAnswer: {
      error: "No raw rows exist for this recording — there is nothing to rebuild it from.",
      code: "no-raw-rows",
    },
  });
  try {
    fireEvent.click(rebuildButton(view.container));
    await settle();
    fireEvent.click(findButton(document.body, "Rebuild")!);
    await settle();
    await settle();
    const shown = lastToast();
    assert.notEqual(shown, "NO TOAST", "expected a toast naming the actual refusal");
    assert.match(shown, /No raw rows exist/, `expected the server's own sentence, got: ${shown}`);
    assert.doesNotMatch(shown, /started recording again/, "a no-raw-rows refusal is not a liveness problem");
    assert.equal(
      rebuildButton(view.container).disabled,
      false,
      "a no-raw-rows refusal must not flip the button to 'still recording'",
    );
  } finally {
    restore();
  }
});
