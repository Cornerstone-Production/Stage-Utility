// POST /api/views/import answers an over-cap body 413, not 400.
//
// The route wraps its work in a catch that answered every failure 400 with the
// failure's message, which included BodyTooLargeError. Declared size is refused
// before any byte is read, so nothing else needs setting up.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "view-import-limit-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { viewRoutes } = await import("./view-routes.js");
const { callRoute } = await import("./route-harness.js");
const { BodyTooLargeError, MAX_CONFIG_BODY_BYTES } = await import("./context.js");
const { handlerErrorStatus } = await import("../remote-server.js");

after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
});

test("a view import over the config cap is a 413", async () => {
  await assert.rejects(
    callRoute(viewRoutes, "/api/views/import", {
      method: "POST",
      headers: { "content-length": String(MAX_CONFIG_BODY_BYTES + 1) },
    }),
    (err: unknown) => err instanceof BodyTooLargeError && handlerErrorStatus(err) === 413,
  );
});
