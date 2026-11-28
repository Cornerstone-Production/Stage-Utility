// use-history-lists.test.tsx — the re-read History runs after a failed delete.
//
// A failed delete re-reads the attendance list to undo its optimistic removal.
// When that re-read fails too, the list the page already drew stays (the old
// copy swallowed the failure silently; this one keeps the list AND says so on
// [history]). A push kept for a read still out is not lost when a second read
// is sent before the first answers.
//
// The page-level races are in history-list-push-races.test.tsx. NOTHING BELOW
// PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { useHistoryLists } = await import("./use-history-lists.js");
const { __resetReplayCacheForTests } = await import("./api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});

const att = (serviceKey: string) => ({ serviceKey, samples: [] }) as unknown as ServiceAttendance;

/** The attendance list and the failed set, drawn as text, and the re-read. */
function Probe() {
  const { attList, failed, reloadAttendance } = useHistoryLists({ spl: false });
  return React.createElement(
    "div",
    null,
    React.createElement("button", { onClick: reloadAttendance }, "re-read"),
    React.createElement("output", { "aria-label": "list" }, attList.map((a) => a.serviceKey).join(",") || "empty"),
    React.createElement("output", { "aria-label": "failed" }, [...failed].sort().join(",") || "none"),
  );
}
const shown = (label: string) => screen.getByLabelText(label).textContent;

test("a re-read that fails keeps the list it would have replaced, and logs", async () => {
  let failing = false;
  const f = stubFetchWithLog((url) => {
    if (url.startsWith("/api/attendance/history")) {
      if (failing) throw new TypeError("fetch failed");
      return ok([att("st1:a"), att("st1:b")]);
    }
    return ok([]);
  });
  try {
    render(React.createElement(Probe));
    await eventually(() => assert.equal(shown("list"), "st1:a,st1:b"));

    failing = true;
    fireEvent.click(screen.getByRole("button", { name: "re-read" }));
    await settle();

    await eventually(() => assert.equal(shown("failed"), "attendance"));
    assert.equal(shown("list"), "st1:a,st1:b", "a failed re-read emptied the list");
    assert.ok(f.logs.some((l) => l.tag === "history"), "the failure was not logged on [history]");
  } finally {
    f.restore();
  }
});

test("a push kept for a read still out survives a second read sent before it answered", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let call = 0;
  const f = stubFetchWithLog(async (url) => {
    if (url.startsWith("/api/attendance/history")) {
      call += 1;
      if (call === 1) return held.then(() => ok([])); // the first read, still out
      throw new TypeError("fetch failed"); // the re-read
    }
    return ok([]);
  });
  try {
    render(React.createElement(Probe));
    await settle();
    act(() => { FakeEventSource.last!.push("attendance:history", att("st1:arriving")); });
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "re-read" }));
    await settle();
    await eventually(() => assert.equal(shown("failed"), "attendance"));
    release();
    await settle();

    assert.equal(shown("list"), "st1:arriving", "the push kept for the first read was dropped by the second");
  } finally {
    f.restore();
  }
});
