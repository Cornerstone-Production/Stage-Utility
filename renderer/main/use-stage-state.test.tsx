// Mounting the hook N times must cost ONE hydrate, not N.
//
// A nine-tile producer wall mounted nine copies of this hook, each fetching the
// whole StageState and keeping its own copy to re-render on every broadcast.
// Nothing was broken by it, which is why it survived — it is a cost that only
// shows up as a slow Pi.
//
// Rendered rather than reasoned about, because the thing under test is what a
// mount COSTS, and a mount is the only way to find out. The observable is the
// url list the fetch stub records: the hook's hydrate is `stage:getState`, which
// api.ts maps to GET /api/state, so a per-consumer fetch shows up as three urls
// where one belongs.
//
// The counts are EXACT, never a floor. "fewer than three" would go on passing
// the day a fourth consumer added its own fetch, which is how this started.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/**
 * An EventSource that connects to nothing but remembers who is listening.
 *
 * api.ts subscribes by `es.addEventListener(channel, handler)`, so keeping the
 * handlers here is what lets `emitStateChanged` deliver a broadcast exactly the
 * way the server would. `CLOSED` is a static on the real class and api.ts reads
 * it off the global, so the stub has to carry it too.
 */
const listeners = new Map<string, Set<(e: { data: string }) => void>>();
class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  addEventListener(channel: string, handler: (e: { data: string }) => void): void {
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(handler);
  }
  removeEventListener(channel: string, handler: (e: { data: string }) => void): void {
    listeners.get(channel)?.delete(handler);
  }
  close(): void {
    this.readyState = 2;
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/** Enough of a StageState for a consumer to render something identifiable. */
const BASE = {
  appName: "Stage",
  accentColor: null,
  hourCycle: "12h",
  slotsByView: {},
  slotsByLayoutObject: {},
} as unknown as StageState;

/**
 * Every url the renderer asked for, in order.
 *
 * The hydrate is the only request either consumer makes on its own; the SSE
 * channel report (`/api/events/subscribe`) is debounced past the end of a case
 * and matches neither filter below in any event.
 */
const requests: string[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  requests.push(url);
  const body = url.includes("/api/state") ? BASE : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { useStageState, __resetForTests } = await import("./use-stage-state.js");

/**
 * Let everything in flight settle BEFORE anything is asserted or torn down.
 *
 * Wrapped in `act` because the hydrate resolves outside React's knowledge and
 * the store notifies its subscribers from there; unwrapped, every case would
 * pass while printing an act warning. And run before `teardown()` for the reason
 * this repo has hit twice: a promise that settles after `window` is gone throws
 * from inside React and fails the FILE while every test in it passes.
 */
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

/** Deliver a `stage:state-changed` frame to whatever subscribed to it. */
function emitStateChanged(next: unknown): void {
  const frame = { data: JSON.stringify(next) };
  for (const handler of [...(listeners.get("stage:state-changed") ?? [])]) handler(frame);
}

function Consumer(): React.ReactElement {
  const { state, isLoading } = useStageState();
  return React.createElement(
    "div",
    { "data-testid": "app-name" },
    state ? state.appName : isLoading ? "loading" : "",
  );
}

const OneConsumer = () => React.createElement(Consumer);
const ThreeConsumers = () =>
  React.createElement(
    "div",
    null,
    React.createElement(Consumer),
    React.createElement(Consumer),
    React.createElement(Consumer),
  );

after(async () => {
  await settle();
  teardown();
});
beforeEach(() => {
  cleanup();
  // The cache is module-level by design, so without this a case would inherit
  // the previous one's state and pass or fail on test ORDER.
  __resetForTests();
  listeners.clear();
  requests.length = 0;
});
afterEach(async () => {
  cleanup();
  await settle();
});

describe("the state is fetched once for everyone", () => {
  test("three mounts make ONE request", async () => {
    // Not "fewer than three" — exactly one. A floor would go on passing if a
    // fourth consumer added its own fetch, which is how this started.
    requests.length = 0;
    render(React.createElement(ThreeConsumers));
    await settle();
    const hydrates = requests.filter((u) => u.includes("stage") || u.includes("state"));
    assert.equal(hydrates.length, 1, `hydrated ${hydrates.length} times for 3 consumers`);
  });

  test("a later mount gets the state already held, without refetching", async () => {
    requests.length = 0;
    const first = render(React.createElement(OneConsumer));
    await settle();
    const after = requests.length;
    render(React.createElement(OneConsumer));
    await settle();
    assert.equal(requests.length, after, "a second consumer refetched what was already in hand");
    first.unmount();
  });

  test("a later mount is not stuck loading — the state is already there", async () => {
    // The reason `isLoading` cannot simply be per-consumer: for a tile that
    // mounts into a wall that hydrated minutes ago, the state IS in hand, so
    // starting it at `true` would flash a loading state on every new tile.
    render(React.createElement(OneConsumer));
    await settle();
    function LateConsumer(): React.ReactElement {
      const { isLoading } = useStageState();
      return React.createElement("div", { "data-testid": "late" }, isLoading ? "loading" : "ready");
    }
    // Asserted on the DOM BEFORE anything is allowed to settle. A per-consumer
    // hook starts at `true` and only clears when its own fetch resolves a
    // macrotask later, so this is the tick at which the flash is visible.
    render(React.createElement(LateConsumer));
    assert.equal(
      screen.getByTestId("late").textContent,
      "ready",
      "a tile mounting after hydrate flashed a loading state",
    );
  });

  test("every consumer sees a broadcast", async () => {
    // The point of sharing is that it stays correct. One consumer updating
    // while another shows stale state is worse than the duplicate fetches.
    render(React.createElement(ThreeConsumers));
    await settle();
    act(() => {
      emitStateChanged({ ...BASE, appName: "Changed" });
    });
    const nodes = screen.getAllByTestId("app-name");
    assert.equal(nodes.length, 3, `expected 3 consumers, found ${nodes.length}`);
    for (const node of nodes) {
      assert.equal(node.textContent, "Changed", "a consumer missed the broadcast");
    }
  });

  test("unmounting one consumer does not blind the others", async () => {
    const a = render(React.createElement(OneConsumer));
    const b = render(React.createElement(OneConsumer));
    await settle();
    a.unmount();
    act(() => {
      emitStateChanged({ ...BASE, appName: "Still live" });
    });
    assert.equal(screen.getByTestId("app-name").textContent, "Still live");
    b.unmount();
  });

});

/**
 * `--brand-accent` is ONE variable on the document root, and every consumer of
 * this hook used to push to it from its own copy of the state. Every one starts
 * null, and applyAccentVar(undefined) REMOVES the override — so a component
 * mounting mid-session tore the accent off the whole page until its own fetch
 * came back. Opening a colour picker did exactly that: the panel's saved-colours
 * list calls this hook, so the click that opened it flashed every accent-coloured
 * thing on the page.
 *
 * Read off the document rather than out of the source, because the source is
 * what changed: the rule survives a rewrite, a regex over one implementation
 * does not.
 */
describe("the brand accent", () => {
  const accent = () => document.documentElement.style.getPropertyValue("--brand-accent");
  const seedAccent = () => document.documentElement.style.setProperty("--brand-accent", "#3b82f6");

  test("is not cleared by a consumer that has not hydrated", () => {
    seedAccent();
    // No settle: this is the window the bug lived in — mounted, state still null.
    render(React.createElement(OneConsumer));
    assert.equal(accent(), "#3b82f6", "an un-hydrated consumer stripped the accent off the page");
  });

  test("but a hydrated null accent still clears it — that is a real choice", async () => {
    seedAccent();
    render(React.createElement(OneConsumer));
    await settle(); // BASE.accentColor is null: the operator picked no brand colour.
    assert.equal(accent(), "", "an operator's 'no accent' was ignored");
  });

  test("a hydrated colour is applied", async () => {
    document.documentElement.style.removeProperty("--brand-accent");
    render(React.createElement(OneConsumer));
    await settle();
    act(() => {
      emitStateChanged({ ...BASE, accentColor: "#112233" });
    });
    assert.equal(accent(), "#112233", "the branding colour never reached the page");
  });
});

describe("a failed hydrate", () => {
  test("is reported, not left silently blank", async () => {
    // A shared cache that never retries and never says anything would leave
    // every surface on the wall permanently empty with no explanation.
    const realFetch = (globalThis as unknown as { fetch: unknown }).fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      throw new Error("no server");
    };
    function ErrorConsumer(): React.ReactElement {
      const { error, isLoading } = useStageState();
      return React.createElement(
        "div",
        { "data-testid": "err" },
        isLoading ? "loading" : (error ?? "ok"),
      );
    }
    render(React.createElement(ErrorConsumer));
    await settle();
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
    const seen = screen.getByTestId("err").textContent ?? "";
    assert.ok(seen.includes("no server"), `error never reached the consumer (${seen})`);
  });
});
