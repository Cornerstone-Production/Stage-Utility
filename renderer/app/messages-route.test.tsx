// Settings -> Messages must not wait on the stage state. The page only borrows
// the screens from it, to say how many are in each group, and a stage state that
// fails to load once held the whole page on a spinner.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

// The page's state hooks open the event stream; a real one keeps the process alive.
class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MessagesRoute } = await import("./settings-routes.js");
const { TooltipProvider, ConfirmHost, Toaster } = await import("../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const CONFIG = {
  version: 1,
  groups: [{ id: "g-11111111", name: "Green room" }],
  quickMessages: ["Walk now"],
  quickReplies: ["Copy"],
};

test("the page draws although the stage state failed to load, with no screen count rather than a 0", async () => {
  const f = stubFetchWithLog((url) => {
    if (url === "/api/messaging") return ok(CONFIG);
    // The stage state fails: the page must not be waiting on it.
    if (url === "/api/state") return reply(500, { error: "boom" });
    return ok({});
  });
  try {
    // gcTime 0: a cache entry's default five-minute timer keeps the process alive.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(TooltipProvider, null, React.createElement(MessagesRoute), React.createElement(ConfirmHost), React.createElement(Toaster)),
      ),
    );
    await settle();
    await settle();
    assert.ok(screen.getByLabelText("Rename Green room"), "the groups editor never drew");
    const row = document.querySelector('[data-group-row="g-11111111"]');
    assert.ok(row, "no group row");
    assert.doesNotMatch(row.textContent ?? "", /screen/, "a count was drawn before the screens were known");
  } finally {
    f.restore();
  }
});
