// Every route that reads fields off its JSON body refuses a body that is JSON but not
// an object. They cast `await readBody(req)` to a record, so `null` threw a TypeError on
// the first field read (a 500), and an array or a string slipped past every check that
// only asks for optional fields (POST /api/update/auto with `[]` saved nothing and
// answered 200). Each now reads through readJsonObject, which throws BadJsonBodyError,
// and the dispatcher answers 400 "the body must be a JSON object".
//
// One row per route changed, sorted, so a route added to a module without the reader
// is a line to add here. The routes left on readBody take any JSON on purpose and are
// not listed: POST /api/config/import checks the shape itself and says what it
// expected, and /api/devices/health hands the body to parseHealthReport, which
// refuses anything else.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "object-body-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { callRoute } = await import("./route-harness.js");
const { handlerErrorStatus } = await import("../remote-server.js");
const { systemRoutes } = await import("./system-routes.js");
const { kioskDeviceRoutes } = await import("./kiosk-device-routes.js");
const { serviceCuePublishRoutes } = await import("./servicecue-publish-routes.js");
const { videoRoutes } = await import("./video-routes.js");
const { displaySettingsRoutes } = await import("./display-settings-routes.js");
type RouteCtx = import("./context.js").RouteCtx;

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

type Route = (c: RouteCtx) => Promise<void>;
const ROUTES: [string, string, Route][] = [
  ["PATCH", "/api/video/feeds/no-such-feed", videoRoutes],
  ["PATCH", "/api/video/ffmpeg", videoRoutes],
  ["PATCH", "/api/video/ports", videoRoutes],
  ["POST", "/api/backup/schedule", systemRoutes],
  ["POST", "/api/checklist-sources", systemRoutes],
  ["POST", "/api/config/snapshots", systemRoutes],
  ["POST", "/api/devices/claim", kioskDeviceRoutes],
  ["POST", "/api/devices/release", kioskDeviceRoutes],
  ["POST", "/api/devices/scan", kioskDeviceRoutes],
  ["POST", "/api/hour-cycle", systemRoutes],
  ["POST", "/api/machine-updates/request", kioskDeviceRoutes],
  ["POST", "/api/reconnect-schedule", systemRoutes],
  ["POST", "/api/servicecue/publish", serviceCuePublishRoutes],
  ["POST", "/api/servicecue/publish/deploy", serviceCuePublishRoutes],
  ["POST", "/api/servicecue/publish/deploy-credentials", serviceCuePublishRoutes],
  ["POST", "/api/servicecue/publish/test", serviceCuePublishRoutes],
  ["POST", "/api/sidebar", displaySettingsRoutes],
  ["POST", "/api/taper-window", systemRoutes],
  ["POST", "/api/timezone", systemRoutes],
  ["POST", "/api/update/auto", systemRoutes],
  ["POST", "/api/update/track", systemRoutes],
  ["POST", "/api/video/feeds", videoRoutes],
  ["POST", "/api/video/import", videoRoutes],
  ["POST", "/api/video/import/preview", videoRoutes],
];

/** What a client gets: the route's own answer, or what the dispatcher makes of its throw. */
async function answer(route: Route, method: string, url: string, body: unknown): Promise<{ status: number | null; error: string }> {
  try {
    const r = await callRoute(route, url, { method, body });
    return { status: r.status, error: String((r.json as { error?: unknown } | null)?.error ?? r.body) };
  } catch (err) {
    return { status: handlerErrorStatus(err), error: (err as Error).message };
  }
}

for (const [kind, body] of [["null", null], ["an array", []], ["a string", "x"]] as const) {
  describe(`a JSON body that is ${kind}`, () => {
    for (const [method, url, route] of ROUTES) {
      test(`${method} ${url} answers 400`, async () => {
        assert.deepEqual(await answer(route, method, url, body), { status: 400, error: "the body must be a JSON object" });
      });
    }
  });
}
