// The expired-link fix is a flag threaded through three files: the cache asks
// for a FRESH link after a 403, the route hands that request to the controller,
// the controller hands it to pco-service, and pco-service skips its signed-URL
// cache for it. Review deleted the route's half of the threading and the whole
// suite stayed green — the cache test stubs openUrl out, so nothing was watching
// whether "fresh" ever reached the code that gives it meaning.
//
// This drives the real route with a stubbed controller and a stubbed fetch, so
// the request the route actually makes of the controller is what is asserted.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, mock, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pco-attachment-link-"));
process.env.STAGE_UTILITY_DATA = DIR;

const { proxyRoutes } = await import("./proxy-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const realFetch = globalThis.fetch;

describe("/api/pco/attachment on a link Planning Center has already expired", () => {
  test("asks the controller for a fresh link, and only after the cached one is rejected", async (t) => {
    const opened: (unknown | undefined)[] = [];
    mock.method(stageController, "findPlanAttachment", async () => ({
      id: "att-1", filename: "Stage Plot.pdf", contentType: "application/pdf", sourceLabel: null,
    }));
    mock.method(stageController, "openPlanAttachment", async (_id: string, opts?: unknown) => {
      opened.push(opts);
      return { url: opened.length === 1 ? "https://s3.invalid/stale" : "https://s3.invalid/fresh", contentType: "application/pdf" };
    });
    const payload = Buffer.from("%PDF-1.4 fresh bytes");
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/stale")
        ? new Response("expired", { status: 403 })
        : new Response(payload, { status: 200 })) as typeof fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
      mock.restoreAll();
    });

    const r = await callRoute(proxyRoutes, "/api/pco/attachment?match=stage%20plot");

    assert.equal(r.status, 200, `the route gave up on the expired link: ${r.status} ${r.body}`);
    assert.equal(r.body, payload.toString(), "the bytes served are not the fresh download");
    assert.deepEqual(
      opened,
      [undefined, { fresh: true }],
      "the second open must ask for a FRESH link — anything else re-reads the cached, expired one",
    );
  });
});
