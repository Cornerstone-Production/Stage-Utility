// history-milestones-reads.test.tsx — the Milestones panel, when its list
// cannot be read.
//
// The read used to toast once and then say "No milestones yet." for as long as
// the panel was open: a claim about the church's history, made because a
// request failed. It now says the list could not load, and a save — which the
// server answers with the whole list — settles it.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { HistoryMilestonesPanel } = await import("./history-milestones-panel.js");
const { TooltipProvider } = await import("../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const SAVED = [{ id: "m1", date: "2026-09-20", label: "Moved to two services", serviceTypeId: null }];

function stubFetch(listFails: boolean, typesFail = false) {
  return stubFetchWithLog((url, init) => {
    if (url === "/api/history/milestones") {
      if ((init?.method ?? "GET") === "POST") return ok(SAVED);
      if (listFails) throw new TypeError("fetch failed");
      return ok([]);
    }
    // Where the panel learns the service types' names.
    if (url === "/api/service-timeline") {
      if (typesFail) throw new TypeError("fetch failed");
      return ok([]);
    }
    return ok({});
  });
}

async function mount(): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(HistoryMilestonesPanel)));
  await settle();
  await settle();
}

test("a failed list read says so, never 'No milestones yet', and reaches the log", async () => {
  const f = stubFetch(true);
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the milestones/i);
    assert.equal(!!screen.queryByText(/No milestones yet/i), false, "a failed read is not an empty history");
    assert.ok(
      f.logs.some((l) => l.tag === "history" && /could not read the milestones/.test(l.message)),
      `expected a [history] line — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("a save after a failed read shows the list it answered with, and stops alerting", async () => {
  const f = stubFetch(true);
  try {
    await mount();
    fireEvent.change(screen.getByLabelText("Milestone date"), { target: { value: "2026-09-20" } });
    fireEvent.change(screen.getByLabelText("Milestone label"), { target: { value: "Moved to two services" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await settle();
    await settle();
    assert.equal(!!screen.queryByText("Moved to two services"), true);
    assert.equal(alerts(), "", "the list is known now");
  } finally {
    f.restore();
  }
});

test("service type names that cannot be read are said to be missing, and reach the log", async () => {
  const f = stubFetch(false, true);
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the service type names/i);
    assert.ok(
      f.logs.some((l) => l.tag === "history" && /service types for the milestones/.test(l.message)),
      `expected a [history] line — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("control: an empty list says there are none yet, with no alert", async () => {
  const f = stubFetch(false);
  try {
    await mount();
    assert.equal(!!screen.queryByText(/No milestones yet/i), true);
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});
