// Renderer tests run the router the browser runs.
//
// Under plain Node, `@tanstack/router-core/isServer` resolves to the server
// build, and from router-core 1.171.32 a server router commits no navigation:
// `navigate()` resolves and the URL never changes. test-dom.ts redirects that
// one module to the client build. Both checks below resolve and run the real
// router rather than reading test-dom's source, so deleting the hook fails the
// first on any router version and the second on any version that skips the
// commit.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { eventually, installDom, installRenderDom, isPlumbing, readLedger } from "./test-dom.js";

// The client build reads `window`, as it would in a browser.
const teardown = installDom();
after(() => teardown());

describe("the router under test", () => {
  test("is the client build", async () => {
    const { isServer } = await import("@tanstack/router-core/isServer");
    assert.equal(isServer, false, "renderer tests resolved the router's server build");
  });

  test("commits a navigation to its history", async () => {
    const { createMemoryHistory, createRootRoute, createRoute, createRouter } = await import("@tanstack/react-router");
    const root = createRootRoute({});
    const page = createRoute({ getParentRoute: () => root, path: "/history/manage" });
    const router = createRouter({
      routeTree: root.addChildren([page]),
      history: createMemoryHistory({ initialEntries: ["/history/manage"] }),
    });
    // Cast: `to` and `search` are typed against the app's registered route tree,
    // not this two-route one.
    await router.navigate({ to: "/history/manage", search: { service: "weekend:plan-1:1100" } } as never);
    assert.equal(router.history.location.search, "?service=weekend%3Aplan-1%3A1100");
  });
});

describe("eventually", () => {
  test("waits for something that arrives after the first look", async () => {
    const { render, cleanup } = await import("@testing-library/react");
    const React = await import("react");
    function Late() {
      const [text, setText] = React.useState("loading");
      React.useEffect(() => {
        const t = setTimeout(() => setText("loaded"), 150);
        return () => clearTimeout(t);
      }, []);
      return React.createElement("p", null, text);
    }
    const { container } = render(React.createElement(Late));
    // A single look, as a fixed number of ticks amounts to, finds the page early.
    assert.equal(container.textContent, "loading");
    await eventually(() => assert.equal(container.textContent, "loaded"));
    cleanup();
  });

  test("keeps polling when the test has mocked the timers and the clock", { timeout: 3000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    let looks = 0;
    // Testing Library's own waitFor polls with setInterval, which a mock never fires.
    await eventually(() => assert.ok(++looks >= 3, `looked ${looks} time(s)`));
    assert.equal(looks, 3);
  });

  test("retries a check that is async, as it does one that throws", async () => {
    let looks = 0;
    const got = await eventually(async () => {
      looks += 1;
      assert.ok(looks >= 3, `looked ${looks} time(s)`);
      return looks;
    });
    assert.equal(got, 3);
  });

  test("takes one more look after the last gap, as the wait always did", { timeout: 3000 }, async () => {
    let looks = 0;
    // A 5 ms budget is spent inside the first 10 ms gap: the look that follows it is the one that passes.
    await eventually(() => assert.ok(++looks >= 2, `looked ${looks} time(s)`), 5);
    assert.equal(looks, 2);
  });

  test("reports the last failure, not a bare timeout, when the thing never arrives", { timeout: 3000 }, async () => {
    await assert.rejects(
      eventually(() => assert.equal(1, 2, "the thing never arrived"), 100),
      /the thing never arrived/,
    );
  });
});

describe("readLedger", () => {
  const response = (body: unknown) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });

  test("a read is on its way until a caller takes its body, once", async () => {
    const reads = readLedger();
    reads.begin("/api/x");
    const res = reads.answer(response({ a: 1 }));
    assert.equal(reads.pending(), 1, "an answer nobody has read is still on its way");
    assert.throws(() => reads.landed(), /1 read\(s\) still on their way/);
    assert.deepEqual(await res.json(), { a: 1 });
    assert.equal(reads.pending(), 0);
    reads.landed();
    await res.text();
    assert.equal(reads.pending(), 0, "reading the body twice must not take two reads");
  });

  test("the page's own log line is not a read: nobody takes its answer", () => {
    const reads = readLedger();
    reads.begin("/api/log/client");
    assert.equal(reads.pending(), 0);
    reads.landed();
  });

  test("only the log line itself is let off: every other /api/log read still counts", () => {
    for (const url of ["/api/log", "/api/log/tail", "/api/log/client-history", "/api/logs"]) {
      const reads = readLedger();
      reads.begin(url);
      assert.equal(reads.pending(), 1, `${url} is a read a test may wait on`);
    }
    const reads = readLedger();
    reads.begin("/api/log/client?level=warn");
    assert.equal(reads.pending(), 0, "the log line with a query is still the log line");
  });

  test("an answer taken for a read never begun is caught, not cancelled out", async () => {
    const reads = readLedger();
    await reads.answer(response({ a: 1 })).json();
    assert.throws(() => reads.landed(), /1 answer\(s\) taken for reads that were never begun/);
  });

  test("a read that failed is not left pending, and reset starts again", () => {
    const reads = readLedger();
    reads.begin("/api/x");
    reads.failed();
    assert.equal(reads.pending(), 0);
    reads.begin("/api/x");
    reads.reset();
    assert.equal(reads.pending(), 0);
  });
});

