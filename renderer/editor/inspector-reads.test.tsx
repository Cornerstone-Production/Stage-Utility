// inspector-reads.test.tsx — three inspector panels, when the list they offer
// fails to load.
//
//   people graph      `.catch(() => setServices([]))`: the Service picker
//                     offered only "Most recent", and labelled a chosen
//                     service "· not found", which says it was deleted
//   plan attachment   `r.ok ? r.json() : []`, and a catch that only marked the
//                     read finished: a Planning Center that did not answer read
//                     "No documents on the current plan"
//   RossTalk button   `.catch(() => {})` on both lists, which start empty: a
//                     configured button labelled its own target "· not found"
//
// Driven through the real components with a stubbed fetch. NOTHING BELOW PASSES
// A DOM NODE AS AN ASSERT OPERAND — node:assert inspects `actual` to build its
// failure message, and inspecting a live jsdom element does not finish in any
// useful time. Every query is coerced to a boolean or a string first.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { alerts, ok, reply, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { PeopleGraphInspector, PlanAttachmentConfig, RossTalkButtonConfig } = await import("./inspector.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
// The attachment picker reads the page's one stage state, which is cached for
// the whole page; the resets keep one case's state out of the next.
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

type Answer = { status: number; body: unknown } | "throw";

/** Answer `route` as given, every other read with an empty 200. */
function stubFetch(route: string, answer: Answer, others: (url: string) => unknown = () => ok({})) {
  return stubFetchWithLog((url) => {
    if (url.includes(route)) {
      if (answer === "throw") throw new TypeError("fetch failed");
      return reply(answer.status, answer.body);
    }
    return others(url);
  });
}

async function mount(el: React.ReactElement): Promise<void> {
  render(React.createElement(TooltipProvider, null, el));
  await settle();
  await settle();
}

const logged = (logs: { tag: string; message: string }[], re: RegExp) =>
  logs.some((l) => l.tag === "layout-editor" && re.test(l.message));

