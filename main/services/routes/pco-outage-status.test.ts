// A Planning Center outage must not read as this app being broken.
//
// Every route here is a GET whose only remote dependency is PCO. With no `try`
// the rejection reached the dispatcher's generic arm in remote-server.ts, which
// answers 500 by design — a status is opt-in there so a stray `status` field
// cannot turn a real fault into something the caller shrugs off. The result was
// a settings picker and a checklist reporting a server fault for an upstream
// being down, which sends an operator looking in the wrong place on a Sunday.
//
// The calendar routes, added the same release, already answer 502 with the
// argument written out ("a 400 would blame the caller for the upstream being
// down") — the same argument applies to a 500 in the other direction.
//
// DRIVEN THROUGH THE ROUTE with the controller method made to reject, because
// what is under test is the route's error arm, not the controller.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pco-outage-"));
process.env.STAGE_UTILITY_DATA = DIR;

const { historyRoutes } = await import("./history-routes.js");
const { stateRoutes } = await import("./state-routes.js");
const { scriptviewRoutes } = await import("./scriptview-routes.js");
const { calendarRoutes } = await import("./calendar-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const OUTAGE = "Planning Center returned 503";

/** Every GET route whose failure can only be PCO, and the method it goes through. */
const PCO_READS: { path: string; route: Parameters<typeof callRoute>[0]; method: string }[] = [
  { path: "/api/pco/attachments", route: historyRoutes, method: "listPlanAttachments" },
  { path: "/api/pco/plan-items", route: historyRoutes, method: "listCurrentPlanItems" },
  { path: "/api/pco/checklist", route: historyRoutes, method: "listPlanChecklist" },
  { path: "/api/pco/checklist-sources", route: historyRoutes, method: "listChecklistSources" },
  { path: "/api/service-types", route: stateRoutes, method: "listServiceTypes" },
  { path: "/api/team-positions", route: stateRoutes, method: "listTeamPositions" },
  { path: "/api/plans?serviceTypeId=st-1", route: stateRoutes, method: "listPlans" },
  {
    path: "/api/scriptview/note-categories?serviceTypeId=st-1",
    route: scriptviewRoutes,
    method: "listScriptViewNoteCategories",
  },
  {
    path: "/api/scriptview/rundown?serviceTypeId=st-1",
    route: scriptviewRoutes,
    method: "getScriptViewRundown",
  },
  { path: "/api/pco/calendar?viewId=view-1", route: calendarRoutes, method: "getCalendarGrid" },
  { path: "/api/pco/calendar-sources", route: calendarRoutes, method: "listCalendarSources" },
];

describe("a PCO read that fails answers 502, not 500", () => {
  test("the list is the complete set of PCO-only GET routes", () => {
    // EXACT, not a floor. This started as two routes with no try at all and
    // seven more with the same shape one file over; a floor is how the next one
    // added goes uncovered.
    assert.equal(PCO_READS.length, 11);
    assert.equal(new Set(PCO_READS.map((r) => r.path)).size, 11, "a path is listed twice");
  });

  for (const { path: routePath, route, method } of PCO_READS) {
    test(`${routePath} answers 502 when PCO is down`, async () => {
      const controller = stageController as unknown as Record<string, unknown>;
      const original = controller[method];
      assert.equal(typeof original, "function", `stageController.${method} is not a method any more`);
      controller[method] = () => Promise.reject(new Error(OUTAGE));
      try {
        const out = await callRoute(route, routePath);
        assert.equal(
          out.status,
          502,
          `${routePath} answered ${out.status} for an upstream outage — a 500 blames this app`,
        );
        assert.deepEqual(out.json, { error: OUTAGE }, "the upstream's reason did not reach the caller");
      } finally {
        controller[method] = original;
      }
    });
  }
});
