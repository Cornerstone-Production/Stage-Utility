// The app name's one length rule, through the route both Branding and the
// sidebar's name field save with, and through a config restore.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "app-name-"));
process.env.STAGE_UTILITY_DATA = DATA;

const { brandingRoutes } = await import("./routes/branding-routes.js");
const { callRoute } = await import("./routes/route-harness.js");
const { stageController } = await import("./stage-controller.js");
const { settingsRestoreCheck } = await import("./settings-restore-check.js");
const { MAX_APP_NAME } = await import("./app-name.js");

after(() => fs.rmSync(DATA, { recursive: true, force: true }));

const post = (name: string) => callRoute(brandingRoutes, "/api/branding", { method: "POST", body: { name } });

test("a name at the limit saves, and one past it is refused and changes nothing", async () => {
  const fits = "N".repeat(MAX_APP_NAME);
  assert.equal((await post(fits)).status, 200);
  assert.equal(stageController.getState().appName, fits);
  const res = await post("N".repeat(MAX_APP_NAME + 1));
  assert.equal(res.status, 400);
  assert.match(res.body, /longer than 80 characters/);
  assert.equal(stageController.getState().appName, fits);
});

test("a restore keeps a longer name from a backup taken before the limit", async () => {
  const long = "N".repeat(MAX_APP_NAME + 1);
  const result = await settingsRestoreCheck({ appName: long });
  assert.ok(result.ok, "a backup with a long app name was refused whole");
  assert.equal((result.value as { appName?: string }).appName, long);
});
