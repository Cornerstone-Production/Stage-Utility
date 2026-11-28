// Planning Center being unreachable is not "this service type has no note categories".
//
// noteCategoryNames swallowed a failed request into an empty list answered with a 200, so
// Home said All clear and the layouts page said nothing, with no [pco] line. It now throws,
// and the route answers its existing 502 and says so on a tagged line. The failure is held
// for a short while, as a failure and never as an empty list, so pages polling through a
// 429 episode do not keep it going. Driven through the real route, controller and
// pcoService; only the network is stubbed.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { tempDataDir } from "../fixtures/temp-data-dir.js";

tempDataDir("stage-note-cats-", { home: true });

const { serviceCueRoutes } = await import("./servicecue-routes.js");
const { stageController } = await import("../stage-controller.js");
const { pcoService } = await import("../pco-service.js");
const { callRoute } = await import("./route-harness.js");
const { captureConsole } = await import("../fixtures/capture-console.js");

type Mutable = { pcoAppId: string | null; pcoSecret: string | null };
const ctl = stageController as unknown as Mutable;
const realFetch = globalThis.fetch;
let status = 200;
let asked = 0;

beforeEach(() => {
  pcoService.clearCache();
  pcoService.resetRateLimit();
  status = 200;
  asked = 0;
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.planningcenteronline.com")) return realFetch(input as string, init);
    asked++;
    if (status !== 200) return new Response(JSON.stringify({ errors: [{ title: "no" }] }), { status, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ data: [{ id: "1", type: "ItemNoteCategory", attributes: { name: "Audio", sequence: 0 } }], included: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("GET /api/servicecue/note-categories", () => {
  it("answers 502 and logs [pco] when Planning Center cannot be read, never 200 with an empty list", async (t) => {
    status = 401;
    const lines = captureConsole(t, "warn", "log");
    const res = await callRoute(serviceCueRoutes, "/api/servicecue/note-categories?serviceTypeId=100", { method: "GET" });
    assert.equal(res.status, 502, JSON.stringify(res.json));
    assert.match(lines.join("\n"), /\[pco\] note categories read failed/);
  });

  it("holds the failure briefly, as a failure: a read inside the hold is still 502 and asks nobody", async (t) => {
    status = 401;
    captureConsole(t, "warn", "log");
    await callRoute(serviceCueRoutes, "/api/servicecue/note-categories?serviceTypeId=100", { method: "GET" });
    status = 200;
    const res = await callRoute(serviceCueRoutes, "/api/servicecue/note-categories?serviceTypeId=100", { method: "GET" });
    assert.equal(res.status, 502, "the failure was not held: a page polling through a 429 episode asks again every time");
    assert.equal(asked, 1, "Planning Center was asked again inside the hold");
  });

  it("does not remember the failure past the hold: the next read, once Planning Center answers, has the categories", async (t) => {
    status = 401;
    captureConsole(t, "warn", "log");
    const realNow = Date.now;
    const start = realNow();
    try {
      Date.now = () => start;
      await callRoute(serviceCueRoutes, "/api/servicecue/note-categories?serviceTypeId=100", { method: "GET" });
      status = 200;
      Date.now = () => start + 31_000;
      const res = await callRoute(serviceCueRoutes, "/api/servicecue/note-categories?serviceTypeId=100", { method: "GET" });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, ["Audio"]);
      assert.equal(asked, 2, "the failed answer was cached as data");
    } finally {
      Date.now = realNow;
    }
  });
});
