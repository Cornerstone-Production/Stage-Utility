import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { __previewLimits } = await import("./lazy-preview.js");

after(() => teardown());

beforeEach(() => __previewLimits.reset());

// The cap is the fallback for browsers without a SharedWorker, or a worker the
// heartbeat had to abandon. It exists because every preview iframe runs a real
// kiosk page: with a per-tab stream, the seventh preview on an eight-screen
// install never loaded and the page's own /api/state queued behind it and timed
// out. The symptom read as a slow server.
describe("preview slot limit", () => {
  test("is finite", () => {
    // Unbounded, a hundred screens means a hundred iframes - a memory and CPU
    // problem on a Pi long before it is a connection problem, and nothing else
    // bounds how many screens an operator can create.
    assert.ok(Number.isFinite(__previewLimits.MAX_LIVE_PREVIEWS));
    assert.ok(__previewLimits.MAX_LIVE_PREVIEWS > 0);
  });

  test("leaves room for the page's own traffic under the old limit", () => {
    // A browser allows roughly six concurrent connections per origin over
    // HTTP/1.1. The cap is deliberately ABOVE that now, because sharing one
    // stream is what removes the constraint - but it must never be so low that
    // it throttles previews when the shared worker is doing its job.
    assert.ok(
      __previewLimits.MAX_LIVE_PREVIEWS >= 6,
      "a cap below the browser's own limit would throttle previews the shared stream can afford",
    );
  });

  test("starts with nothing streaming", () => {
    assert.equal(__previewLimits.liveCount(), 0);
  });
});
