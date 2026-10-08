// What the messages channel teaches the page about the server's clock.
//
// Every snapshot carries `serverNow`. The read is a request and an answer, so it is
// a measured sample and sets a cold clock by itself; a live frame refines it; a
// replayed frame (this page's own cache) is never read, because it says when it
// was first seen and not what time it is.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

let answer: () => Promise<unknown> = async () => ({});
/** The init each read of the messages was sent with. */
const inits: (RequestInit | undefined)[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.startsWith("/api/log/client")) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  if (!url.startsWith("/api/messages")) throw new Error(`unexpected fetch: ${url}`);
  inits.push(init);
  const body = await answer();
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { useMessagesStatus } = await import("./use-messages-state.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");
const { serverClock } = await import("../lib/server-clock.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
  serverClock.reset();
});
afterEach(async () => {
  cleanup();
  await settle();
});

const HOUR = 3_600_000;
const state = (serverNow: number, rev = 1) => ({ rev, serverNow, groups: [], quickMessages: [], quickReplies: [], messages: [], alerts: [] });
const skew = () => serverClock.now() - Date.now();

function mount(): void {
  function Probe(): React.ReactElement {
    useMessagesStatus();
    return React.createElement("output");
  }
  render(React.createElement(Probe));
}

describe("the messages channel and the server clock", () => {
  test("the first read sets a cold clock on its own, measured as a request and an answer", async () => {
    answer = async () => state(Date.now() - HOUR);
    assert.equal(serverClock.synced(), false);
    mount();
    await settle();
    assert.equal(serverClock.synced(), true, "a read that carries serverNow left the clock cold");
    assert.ok(Math.abs(skew() + HOUR) < 2_000, `the clock is ${skew()} ms from the host's, not an hour behind it`);
  });

  /** Every reading the page's clock was given, as [serverMs, rttMs]. */
  const readings: [number, number | undefined][] = [];
  const realObserve = serverClock.observe.bind(serverClock);
  beforeEach(() => {
    readings.length = 0;
    serverClock.observe = (ms: number, rtt?: number) => {
      readings.push([ms, rtt]);
      return realObserve(ms, rtt);
    };
  });
  afterEach(() => {
    serverClock.observe = realObserve;
  });

  /** The read fails, so only frames can speak. */
  const readFails = () => {
    answer = async () => {
      throw new Error("down");
    };
  };
  const quietly = async (fn: () => Promise<void>) => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      await fn();
    } finally {
      console.warn = warn;
    }
  };

  test("the read is never served from a cache: it is a clock sample", async () => {
    answer = async () => state(Date.now());
    inits.length = 0;
    mount();
    await settle();
    assert.ok(inits.length > 0 && inits.every((i) => i?.cache === "no-store"), `the read went out as ${JSON.stringify(inits)}`);
  });

  test("a live frame is a reading, unpaired, and two components subscribing to one frame feed it once", async () => {
    readFails();
    await quietly(async () => {
      mount();
      mount();
      await settle();
      await act(async () => FakeEventSource.last!.push("messages:state", state(1_000_000, 2)));
    });
    assert.deepEqual(readings, [[1_000_000, undefined]]);
  });

  test("two live frames a second apart set a clock whose read failed", async () => {
    readFails();
    await quietly(async () => {
      mount();
      await settle();
      await act(async () => FakeEventSource.last!.push("messages:state", state(Date.now() - HOUR, 2)));
      await new Promise((r) => setTimeout(r, 1_100));
      await act(async () => FakeEventSource.last!.push("messages:state", state(Date.now() - HOUR, 3)));
    });
    assert.equal(serverClock.synced(), true);
    assert.ok(Math.abs(skew() + HOUR) < 2_000, `${skew()}`);
  });

  test("a replayed frame is this page's own cache, and is not a reading", async () => {
    readFails();
    await quietly(async () => {
      mount();
      await settle();
      cleanup();
      // Nobody is listening when this frame arrives; the page's cache keeps it.
      await act(async () => FakeEventSource.last!.push("messages:state", state(Date.now() - 24 * HOUR, 2)));
      readings.length = 0;
      // A late subscriber is handed the cached frame.
      mount();
      await settle();
    });
    assert.deepEqual(readings, [], "a cached frame was read as if it were the server's time now");
  });
});
