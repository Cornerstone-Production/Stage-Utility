// The snooze list after the acting browser re-reads it: that read bridges to the
// next push and no further. The server's rev restarts at 0 with each process, so
// a push at a LOWER rev is newer than a read taken before the restart.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, test } from "node:test";

import { eventually, installDom, settle, unmountAndTeardown } from "../../../test-dom.js";
import { FakeEventSource } from "../../../test-fixtures/fake-event-source.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const snooze = (key: string) => ({ key, severity: "warn" as const, at: 0, expiresAt: null });
let answer: { rev: number; snoozes: ReturnType<typeof snooze>[] } = { rev: 4, snoozes: [snooze("a:1")] };
(globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.startsWith("/api/log/client")) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  if (!url.startsWith("/api/home/snoozes")) throw new Error(`unexpected fetch: ${url}`);
  const body = answer;
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { useHomeSnoozes } = await import("./use-home-snoozes.js");
const { __resetReplayCacheForTests } = await import("../../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});
afterEach(async () => {
  cleanup();
  await settle();
});

test("a push at a LOWER rev (the server restarted) beats an earlier refresh()", async () => {
  let handle: ReturnType<typeof useHomeSnoozes> | null = null;
  function Probe(): React.ReactElement {
    handle = useHomeSnoozes();
    return React.createElement("output", null, (handle.value?.snoozes ?? []).map((s) => s.key).join(","));
  }
  const { container } = render(React.createElement(Probe));
  await settle();
  await eventually(() => assert.equal(container.textContent, "a:1"));

  // The acting browser snoozed b:2; the re-read comes back at rev 5.
  answer = { rev: 5, snoozes: [snooze("a:1"), snooze("b:2")] };
  await act(async () => void (await handle!.refresh()));
  assert.equal(container.textContent, "a:1,b:2");

  // The server restarts, clears on a service start, and pushes rev 1.
  await act(async () => FakeEventSource.last!.push("home:snoozes", { rev: 1, snoozes: [] }));
  assert.equal(container.textContent, "", "the stale refresh hid what the new process says");
});
