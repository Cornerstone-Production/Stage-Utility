// update-lock-read.test.tsx — the Updates panel, when the update lock cannot be
// read.
//
// The lock starts null, which reads as "not locked", and its read used to
// `.catch(() => {})`: a failed read in the middle of a service drew a plain
// Restart. Restart is the one update action the server does not refuse on its
// own (an update and a track switch answer 409), so the button was the only
// thing standing between a mid-service restart and the operator. An unread lock
// now guards Restart as an active one does and says why; a later read that
// works takes it away.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import type { UpdateStatus } from "@main/types/state";
import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

/** A stream a test can push on, as the server's SSE does. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  onopen: unknown = null;
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

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { UpdatesPanel } = await import("./advanced-section.js");
const { ConfirmHost, TooltipProvider } = await import("../../components/ui/index.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
// The stream replays each channel's last frame to a late subscriber, so a push
// in one case would be one more lock read in the next.
afterEach(async () => {
  cleanup();
  await settle();
  resetReplayCache();
});

/** An update status with nothing pending, so exactly one Restart is on screen. */
const STATUS = {
  isGitRepo: true,
  canUpdate: true,
  selfRecovers: true,
  branch: "beta",
  tracks: ["beta", "main"],
  version: "9.9.9",
  currentSha: "aaaaaaa",
  currentDate: "2020-01-01T00:00:00.000Z",
  behind: 0,
  behindUserFacing: 0,
  currentTag: "v9.9.9",
  targetTag: "v9.9.9",
  releasesBehind: 0,
  tagBased: true,
  latestSha: "aaaaaaa",
  latestDate: "2020-01-01T00:00:00.000Z",
  changelog: [],
  lastCheckedAt: "2020-01-02T00:00:00.000Z",
  phase: "idle",
  step: null,
  restartPending: false,
  lastResult: null,
  error: null,
} as unknown as UpdateStatus;

/** `lockFails` is read at call time, so a test can change it between reads. */
function stubFetch(state: { lockFails: boolean }) {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/update/lock")) {
      if (state.lockFails) throw new TypeError("fetch failed");
      return ok({ active: false, reasons: [] });
    }
    return ok({});
  });
}

async function mount(status: UpdateStatus = STATUS): Promise<void> {
  render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(UpdatesPanel, {
        updateStatus: status,
        autoUpdate: { mode: "manual", dayOfWeek: null, hour: 3 },
        handlers: { handleCheckUpdates: async () => {}, handleApplyUpdate: async () => {}, handleSetAutoUpdate: async () => {} } as unknown as Parameters<
          typeof UpdatesPanel
        >[0]["handlers"],
      }),
      React.createElement(ConfirmHost, null),
    ),
  );
  await settle();
  await settle();
}

const restartLabel = () =>
  screen.queryByRole("button", { name: /Restart anyway/ }) ? "Restart anyway" : screen.queryByRole("button", { name: /^Restart$/ }) ? "Restart" : "none";

test("an unread lock guards Restart, says why, and reaches the log", async () => {
  const f = stubFetch({ lockFails: true });
  try {
    await mount();
    assert.match(alerts(), /Couldn't read the update lock/i);
    assert.equal(restartLabel(), "Restart anyway", "an unread lock is not an unlocked server");
    fireEvent.click(screen.getByRole("button", { name: /Restart anyway/ }));
    await settle();
    assert.equal(!!screen.queryByText(/Couldn't check for a service/), true, "the dialog says it could not tell");
    assert.ok(
      f.logs.some((l) => l.tag === "updater" && /could not read the update lock/.test(l.message)),
      `expected an [updater] line — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("a later read that works takes the guard away", async () => {
  const state = { lockFails: true };
  const f = stubFetch(state);
  try {
    await mount();
    assert.equal(restartLabel(), "Restart anyway");
    state.lockFails = false;
    // The panel re-reads the lock whenever a service goes live or idle.
    await act(async () => FakeEventSource.last?.push("pco:live", null));
    await settle();
    await settle();
    assert.equal(restartLabel(), "Restart");
    assert.equal(alerts(), "");
  } finally {
    f.restore();
  }
});

test("with an update waiting on a restart, an unread lock guards both restart controls", async () => {
  const f = stubFetch({ lockFails: true });
  try {
    // The deferred update's banner carries the second restart control.
    await mount({ ...STATUS, restartPending: true } as UpdateStatus);
    assert.equal(screen.queryAllByRole("button", { name: /Restart anyway/ }).length, 2, "Restart and Restart now alike");
    assert.equal(!!screen.queryByRole("button", { name: /Restart now/ }), false, "the banner's is not offered plain");
  } finally {
    f.restore();
  }
});

test("an older lock read failing after a newer one worked does not bring the guard back", async () => {
  // The first read is still out when a service going idle prompts a second,
  // which answers first; then the first fails.
  let failFirst: (e: Error) => void = () => {};
  let reads = 0;
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/update/lock")) {
      reads++;
      if (reads === 1) return new Promise((_, reject) => { failFirst = reject; });
      return ok({ active: false, reasons: [] });
    }
    return ok({});
  });
  try {
    await mount();
    await act(async () => FakeEventSource.last?.push("pco:live", null));
    await settle();
    await act(async () => failFirst(new TypeError("fetch failed")));
    await settle();
    assert.equal(reads, 2);
    assert.equal(restartLabel(), "Restart", "the newest answer is the lock");
    assert.equal(alerts(), "");
  } finally {
    f.restore();
  }
});

test("control: a lock that reads as inactive leaves Restart plain, with no alert", async () => {
  const f = stubFetch({ lockFails: false });
  try {
    await mount();
    assert.equal(restartLabel(), "Restart");
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});
