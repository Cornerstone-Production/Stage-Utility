// GET /api/team-positions, driven through the real handler and the real
// controller, with Planning Center replaced at the one seam below it: the
// `pcoService` singleton's two reads.
//
// The slot editor edits ONE service type's board, which is not always the live
// type. The route used to take no type at all, so editing another type's board
// listed the live type's positions and a saved position missing from that list
// had no row to untick.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "team-positions-route-"));
process.env.STAGE_UTILITY_DATA = DIR;

const { stateRoutes } = await import("./state-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");
const { pcoService } = await import("../pco-service.js");

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const ctl = stageController as unknown as {
  pcoAppId: string | null;
  pcoSecret: string | null;
  state: Record<string, unknown>;
};
const pco = pcoService as unknown as {
  listServiceTypes: (a: string, s: string) => Promise<ServiceTypeDTO[]>;
  listTeamPositions: (a: string, s: string, serviceTypeId: string) => Promise<TeamPositionDTO[]>;
};

const TYPES: ServiceTypeDTO[] = [
  { id: "st-sun", name: "Sunday" },
  { id: "st-wed", name: "Wednesday" },
  { id: "st-kick", name: "Kickoff" },
];
const POSITIONS: Record<string, TeamPositionDTO[]> = {
  "st-sun": [{ teamId: "t1", teamName: "Band", positionName: "Drums" }],
  "st-wed": [{ teamId: "t2", teamName: "Vocals", positionName: "Host" }],
  "st-kick": [{ teamId: "t3", teamName: "Tech", positionName: "Click" }],
};

let asked: string[] = [];
let failing = new Set<string>();
let warned: string[] = [];

const realTypes = pco.listServiceTypes;
const realPositions = pco.listTeamPositions;
const realWarn = console.warn;

beforeEach(() => {
  asked = [];
  failing = new Set();
  warned = [];
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  ctl.state = { ...ctl.state, serviceTypeId: "st-sun" };
  pco.listServiceTypes = async () => TYPES;
  pco.listTeamPositions = async (_a, _s, id) => {
    asked.push(id);
    if (failing.has(id)) throw new Error("Planning Center returned 503");
    return POSITIONS[id] ?? [];
  };
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(" "));
  };
});

after(() => {
  pco.listServiceTypes = realTypes;
  pco.listTeamPositions = realPositions;
  console.warn = realWarn;
});

describe("GET /api/team-positions", () => {
  test("with no parameter it answers for the live service type", async () => {
    const out = await callRoute(stateRoutes, "/api/team-positions");
    assert.equal(out.status, 200);
    assert.deepEqual(asked, ["st-sun"]);
    assert.deepEqual(out.json, POSITIONS["st-sun"]);
  });

  test("?serviceTypeId= answers for THAT type, not the live one", async () => {
    const out = await callRoute(stateRoutes, "/api/team-positions?serviceTypeId=st-wed");
    assert.equal(out.status, 200);
    assert.deepEqual(asked, ["st-wed"]);
    assert.deepEqual(out.json, POSITIONS["st-wed"]);
  });

  test("an id that is not shaped like one is a 400 and reaches Planning Center nowhere", async () => {
    for (const bad of ["", "../plans", "a b", "x".repeat(65), "st/1"]) {
      const out = await callRoute(stateRoutes, `/api/team-positions?serviceTypeId=${encodeURIComponent(bad)}`);
      assert.equal(out.status, 400, `serviceTypeId=${JSON.stringify(bad)}`);
    }
    assert.deepEqual(asked, []);
  });

  test("?all=1 returns every type's positions, each tagged with its type", async () => {
    const out = await callRoute(stateRoutes, "/api/team-positions?all=1");
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, {
      positions: [
        { serviceTypeId: "st-sun", serviceTypeName: "Sunday", teamId: "t1", teamName: "Band", positionName: "Drums" },
        { serviceTypeId: "st-wed", serviceTypeName: "Wednesday", teamId: "t2", teamName: "Vocals", positionName: "Host" },
        { serviceTypeId: "st-kick", serviceTypeName: "Kickoff", teamId: "t3", teamName: "Tech", positionName: "Click" },
      ],
      failed: [],
    });
    assert.deepEqual(asked, ["st-sun", "st-wed", "st-kick"], "read one type at a time, in order");
  });

  test("?all=1 with one type failing reports it, keeps the rest, and logs one [pco] line", async () => {
    failing.add("st-wed");
    failing.add("st-kick");
    const out = await callRoute(stateRoutes, "/api/team-positions?all=1");
    assert.equal(out.status, 200);
    const body = out.json as { positions: { serviceTypeName: string }[]; failed: string[] };
    assert.deepEqual(body.failed, ["Wednesday", "Kickoff"]);
    assert.deepEqual(body.positions.map((p) => p.serviceTypeName), ["Sunday"]);
    const lines = warned.filter((l) => l.includes("[pco]"));
    assert.equal(lines.length, 1, `two failing types are one line per call: ${warned.join(" | ")}`);
    assert.match(lines[0], /2 of 3/);
  });
});
