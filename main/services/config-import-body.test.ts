// POST /api/config/import with a body that is not an object.
//
// The route accepts the bundle itself or {bundle}, and told them apart with
// `"bundle" in body`, which throws on a JSON null or a string: the answer was a
// 500, as if the server had failed, for a request that was simply wrong. It is a
// 400 now, saying what the route takes, and nothing is restored.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-import-body-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("./remote-server.js");
const { configSnapshot } = await import("./config-snapshot.js");

let server: SocketServer;
const realApply = configSnapshot.apply;
const realWarn = console.warn;
let reached = 0;

before(async () => {
  console.warn = () => {};
  (configSnapshot as unknown as Record<string, unknown>).apply = async () => {
    reached += 1;
    throw new Error("stubbed: nothing is restored");
  };
  server = await serveOnSocket(new RemoteServer().handle);
});

after(async () => {
  (configSnapshot as unknown as Record<string, unknown>).apply = realApply;
  await server.close();
  console.warn = realWarn;
  await fs.rm(TMP, { recursive: true, force: true });
});

for (const body of ["null", '"a string"', "42", "true"]) {
  test(`a body of ${body} is a 400, and restores nothing`, async () => {
    reached = 0;
    const r = await server.send("POST", "/api/config/import", { headers: { "Content-Type": "application/json" }, body });
    assert.equal(r.status, 400, `answered ${r.status}`);
    assert.match(r.body, /config snapshot/);
    assert.equal(reached, 0);
  });
}
