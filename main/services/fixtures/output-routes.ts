// output-routes.ts — the setup the PATCH /api/outputs/:id route tests share:
// a temp data dir, the real route module and stageController, and one display
// ("wall", showing view "v1") seeded fresh before every test.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach } from "node:test";

type Mutable = { state: { views: View[]; outputs: Output[]; [k: string]: unknown }; broadcast: () => void };

/**
 * Points STAGE_UTILITY_DATA and HOME at a fresh temp dir, THEN imports the
 * route module and stageController — the order is the point, since both read
 * the data dir when they load. Call it at the top of the test file, before
 * anything else imports either. Registers the file's seeding beforeEach.
 */
export async function outputRouteHarness(tmpPrefix: string) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), tmpPrefix));
  process.env.STAGE_UTILITY_DATA = tmp;
  process.env.HOME = path.join(tmp, "home");

  const { viewRoutes } = await import("../routes/view-routes.js");
  const { callRoute } = await import("../routes/route-harness.js");
  const { stageController } = await import("../stage-controller.js");

  const ctl = stageController as unknown as Mutable;
  ctl.broadcast = () => {};

  beforeEach(() => {
    ctl.state = {
      ...ctl.state,
      views: [{ id: "v1", name: "Mic board", kind: "slots", createdAt: "" }] as View[],
      outputs: [{ id: "wall", name: "Stage wall", viewId: "v1" }] as Output[],
    };
    (stageController as unknown as { recomputeResolved: () => void }).recomputeResolved();
  });

  return { viewRoutes, callRoute, stageController };
}
