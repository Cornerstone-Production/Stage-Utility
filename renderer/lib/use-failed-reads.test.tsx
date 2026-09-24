// use-failed-reads.test.tsx — the contract every read-failure note leans on.
//
// Two halves, each the difference between a failure an operator can see and
// one they cannot: a failure is recorded AND logged, and a later success takes
// the note away. Plus the rate: a read retried on a timer logs when it starts
// failing, not every tick.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { useFailedReads } = await import("./use-failed-reads.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** Buttons that fail and clear two reads; the set, drawn as text. */
function Probe() {
  const { failed, fail, clear } = useFailedReads<"a" | "b">("probe");
  const boom = new Error("fetch failed");
  return React.createElement(
    "div",
    null,
    React.createElement("button", { onClick: () => fail("a", "the a list", boom) }, "fail a"),
    // Two failures before React commits: what StrictMode's doubled effects, or
    // two reads of one list failing together, produce.
    React.createElement("button", { onClick: () => { fail("a", "the a list", boom); fail("a", "the a list", boom); } }, "fail a twice at once"),
    React.createElement("button", { onClick: () => fail("b", "the b list", boom) }, "fail b"),
    React.createElement("button", { onClick: () => clear("a") }, "clear a"),
    React.createElement("button", { onClick: () => clear() }, "clear all"),
    React.createElement("output", null, [...failed].sort().join(",") || "none"),
  );
}

async function press(name: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name }));
  await settle();
}
const shown = () => screen.getByRole("status").textContent;

test("a failure is recorded and logged, on the tag, in the shared wording", async () => {
  const f = stubFetchWithLog(() => ok({}));
  try {
    render(React.createElement(Probe));
    await press("fail a");
    assert.equal(shown(), "a");
    assert.deepEqual(f.logs, [{ tag: "probe", message: "could not read the a list: fetch failed" }]);
  } finally {
    f.restore();
  }
});

test("a read that keeps failing logs once, and again only after a success", async () => {
  const f = stubFetchWithLog(() => ok({}));
  try {
    render(React.createElement(Probe));
    await press("fail a");
    await press("fail a");
    await press("fail a");
    assert.equal(f.logs.length, 1, "a retry that fails again is the same streak");
    await press("clear a");
    assert.equal(shown(), "none", "the success takes the note away");
    await press("fail a");
    assert.equal(f.logs.length, 2, "a new streak is news");
  } finally {
    f.restore();
  }
});

test("two failures of one read before a commit still log once", async () => {
  const f = stubFetchWithLog(() => ok({}));
  try {
    render(React.createElement(Probe));
    await press("fail a twice at once");
    assert.equal(shown(), "a");
    assert.equal(f.logs.length, 1, "one failure streak, one line");
  } finally {
    f.restore();
  }
});

test("clear() with no argument clears every read, and their streaks", async () => {
  const f = stubFetchWithLog(() => ok({}));
  try {
    render(React.createElement(Probe));
    await press("fail a");
    await press("fail b");
    assert.equal(shown(), "a,b");
    await press("clear all");
    assert.equal(shown(), "none");
    await press("fail b");
    assert.equal(f.logs.length, 3, "b's streak was cleared too");
  } finally {
    f.restore();
  }
});