describe("isPlumbing", () => {
  test("is the live-update stream's traffic and nothing a component does", () => {
    for (const url of ["/api/events", "/api/events?cid=abc", "/api/events/subscribe", "/api/events/poll?cid=abc&since=4"]) {
      assert.equal(isPlumbing(url), true, url);
    }
    for (const url of ["/api/state", "/api/outputs/display-1", "/api/log/client", "/api/history/events"]) {
      assert.equal(isPlumbing(url), false, url);
    }
  });
});

// React stays silent about updates that escape act() unless it is told it is in a
// test environment, and undrained work then runs after the DOM is gone. This runs
// the real installDom rather than reading its source.
describe("installDom and the React act environment", () => {
  test("turns the flag on for the file and puts the previous value back on teardown", () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const outer = g.IS_REACT_ACT_ENVIRONMENT;
    const inner = installDom();
    assert.equal(g.IS_REACT_ACT_ENVIRONMENT, true, "installDom left React outside its act environment");
    g.IS_REACT_ACT_ENVIRONMENT = false;
    inner();
    assert.equal(g.IS_REACT_ACT_ENVIRONMENT, outer, "the teardown did not restore what it found");
  });

  test("the teardown fails the file when React reported an update outside act", () => {
    const outerError = console.error;
    // Swallow the message so it reaches neither the log nor this file's own recorder.
    console.error = () => {};
    try {
      const inner = installDom();
      console.error("An update to Probe inside a test was not wrapped in act(...).\n\nmore text");
      console.error("an unrelated error");
      assert.throws(inner, /1 React act warning\(s\).*An update to Probe inside a test was not wrapped in act/);
      assert.equal(typeof console.error, "function");
    } finally {
      console.error = outerError;
    }
  });

  test("a clean file tears down quietly and gives console.error back", () => {
    const before = console.error;
    const inner = installDom();
    assert.notEqual(console.error, before, "the recorder is not installed");
    inner();
    assert.equal(console.error, before, "the teardown left its recorder behind");
  });
});

// IntersectionObserver and matchMedia are opt-in because production branches on
// their ABSENCE (lazy-preview.tsx, history-service-header.tsx, use-media-query.ts,
// apply-favicon.ts). A default stub would silently flip those branches in every DOM
// test, so the default leaves both undefined and the opt-in installs and removes them.
describe("the opt-in platform stubs", () => {
  const g = globalThis as unknown as { IntersectionObserver?: unknown; matchMedia?: unknown };
  const win = () => window as unknown as { matchMedia?: (q: string) => { matches: boolean } };

  test("a plain DOM has neither, so the absent-branches stay testable", () => {
    const off = installDom();
    try {
      assert.equal(typeof g.IntersectionObserver, "undefined", "IntersectionObserver was installed by default");
      assert.equal(typeof win().matchMedia, "undefined", "matchMedia was installed by default");
    } finally {
      off();
    }
  });

  test("asking for them installs both, and the teardown takes them away again", () => {
    const off = installDom(undefined, { intersectionObserver: true, matchMedia: true });
    try {
      const observer = new (g.IntersectionObserver as new (cb: () => void) => { observe: (el: unknown) => void; disconnect: () => void })(() => {});
      observer.observe({});
      observer.disconnect();
      assert.equal(win().matchMedia?.("(prefers-color-scheme: dark)").matches, false);
    } finally {
      off();
    }
    assert.equal(typeof g.IntersectionObserver, "undefined", "IntersectionObserver outlived its teardown");
  });

  test("each is asked for on its own, and installRenderDom passes the request on", () => {
    const off = installRenderDom({ intersectionObserver: true });
    try {
      assert.equal(typeof g.IntersectionObserver, "function");
      assert.equal(typeof win().matchMedia, "undefined", "matchMedia came along with IntersectionObserver");
    } finally {
      off();
    }
  });
});
