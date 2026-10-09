// The Screens page's view of the message groups: read from /api/messages, kept
// live by messages:state, and honest about a read that failed.
//
// Driven through the real api.ts over a fake EventSource, like
// use-status-channel.test.tsx, because the failure it guards is the one that
// hook exists for: "no groups yet" shown for a read that never answered would
// send an operator off to make groups that already exist.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

let answer: () => Promise<unknown> = async () => ({});
/** What the page sent to /log. */
const toLog: unknown[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url === "/api/log/client") {
    toLog.push(JSON.parse(String(init?.body)));
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  }
  if (!url.startsWith("/api/messages")) throw new Error(`unexpected fetch in use-message-groups.test.tsx: ${url}`);
  const body = await answer();
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { useMessageGroups } = await import("./use-message-groups.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");
type MessageGroups = import("./use-message-groups.js").MessageGroups;

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});
afterEach(async () => {
  cleanup();
  await settle();
});

const state = (names: string[], rev = 1) => ({
  rev,
  groups: names.map((name, i) => ({ id: `g-0000000${i}`, name })),
  messages: [],
  alerts: [],
});

function mount(): { current: MessageGroups } {
  const seen = { current: { groups: [], known: false, failed: false } as MessageGroups };
  function Probe(): React.ReactElement {
    seen.current = useMessageGroups();
    return React.createElement("output");
  }
  render(React.createElement(Probe));
  return seen;
}

describe("useMessageGroups", () => {
  test("reads the groups, and is unknown until it has", async () => {
    answer = async () => state(["Green room", "Stage"]);
    const seen = mount();
    assert.equal(seen.current.known, false, "claimed to know before anything answered");
    await settle();
    assert.deepEqual(seen.current.groups.map((g) => g.name), ["Green room", "Stage"]);
    assert.equal(seen.current.known, true);
    assert.equal(seen.current.failed, false);
  });

  test("follows messages:state, so a rename in Settings reaches an open page", async () => {
    answer = async () => state(["Green room"], 1);
    const seen = mount();
    await settle();
    await act(async () => FakeEventSource.last!.push("messages:state", state(["Greenroom", "Booth"], 2)));
    await settle();
    assert.deepEqual(seen.current.groups.map((g) => g.name), ["Greenroom", "Booth"]);
  });

  test("a read that answers nothing is failed, not an empty list", async () => {
    answer = async () => null;
    const seen = mount();
    await settle();
    assert.equal(seen.current.known, true);
    assert.equal(seen.current.failed, true, "an unanswered read must not read as 'no groups yet'");
    assert.deepEqual(seen.current.groups, []);
  });

  test("a read that throws is failed too", async () => {
    answer = async () => {
      throw new Error("network down");
    };
    const warn = console.warn;
    console.warn = () => {};
    toLog.length = 0;
    try {
      const seen = mount();
      await settle();
      assert.equal(seen.current.failed, true);
    } finally {
      console.warn = warn;
    }
    // And said on /log: a screen that cannot read the messages is otherwise a
    // screen that silently never shows an alert.
    assert.deepEqual(toLog, [{ tag: "messages", message: "could not read the stage messages: network down" }]);
  });
});
