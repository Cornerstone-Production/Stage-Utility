// One checklist behind every widget that draws one, and a failed read that says so.
//
// Two properties, both of which used to be false while every test passed:
//
// 1. TWO MOUNTED CHECKLISTS ARE ONE LIST. The rows lived in each hook's own
//    useState, so a page carrying the Home card and the layout object held two
//    copies that never spoke again after the first tick. notes-objects.tsx tells
//    the reader the opposite in as many words.
//
// 2. A FAILED READ IS NOT AN EMPTY PLAN. The catch invented
//    `{ rows: [], unconfigured: false }` — a DTO asserting this plan legitimately
//    has no rows — so with Planning Center unreachable the object drew "No plan
//    notes chosen — Settings, Plan" and sent the operator to fix a setting that
//    was already correct.
//
// Every id and every row below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/** jsdom ships no EventSource, and useStageState subscribes to one. */
(globalThis as unknown as { EventSource: unknown }).EventSource = class {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
};

const PLAN_ID = "plan-alpha";

/** Rows as the server would answer them. */
let checklistRowsOnServer = [
  { key: "prod:batteries", text: "Wireless batteries fresh", done: false },
  { key: "prod:co2", text: "CO2 tank hooked up", done: false },
];
/** Set to fail the checklist read — Planning Center unreachable. */
let checklistFails = false;
/** Every checklist:get the page issued, so "one read for the page" is countable. */
let checklistReads = 0;

(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
  const ok = (payload: unknown) =>
    ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });

  if (url.includes("/api/state")) return ok({ planId: PLAN_ID, hourCycle: "24h", accentColor: null });

  if (url.includes("/api/pco/checklist/tick")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; done: boolean };
    checklistRowsOnServer = checklistRowsOnServer.map((r) =>
      r.key === body.key ? { ...r, done: body.done } : r,
    );
    return ok({ planId: PLAN_ID, rows: checklistRowsOnServer, unconfigured: false });
  }

  if (url.includes("/api/pco/checklist")) {
    checklistReads++;
    if (checklistFails) {
      return { ok: false, status: 502, json: async () => ({ error: "planning center unreachable" }), text: async () => '{"error":"planning center unreachable"}' };
    }
    return ok({ planId: PLAN_ID, rows: checklistRowsOnServer, unconfigured: false });
  }

  return ok({});
};

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { usePlanChecklist, __resetForTests } = await import("./use-plan-checklist.js");
const stage = await import("./use-stage-state.js");

/** The mount fetch settles through several macrotasks before the rows land. */
const settled = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10));
};

after(async () => {
  cleanup();
  await settled();
  teardown();
});

beforeEach(() => {
  cleanup();
  __resetForTests();
  stage.__resetForTests();
  checklistFails = false;
  checklistReads = 0;
  checklistRowsOnServer = [
    { key: "prod:batteries", text: "Wireless batteries fresh", done: false },
    { key: "prod:co2", text: "CO2 tank hooked up", done: false },
  ];
});

afterEach(async () => {
  cleanup();
  await settled();
});

/** One widget: its rows, and a button per row that ticks it. */
function Widget({ name }: { name: string }) {
  const { rows, error, toggle } = usePlanChecklist();
  return React.createElement(
    "div",
    { "data-widget": name },
    React.createElement("span", { "data-error": name }, error ?? ""),
    ...rows.map((r) =>
      React.createElement(
        "button",
        {
          key: r.key,
          type: "button",
          "data-row": `${name}:${r.key}`,
          onClick: () => void toggle(r.key, !r.done),
        },
        r.done ? "done" : "todo",
      ),
    ),
  );
}

const row = (name: string, key: string) =>
  document.querySelector(`[data-row="${name}:${key}"]`) as HTMLElement | null;

describe("one list behind every widget", () => {
  test("a tick on one checklist moves the other one on the same page", async () => {
    // THE GUARD. Two hooks, one store. With the rows in per-consumer useState the
    // second widget holds "todo" for the life of the page — and neither widget
    // can tell, because each is internally consistent.
    render(
      React.createElement(
        "div",
        null,
        React.createElement(Widget, { key: "a", name: "home" }),
        React.createElement(Widget, { key: "b", name: "object" }),
      ),
    );
    await settled();

    assert.equal(row("home", "prod:co2")?.textContent, "todo", "the rows never arrived");
    assert.equal(row("object", "prod:co2")?.textContent, "todo");

    fireEvent.click(row("home", "prod:co2") as HTMLElement);
    await settled();

    assert.equal(row("home", "prod:co2")?.textContent, "done", "the tick did not land at all");
    assert.equal(
      row("object", "prod:co2")?.textContent,
      "done",
      "the second checklist kept the old value — there are two stores, not one",
    );
  });

  test("a page of many widgets issues ONE read, not one each", async () => {
    // A nine-tile producer multiview asked Planning Center nine times for the
    // same list. Exact, not a ceiling: the point is that the count does not
    // follow the number of tiles.
    render(
      React.createElement(
        "div",
        null,
        ...["a", "b", "c", "d", "e"].map((n) => React.createElement(Widget, { key: n, name: n })),
      ),
    );
    await settled();
    assert.equal(checklistReads, 1, `five widgets issued ${checklistReads} reads`);
  });
});

describe("a failed read is not an empty plan", () => {
  test("THE GUARD: it reports the failure rather than inventing zero rows", async () => {
    // The catch used to publish `{ planId, rows: [], unconfigured: false }`,
    // which neither rethrows nor returns the failure — it asserts that this plan
    // legitimately has nothing on it. The operator was then told to choose plan
    // notes they had already chosen.
    checklistFails = true;
    render(React.createElement(Widget, { name: "object" }));
    await settled();

    const shown = document.querySelector('[data-error="object"]')?.textContent ?? "";
    assert.notEqual(shown, "", "a failed read looked exactly like a plan with no notes on it");
    assert.equal(document.querySelectorAll('[data-row^="object:"]').length, 0, "rows appeared out of a failure");
  });

  test("and a read that simply has no rows reports no failure", async () => {
    // The other half: an empty plan is a real, ordinary answer and must not be
    // dressed up as an outage.
    checklistRowsOnServer = [];
    render(React.createElement(Widget, { name: "object" }));
    await settled();
    assert.equal(document.querySelector('[data-error="object"]')?.textContent, "");
  });
});
