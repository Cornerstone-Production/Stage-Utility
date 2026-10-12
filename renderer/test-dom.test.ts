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

import { eventually, installDom, isPlumbing, readLedger } from "./test-dom.js";

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

  test("reports the last failure, not a bare timeout, when the thing never arrives", async () => {
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
    reads.begin();
    const res = reads.answer(response({ a: 1 }));
    assert.equal(reads.pending(), 1, "an answer nobody has read is still on its way");
    assert.throws(() => reads.landed(), /1 read\(s\) still on their way/);
    assert.deepEqual(await res.json(), { a: 1 });
    assert.equal(reads.pending(), 0);
    reads.landed();
    await res.text();
    assert.equal(reads.pending(), 0, "reading the body twice must not take two reads");
  });

  test("a read that failed is not left pending, and reset starts again", () => {
    const reads = readLedger();
    reads.begin();
    reads.failed();
    assert.equal(reads.pending(), 0);
    reads.begin();
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