describe("the people graph's recorded-service picker", () => {
  const ROUTE = "/api/attendance/history";
  const CONFIG = { type: "people-graph", source: "recorded", recordedServiceKey: "st1:p1:t1" } as Extract<
    LayoutObjectConfig,
    { type: "people-graph" }
  >;
  const graph = () => React.createElement(PeopleGraphInspector, { c: CONFIG, onConfig: () => {} });

  test("a failed read says so, and never calls the chosen service 'not found'", async () => {
    const f = stubFetch(ROUTE, "throw");
    try {
      await mount(graph());
      assert.match(alerts(), /Couldn't load the recorded services/i);
      assert.equal(!!screen.queryByText(/not found/i), false, "the chosen service was not deleted — the read failed");
      assert.ok(logged(f.logs, /recorded services/i), `expected a [layout-editor] line — got ${JSON.stringify(f.logs)}`);
    } finally {
      f.restore();
    }
  });

  test("a slow failure from a read that no longer applies does not replace the picker", async () => {
    // Recorded, then Live, then Recorded again: the first read is still out,
    // and fails only after the second one has filled the picker.
    let failFirst: (e: Error) => void = () => {};
    let reads = 0;
    const f = stubFetchWithLog((url) => {
      if (!url.includes(ROUTE)) return ok({});
      reads += 1;
      if (reads === 1) return new Promise((_, reject) => { failFirst = reject; });
      return ok([{ serviceKey: "st1:p1:t1", startedAt: "2026-09-20T15:00:00.000Z", endedAt: "2026-09-20T16:15:00.000Z", serviceTypeName: "Weekend" }]);
    });
    try {
      const el = (source: "live" | "recorded") =>
        React.createElement(TooltipProvider, null, React.createElement(PeopleGraphInspector, { c: { ...CONFIG, source }, onConfig: () => {} }));
      const view = render(el("recorded"));
      await settle();
      view.rerender(el("live"));
      await settle();
      view.rerender(el("recorded"));
      await settle();
      await settle();
      assert.equal(!!screen.queryByRole("option", { name: /Weekend/ }), true, "the second read filled the picker");
      await act(async () => failFirst(new TypeError("fetch failed")));
      await settle();
      assert.equal(alerts(), "", "the first read no longer applies; its failure must not land");
      assert.equal(!!screen.queryByRole("option", { name: /Weekend/ }), true);
    } finally {
      f.restore();
    }
  });

  test("a read that works after a failed one brings the picker back", async () => {
    // Recorded fails; Live, then Recorded again, reads the list.
    let reads = 0;
    const f = stubFetchWithLog((url) => {
      if (!url.includes(ROUTE)) return ok({});
      reads += 1;
      if (reads === 1) throw new TypeError("fetch failed");
      return ok([{ serviceKey: "st1:p1:t1", startedAt: "2026-09-20T15:00:00.000Z", endedAt: "2026-09-20T16:15:00.000Z", serviceTypeName: "Weekend" }]);
    });
    try {
      const el = (source: "live" | "recorded") =>
        React.createElement(TooltipProvider, null, React.createElement(PeopleGraphInspector, { c: { ...CONFIG, source }, onConfig: () => {} }));
      const view = render(el("recorded"));
      await settle();
      await settle();
      assert.match(alerts(), /Couldn't load the recorded services/i);
      view.rerender(el("live"));
      await settle();
      view.rerender(el("recorded"));
      await settle();
      await settle();
      assert.equal(alerts(), "", "the list loaded; the note must go with the failure");
      assert.equal(!!screen.queryByRole("option", { name: /Weekend/ }), true);
    } finally {
      f.restore();
    }
  });

  test("control: the list loads and the chosen service is offered by name", async () => {
    const f = stubFetch(ROUTE, {
      status: 200,
      body: [{ serviceKey: "st1:p1:t1", startedAt: "2026-09-20T15:00:00.000Z", endedAt: "2026-09-20T16:15:00.000Z", serviceTypeName: "Weekend" }],
    });
    try {
      await mount(graph());
      assert.equal(!!screen.queryByRole("option", { name: /Weekend/ }), true);
      assert.equal(!!screen.queryByText(/not found/i), false);
      assert.equal(alerts(), "");
      assert.deepEqual(f.logs, []);
    } finally {
      f.restore();
    }
  });
});

describe("the RossTalk button's target and command pickers", () => {
  const TARGETS = "/api/rosstalk/targets";
  const CONFIG = { type: "rosstalk-button", targetId: "t1", commandId: "cut", params: {}, label: "Cut" } as Extract<
    LayoutObjectConfig,
    { type: "rosstalk-button" }
  >;
  const button = () => React.createElement(RossTalkButtonConfig, { c: CONFIG, onConfig: () => {} });

  const STUDIO = { status: 200, body: { targets: [{ id: "t1", name: "Studio", enabled: true, config: { family: "carbonite" }, connection: "connected", message: null }] } };
  /** Both reads answered: the targets as given, the commands as given or a
   *  catalogue holding the button's own command. */
  const stubRossTalk = (targets: Answer, commandsFail = false) =>
    stubFetch(TARGETS, targets, (url) => {
      if (!url.includes("/api/rosstalk/commands")) return ok({});
      if (commandsFail) throw new TypeError("fetch failed");
      return ok([{ id: "cut", label: "Cut", family: "carbonite", params: [] }]);
    });

  test("a failed read says so, and never calls the button's target 'not found'", async () => {
    const f = stubRossTalk("throw");
    try {
      await mount(button());
      assert.match(alerts(), /Couldn't load the RossTalk targets/i);
      assert.equal(!!screen.queryByText(/not found/i), false, "the target was not deleted — the read failed");
      assert.ok(logged(f.logs, /RossTalk targets/i), `expected a [layout-editor] line — got ${JSON.stringify(f.logs)}`);
    } finally {
      f.restore();
    }
  });

  test("a failed command read alone says so too, and never calls the button's command 'not found'", async () => {
    const f = stubRossTalk(STUDIO, true);
    try {
      await mount(button());
      assert.match(alerts(), /Couldn't load the RossTalk commands/i);
      assert.equal(!!screen.queryByText(/not found/i), false, "the command was not deleted — the read failed");
      assert.ok(logged(f.logs, /RossTalk commands/i), `expected a [layout-editor] line — got ${JSON.stringify(f.logs)}`);
    } finally {
      f.restore();
    }
  });

  test("control: the lists load, the target and its command are offered by name", async () => {
    const f = stubRossTalk(STUDIO);
    try {
      await mount(button());
      assert.equal(!!screen.queryByRole("option", { name: /Studio/ }), true);
      assert.equal(!!screen.queryByRole("option", { name: "Cut" }), true);
      assert.equal(!!screen.queryByText(/not found/i), false);
      assert.equal(alerts(), "");
      assert.deepEqual(f.logs, []);
    } finally {
      f.restore();
    }
  });
});

describe("the plan attachment's file picker", () => {
  const ROUTE = "/api/pco/attachments";
  const NO_DOCUMENTS = /No documents on the current plan/i;
  /** The stage state, saying whether Planning Center is connected. */
  const stateSays = (pcoConfigured: boolean) => (url: string) =>
    url.includes("/api/state") ? ok({ pcoConfigured }) : ok({});
  const attachment = () =>
    React.createElement(PlanAttachmentConfig, {
      c: { type: "plan-attachment", match: "stage plot" } as Extract<LayoutObjectConfig, { type: "plan-attachment" }>,
      onConfig: () => {},
      o: { id: "o1", x: 0, y: 0, w: 0.5, h: 0.5 } as LayoutObject,
      canvas: { width: 1920, height: 1080, background: null },
      onGeom: () => {},
    });

  test("a read that throws says so, not 'No documents on the current plan'", async () => {
    const f = stubFetch(ROUTE, "throw", stateSays(true));
    try {
      await mount(attachment());
      assert.match(alerts(), /Couldn't load the current plan's files/i);
      assert.equal(!!screen.queryByText(NO_DOCUMENTS), false);
      assert.ok(logged(f.logs, /plan's files/i), `expected a [layout-editor] line — got ${JSON.stringify(f.logs)}`);
    } finally {
      f.restore();
    }
  });

  test("a 502 is a failure too, and the server's reason reaches the log", async () => {
    const f = stubFetch(ROUTE, { status: 502, body: { error: "Planning Center did not answer" } }, stateSays(true));
    try {
      await mount(attachment());
      assert.match(alerts(), /Couldn't load the current plan's files/i);
      assert.equal(!!screen.queryByText(NO_DOCUMENTS), false);
      assert.ok(
        logged(f.logs, /Planning Center did not answer/),
        `expected the server's reason on the [layout-editor] line — got ${JSON.stringify(f.logs)}`,
      );
    } finally {
      f.restore();
    }
  });

  test("Planning Center not connected says to connect it: no read, no alert, and no claim about the plan", async () => {
    const asked: string[] = [];
    const f = stubFetchWithLog((url) => {
      asked.push(url);
      return url.includes(ROUTE) ? ok([]) : stateSays(false)(url);
    });
    try {
      await mount(attachment());
      assert.equal(!!screen.queryByText(/Connect Planning Center to pick from the current plan/i), true);
      assert.equal(!!screen.queryByText(NO_DOCUMENTS), false, "there is no plan to have no documents");
      assert.equal(alerts(), "");
      assert.deepEqual(f.logs, []);
      assert.equal(asked.some((u) => u.includes(ROUTE)), false, "without Planning Center there is no current plan to ask");
    } finally {
      f.restore();
    }
  });

  test("control: a plan with no documents still says so, with no alert", async () => {
    const f = stubFetch(ROUTE, { status: 200, body: [] }, stateSays(true));
    try {
      await mount(attachment());
      assert.equal(!!screen.queryByText(NO_DOCUMENTS), true);
      assert.equal(alerts(), "");
      assert.deepEqual(f.logs, []);
    } finally {
      f.restore();
    }
  });
});
