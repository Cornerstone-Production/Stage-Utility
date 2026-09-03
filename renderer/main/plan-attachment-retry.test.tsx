// A stage plot that fails to download once must not stay failed until a refresh.
//
// Reported: the plot showed in the editor and not on the display until the
// display was reloaded. The server's cached signed link had expired inside its
// cache window, so the display's fetch got a 502 while the editor, which had
// downloaded a minute earlier, read the file from disk. The object then sat on
// "Couldn't load file" with nothing that would ever try again.
//
// jsdom has no canvas and never fires Image.onload, so "ready" is unreachable
// here. What CAN be seen is the fetch count: how many times the object tried,
// and when. That is the guard — the bug was a count of exactly one.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, mock, test } from "node:test";

import { installRenderDom } from "../test-dom.js";

const teardown = installRenderDom({ clientHeight: 270 });

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { ObjectContent, PLAN_ATTACHMENT_RETRY_MS } = await import("./layout-renderer.js");

after(() => teardown());
afterEach(() => cleanup());

/** Let resolved fetch promises and React's state updates land. setImmediate is
 *  real even while setTimeout is mocked, which is what makes this usable under
 *  mock.timers. */
async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
  }
}

const PLOT = {
  id: "plot-1", x: 0, y: 0, w: 1, h: 1, z: 0,
  config: { type: "plan-attachment", match: "stage plot", page: 1 },
} as never;

function stubFetch(status: number) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("nope", { status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function draw() {
  return render(
    React.createElement(
      TooltipProvider as never,
      null,
      React.createElement(ObjectContent, { o: PLOT, ctx: makeRenderCtx() } as never),
    ),
  );
}

describe("a plan attachment that fails to load", () => {
  test("tries again on a widening schedule, then stops", async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const f = stubFetch(502);
    t.after(() => { f.restore(); mock.timers.reset(); });

    const view = draw();
    await flush();
    assert.equal(f.calls.length, 1, "the first load never happened");
    assert.match(view.container.textContent ?? "", /Couldn.t load file/, "the failure was not shown while waiting to retry");

    let expected = 1;
    for (const gap of PLAN_ATTACHMENT_RETRY_MS) {
      mock.timers.tick(gap - 1);
      await flush();
      assert.equal(f.calls.length, expected, `retried before its ${gap}ms gap was up`);
      mock.timers.tick(1);
      await flush();
      expected += 1;
      assert.equal(f.calls.length, expected, `did not retry after ${gap}ms — a failed plot stays failed until a refresh`);
    }

    // Bounded. A file that is really gone must not be hammered for the rest of
    // the service.
    mock.timers.tick(10 * 60_000);
    await flush();
    assert.equal(f.calls.length, expected, "kept retrying past the schedule");
  });

  test("but a 404 is an answer, not a failure, and is not retried", async (t) => {
    // "No such file on this plan" stays put. A plan change re-fetches through
    // planId; nothing else should.
    mock.timers.enable({ apis: ["setTimeout"] });
    const f = stubFetch(404);
    t.after(() => { f.restore(); mock.timers.reset(); });

    const view = draw();
    await flush();
    assert.equal(f.calls.length, 1);
    assert.match(view.container.textContent ?? "", /No "stage plot" on this plan/);
    mock.timers.tick(10 * 60_000);
    await flush();
    assert.equal(f.calls.length, 1, "a 404 was retried as if it were a transient failure");
  });
});
