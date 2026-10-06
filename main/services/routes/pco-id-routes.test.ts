// A service type or plan id from a request is spliced into a Planning Center URL
// path, and that URL carries the operator's App ID and secret. An id of `1/plans`,
// `1?x=`, `1%2F2` or `..` is a request for some other endpoint made with them.
//
// Driven through the real routes, the real controller and the real pcoService, with
// only `fetch` replaced, because what is under test is whether anything leaves the
// process and what the caller is told. Each route below takes the id straight from
// its query string.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pco-id-routes-"));
process.env.STAGE_UTILITY_DATA = DIR;

const { stateRoutes } = await import("./state-routes.js");
const { serviceCueRoutes } = await import("./servicecue-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");
const { captureConsole } = await import("../fixtures/capture-console.js");

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const ctl = stageController as unknown as { pcoAppId: string | null; pcoSecret: string | null };

const realFetch = globalThis.fetch;
let sent: string[] = [];

beforeEach(() => {
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  sent = [];
  globalThis.fetch = (async (url: string) => {
    sent.push(String(url));
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

const BAD_IDS = ["1/plans", "1?x=", "1%2F2", "..", "1#", ""];

const ROUTES: { name: string; route: Parameters<typeof callRoute>[0]; path: (id: string) => string; param: string }[] = [
  { name: "plans", route: stateRoutes, path: (id) => `/api/plans?serviceTypeId=${id}`, param: "serviceTypeId" },
  { name: "note categories", route: serviceCueRoutes, path: (id) => `/api/servicecue/note-categories?serviceTypeId=${id}`, param: "serviceTypeId" },
  { name: "rundown", route: serviceCueRoutes, path: (id) => `/api/servicecue/rundown?serviceTypeId=${id}`, param: "serviceTypeId" },
];

describe("an id that is not a Planning Center id", () => {
  for (const r of ROUTES) {
    test(`${r.name}: is a 400 naming the parameter, and nothing is fetched`, async (t) => {
      const lines = captureConsole(t, "warn", "error");
      for (const bad of BAD_IDS.filter((b) => b !== "")) {
        const out = await callRoute(r.route, r.path(encodeURIComponent(bad)));
        assert.equal(out.status, 400, `${r.name} with ${JSON.stringify(bad)}`);
        assert.match(String((out.json as { error?: string }).error), new RegExp(`${r.param} is not a Planning Center id`));
      }
      assert.deepEqual(sent, [], "a request left for Planning Center");
      assert.ok(lines.some((l) => l.includes("[pco]") && l.includes("refused")), "the refusal left no [pco] line");
    });
  }

  test("a numeric id still goes through, to the path it was built for", async () => {
    const out = await callRoute(stateRoutes, "/api/plans?serviceTypeId=123");
    assert.equal(out.status, 200);
    assert.ok(sent.length > 0);
    assert.ok(sent.every((u) => new URL(u).pathname.startsWith("/services/v2/service_types/123/plans")), sent.join("\n"));
  });
});
