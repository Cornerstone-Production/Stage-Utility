// A wireless connection added or removed re-reads the channel statuses.
//
// Adding or removing a connection changes which channels exist, which no
// telemetry broadcast reports, so useWirelessTelemetryStatus bumps a revision on
// "wireless:connections-changed" and must re-read and re-subscribe.
//
// What this does NOT prove: it runs under tsx, which does not run the React
// Compiler. The bug it guards (a `void connectionsRev` dependency inside the
// read, which the compiler drops, leaving `read` a module-level function that
// never changes) passes here with the old code too, because uncompiled
// useCallback honours the dependency. The compiled behaviour is checked by
// compiling the hook with babel-plugin-react-compiler as vite.config.ts does and
// reading the output: `resubscribeKey` must reach useStatusChannel's effect
// dependencies. This test guards the behaviour the fix must keep: the
// notification re-reads the statuses, and the same hook stays subscribed.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

let statusReads = 0;
/** Answers the FIRST statuses read, late, when the test says so; every later read answers at once. */
let releaseFirstRead: (rows: unknown[]) => void = () => {};
const reply = (rows: unknown[]) => ({ ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) });
(globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.includes("/api/integrations/wireless/statuses")) {
    statusReads += 1;
    if (statusReads === 1) return new Promise((resolve) => (releaseFirstRead = (rows) => resolve(reply(rows))));
    return reply([{ id: "new" }]);
  }
  return reply([]);
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { useWirelessTelemetryStatus } = await import("./use-wireless-telemetry.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
  statusReads = 0;
});
afterEach(async () => {
  cleanup();
  await settle();
});

test("wireless:connections-changed re-reads wireless:channelStatuses, and the replaced window cannot land late", async () => {
  let channels: { id: string }[] = [];
  function Probe(): React.ReactElement {
    channels = useWirelessTelemetryStatus().channels as unknown as { id: string }[];
    return React.createElement("output", null, String(channels.length));
  }
  await act(async () => {
    render(React.createElement(Probe));
    await settle();
  });
  assert.equal(statusReads, 1, "the first mount reads once");

  // The first read is still in flight when a connection is added.
  await act(async () => {
    FakeEventSource.last!.push("wireless:connections-changed", []);
    await settle();
  });
  assert.equal(statusReads, 2, "a connection change reads again");
  assert.deepEqual(channels.map((c) => c.id), ["new"]);

  // The replaced window's read answers now. Torn down, it must not overwrite.
  await act(async () => {
    releaseFirstRead([{ id: "stale" }]);
    await settle();
  });
  assert.deepEqual(channels.map((c) => c.id), ["new"], "a read from the replaced window landed over the new one");

  await act(async () => {
    FakeEventSource.last!.push("wireless:connections-changed", []);
    await settle();
  });
  assert.equal(statusReads, 3, "and again on the next change");
});
