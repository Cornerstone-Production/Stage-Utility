// What the publisher tells the thing that keeps the page itself up to date: which build the page
// serves each time it reads the page's status, and when it stops looking. The decisions that follow
// are servicecue-deployer.test.ts's; here it is a recording hook.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { viewerBuildTag } from "../types/servicecue-publish.js";
import type { DeployHook } from "./servicecue-deployer.js";
import { harness, installPublisherHooks, logs, sleep } from "./fixtures/publisher-harness.js";

installPublisherHooks();

function recorder(): DeployHook & { calls: (string | null)[]; stops: number } {
  const r = {
    calls: [] as (string | null)[],
    stops: 0,
    consider(build: string | null) {
      r.calls.push(build);
    },
    stop() {
      r.stops += 1;
    },
  };
  return r;
}

describe("the publisher and the deployer", () => {
  it("hands over the page's build on the first status read of a run, and again at each later one", async (t) => {
    logs(t);
    const hook = recorder();
    const h = await harness({ reconcileMs: 0 }, { deploy: hook });
    h.page.document = `<!doctype html>${viewerBuildTag("0123456789ab")}`;
    await h.pub.start();
    await h.pub.runCycle();
    assert.deepEqual(hook.calls, ["0123456789ab"], "the first status read of the run");
    await h.pub.runCycle();
    assert.deepEqual(hook.calls, ["0123456789ab", "0123456789ab"], "the next one, a reconcile");
  });

  it("says there is no build when the Worker serves a page with none", async (t) => {
    logs(t);
    const hook = recorder();
    const h = await harness({}, { deploy: hook });
    h.page.document = null;
    await h.pub.start();
    await h.pub.runCycle();
    assert.deepEqual(hook.calls, [null]);
  });

  it("hands over nothing when the page did not answer as the page does", async (t) => {
    logs(t);
    const hook = recorder();
    const h = await harness({}, { deploy: hook });
    h.page.respond = () => ({ status: 404 });
    await h.pub.start();
    await h.pub.runCycle();
    await sleep(30);
    assert.deepEqual(hook.calls, []);
  });

  it("tells it to stop when publishing stops, and when the settings change under it", async (t) => {
    logs(t);
    const hook = recorder();
    const h = await harness({}, { deploy: hook });
    await h.pub.start();
    await h.pub.runCycle();
    const before = hook.stops;
    h.pub.stop();
    assert.equal(hook.stops, before + 1, "publishing stopped and the deployer was not told");
    await h.pub.apply();
    h.settings.enabled = false;
    const mid = hook.stops;
    await h.pub.apply();
    assert.ok(hook.stops > mid, "switching off did not stop the deployer");
  });
});
