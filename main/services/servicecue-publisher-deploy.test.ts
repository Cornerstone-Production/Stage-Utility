// What the publisher tells the thing that keeps the page itself up to date: which build the page
// serves each time it reads the page's status, and when it stops looking. The decisions that follow
// are servicecue-deployer.test.ts's; here it is a recording hook.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { viewerBuildTag } from "../types/servicecue-publish.js";
import type { DeployHook } from "./servicecue-deployer.js";
import { harness, installPublisherHooks, logs, sleep } from "./fixtures/publisher-harness.js";
import { PAGE_STATUS, waitFor } from "./fixtures/publish-receiver.js";

installPublisherHooks();

function recorder(): DeployHook & { calls: (string | null)[]; stops: number; deployed(): void } {
  const listeners: (() => void)[] = [];
  const r = {
    calls: [] as (string | null)[],
    stops: 0,
    consider(build: string | null) {
      r.calls.push(build);
    },
    stop() {
      r.stops += 1;
    },
    onDeployed(listener: () => void) {
      listeners.push(listener);
    },
    /** What the deployer does after a deploy that went through. */
    deployed() {
      for (const l of listeners) l();
    },
  };
  return r;
}

const OLD_BUILD = "0123456789ab";
/** A Worker of another release: a status at protocol 2 on this server's path, the page's document beside it. */
const protocol2 = (req: { method: string; path: string }) =>
  req.path.startsWith("/_publish/v1/status") ? { status: 200, body: JSON.stringify({ ...PAGE_STATUS, protocol: 2, build: OLD_BUILD }) } : req.method === "GET" ? { status: 200, body: "" } : { status: 204 };

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

  it("hands a page of another protocol over with the build it serves, and is held", async (t) => {
    logs(t);
    const hook = recorder();
    const h = await harness({}, { deploy: hook });
    h.page.respond = protocol2;
    await h.pub.start();
    await h.pub.runCycle();
    assert.equal(h.pub.status().lastError?.kind, "protocol");
    assert.deepEqual(hook.calls, [OLD_BUILD], "a page this server's own Worker would fix was not handed to the deployer");
  });

  it("knows a Worker of an older protocol by its document when the status path is not there (a 404), and hands its build over", async (t) => {
    logs(t);
    const hook = recorder();
    const h = await harness({}, { deploy: hook });
    h.page.document = `<!doctype html>${viewerBuildTag(OLD_BUILD)}`;
    h.page.respond = (req) => (req.path.startsWith("/_publish/") ? { status: 404 } : h.page.worker(req));
    await h.pub.start();
    await h.pub.runCycle();
    assert.equal(h.pub.status().lastError?.kind, "protocol", JSON.stringify(h.pub.status().lastError));
    assert.deepEqual(hook.calls, [OLD_BUILD]);
    const asked = h.page.requests.find((r) => r.path === "/servicecue");
    assert.ok(asked, "the page's document was not read");
    assert.equal(asked.headers.authorization, undefined, "the publishing token went with a request for a public document");
  });

  it("starts again once the page is deployed from this server, and waits out the old Worker for a while first", async (t) => {
    logs(t);
    const hook = recorder();
    const h = await harness({ deploySettleMs: 60_000 }, { deploy: hook });
    h.page.respond = protocol2;
    await h.pub.start();
    await h.pub.runCycle();
    assert.equal(h.pub.status().state, "problem");
    // The deploy went through, and for a moment the old Worker still answers: retried on the backoff, not held.
    hook.deployed();
    await sleep(20);
    await h.pub.runCycle();
    await waitFor(() => hook.calls.length >= 3, "the old Worker asked again after the deploy", 3000);
    assert.equal(h.pub.status().lastError?.kind, "protocol");
    // The new Worker takes over.
    h.page.respond = (req) => h.page.worker(req);
    await waitFor(() => h.pub.status().state === "publishing" && h.page.puts().length > 0, "publishing to the new Worker", 3000);
  });

  it("stays held by another protocol when nothing was deployed", async (t) => {
    logs(t);
    const hook = recorder();
    const h = await harness({}, { deploy: hook });
    h.page.respond = protocol2;
    await h.pub.start();
    await h.pub.runCycle();
    await sleep(200);
    assert.equal(hook.calls.length, 1, "a held page was asked again with nothing changed");
  });
});
