// header.test.tsx — the Baptisms header's Rebuild from raw action: which
// service it targets, when it is disabled and why, that it confirms before
// writing naming the service, and that it reports what the server actually
// changed — success and failure alike.
//
// NOT proved here: the rendered TOOLTIP TEXT, or anything about the header's
// layout — see this file's own header comment for why (position: sticky, the
// ResizeObserver measurement, jsdom laying nothing out). Radix's Tooltip only
// mounts its content while open, and opening it in jsdom needs Radix's own
// hover/focus machinery — a different component's job to prove. What IS
// proved is the fact CLAUDE.md names ("a button that only errors is the
// failure"): the DISABLED attribute itself, driven through a stubbed fetch, a
// fake SSE stream and the real confirm()/ConfirmHost/toast flow, never a
// hand-rolled dialog or toast stub.
//
// "Live" is answered by the server (GET /api/history/live), never guessed
// from a record this page happens to already hold — the header re-asks on
// mount, on a target change, and on every "service-timeline:history" push,
// treating the push as a HINT to re-ask rather than an answer about this key.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installRenderDom();

/** A minimal fake EventSource that can push a named channel's payload on
 *  demand — the same shape the reviewer's own probe used to prove a push is
 *  only a hint. `FakeEventSource.last` is whichever instance api.ts's SSE
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
const { BaptismHeader, describeBaptismRebuild, baptismRebuildDisabledReason } = await import("./header.js");

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

/** `live` answers GET /api/history/live (a plain boolean, or a function of the
 *  requested serviceKey for tests that need different answers per key);
 *  `rebuildAnswer` answers POST /api/baptism/rebuild, or throws its value as a
 *  4xx/5xx body when `rebuildStatus` is set. */
function stubFetch(
  opts: {
    live?: boolean | ((serviceKey: string) => boolean);
    rebuildAnswer?: unknown;
    rebuildStatus?: number;
  } = {},
) {
  const calls: FetchCall[] = [];
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
      return ok({ live });
    }
    if (url.includes("/api/baptism/rebuild")) {
      if (opts.rebuildStatus && opts.rebuildStatus >= 400) {
        return ok({ error: (opts.rebuildAnswer as { error?: string })?.error ?? "Rebuild refused" }, opts.rebuildStatus);
      }
      return ok(opts.rebuildAnswer ?? { rows: 3, sessions: 1, updated: 1, added: 0, newer: 0, kept: 0 });
    }
    return ok({});
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function mount(
  state: BaptismState,
  sessions: BaptismSession[] = [],
  opts: Parameters<typeof stubFetch>[0] & { sessionsLoadFailed?: boolean } = {},
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

/** The NEWEST toast only — matches history-rebuild-from-raw.test.tsx's own
 *  helper exactly: toasts linger across tests in one jsdom document, so
 *  reading the whole document would let a PREVIOUS test's message satisfy an
 *  assertion about this one. */
function lastToast(): string {
  const all = [...document.querySelectorAll(".text-footnote")];
  return all.length ? text(all[all.length - 1]!) : "NO TOAST";
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
    rebuildAnswer: { rows: 5, sessions: 2, updated: 1, added: 1, newer: 0, kept: 0 },
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

// ── C2 / Ruling 60: "live" is asked of the server, and a push is a hint ────
// Transcribed from the reviewer's H1/H2/H3 probes (zz-review-header-probe.test.tsx).

test("H1: the target service has ENDED (server says not live) — the button is usable", async () => {
  const state: BaptismState = { ...IDLE, finishedAt: "2026-09-20T15:17:23.000Z", serviceKey: "svc-done" };
  const { view, restore } = await mount(state, [], { live: false });
  try {
    assert.equal(rebuildButton(view.container).disabled, false, "disabled for a service the server says has ended");
  } finally {
    restore();
  }
});

test("H2: target LIVE, then an unrelated push arrives — stays disabled (a push is a hint to re-ask, not an answer)", async () => {
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

test("H3: target finished last week; a push about THAT service arrives — the re-ask confirms it is still not live", async () => {
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

// ── M7: the confirm names the service, and each disabled reason is its own ──

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
    fireEvent.click(findButton(document.body, "Cancel")!);
  } finally {
    restore();
  }
});

test("baptismRebuildDisabledReason tells four states apart, never one bleeding into another's text", () => {
  const live = baptismRebuildDisabledReason({
    targetServiceKey: "svc-a",
    live: true,
    sessionsLoadFailed: false,
    mostRecentSession: null,
  });
  const loadFailed = baptismRebuildDisabledReason({
    targetServiceKey: null,
    live: false,
    sessionsLoadFailed: true,
    mostRecentSession: null,
  });
  const noKeyOnNewest = baptismRebuildDisabledReason({
    targetServiceKey: null,
    live: false,
    sessionsLoadFailed: false,
    mostRecentSession: { serviceKey: null },
  });
  const nothingRecorded = baptismRebuildDisabledReason({
    targetServiceKey: null,
    live: false,
    sessionsLoadFailed: false,
    mostRecentSession: null,
  });
  const enabled = baptismRebuildDisabledReason({
    targetServiceKey: "svc-a",
    live: false,
    sessionsLoadFailed: false,
    mostRecentSession: null,
  });

  const reasons = [live, loadFailed, noKeyOnNewest, nothingRecorded];
  assert.equal(new Set(reasons).size, 4, `expected four distinct reasons, got: ${JSON.stringify(reasons)}`);
  assert.match(live!, /still recording/);
  assert.match(loadFailed!, /could not be loaded/);
  assert.match(noKeyOnNewest!, /no linked service/);
  assert.match(nothingRecorded!, /Nothing has been recorded/);
  assert.equal(enabled, null, "a non-live target with sessions available must not be disabled at all");
});

// ── M6: the result toast, the refusal toast, and a fresh probe of both ──────

test("a successful rebuild toasts what changed", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-a" };
  const { view, restore } = await mount(state, [], {
    live: false,
    rebuildAnswer: { rows: 5, sessions: 2, updated: 1, added: 1, newer: 0, kept: 0 },
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

test("a refused rebuild toasts the failure, not a silent no-op", async () => {
  const state: BaptismState = { ...IDLE, serviceKey: "svc-a" };
  const { view, restore } = await mount(state, [], {
    live: false,
    rebuildStatus: 409,
    rebuildAnswer: { error: "That service is recording right now — it cannot be rebuilt until it ends." },
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
