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

import { installDom } from "./test-dom.js";

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
