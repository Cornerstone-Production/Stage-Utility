// The public page follows an edit to what ServiceCue shows: each route that saves the
// landing page, the layouts or the roles tells the publisher, and one that saved nothing does not.
//
// The four saves are replaced by stubs that answer as the real ones do, so no Planning Center
// is needed; what is held is the route's own line, which is the whole of the connection.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-servicecue-nudge-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { serviceCueRoutes } = await import("./servicecue-routes.js");
const { servicecuePublisher } = await import("../servicecue-publisher-instance.js");
const { stageController } = await import("../stage-controller.js");
const { callRoute } = await import("./route-harness.js");

after(() => fs.rm(TMP, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

/** [path, a body that saves, a body the route refuses, the controller save it calls] */
const SAVES: [string, unknown, unknown, "saveServiceCueLayouts" | "setServiceCueConfig" | "saveServiceCueRoles" | "seedServiceCueRoles"][] = [
  ["/api/servicecue/config", { serviceTypeIds: ["100"] }, { serviceTypeIds: "100" }, "setServiceCueConfig"],
  ["/api/servicecue/layouts", { layouts: [] }, { layouts: "none" }, "saveServiceCueLayouts"],
  ["/api/servicecue/roles", { roles: [] }, { roles: "none" }, "saveServiceCueRoles"],
  ["/api/servicecue/roles/seed", { serviceTypeId: "100" }, {}, "seedServiceCueRoles"],
];

describe("an edit to what the public page shows", () => {
  for (const [route, body, refused, save] of SAVES) {
    it(`${route} tells the publisher once it has saved, and not when it refuses`, async () => {
      const nudge = mock.method(servicecuePublisher, "nudge", () => undefined);
      mock.method(stageController, save, async () => []);

      const bad = await callRoute(serviceCueRoutes, route, { method: "POST", body: refused });
      assert.equal(bad.status, 400);
      assert.equal(nudge.mock.callCount(), 0, "a request that saved nothing woke the publisher");

      const good = await callRoute(serviceCueRoutes, route, { method: "POST", body });
      assert.equal(good.status, 200, JSON.stringify(good.json));
      assert.equal(nudge.mock.callCount(), 1);
    });
  }
});
