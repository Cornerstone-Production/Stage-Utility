// What the restore routes tell apply() about the server id.
//
// A restore takes the config's server id only when the operator said this box
// replaces the server the config was saved on. The routes are where that answer
// arrives, so they are where a wrong read would undo the whole rule: a flag read
// from the bundle would let a config file authorise itself, and a truthy check
// would take "false" or "no" as yes.
//
// Driven through the real request handler. apply() and recall() are stubbed to
// record what they were given and refuse, so nothing is written and nothing
// restarts.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restore-id-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("./remote-server.js");
const { configSnapshot } = await import("./config-snapshot.js");

let server: SocketServer;
const realApply = configSnapshot.apply;
const realRecall = configSnapshot.recall;
const realWarn = console.warn;
/** The options each call reached apply() or recall() with, in order. */
let seen: unknown[] = [];

before(async () => {
  console.warn = () => {};
  const record = async (_what: unknown, opts?: unknown) => {
    seen.push(opts);
    throw new Error("stubbed: nothing is restored");
  };
  (configSnapshot as unknown as Record<string, unknown>).apply = record;
  (configSnapshot as unknown as Record<string, unknown>).recall = record;
  server = await serveOnSocket(new RemoteServer().handle);
});

beforeEach(() => {
  seen = [];
});

after(async () => {
  (configSnapshot as unknown as Record<string, unknown>).apply = realApply;
  (configSnapshot as unknown as Record<string, unknown>).recall = realRecall;
  await server.close();
  console.warn = realWarn;
  await fs.rm(TMP, { recursive: true, force: true });
});

const BUNDLE = { kind: "stage-utility-config", version: 1, files: {} };
const post = (pathname: string, body?: unknown) =>
  server.send("POST", pathname, {
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Whether the one call recorded was told this box replaces the original. */
function replaced(): boolean {
  assert.equal(seen.length, 1, "the route did not reach the restore exactly once");
  return (seen[0] as { replacesOriginal?: unknown } | undefined)?.replacesOriginal === true;
}

describe("POST /api/config/import", () => {
  test("{bundle, replacesOriginal: true} replaces the original", async () => {
    await post("/api/config/import", { bundle: BUNDLE, replacesOriginal: true });
    assert.equal(replaced(), true);
  });

  test("{bundle} alone keeps this server's id", async () => {
    await post("/api/config/import", { bundle: BUNDLE });
    assert.equal(replaced(), false);
  });

  for (const flag of ["true", 1, "yes", {}]) {
    test(`replacesOriginal: ${JSON.stringify(flag)} is not a yes`, async () => {
      await post("/api/config/import", { bundle: BUNDLE, replacesOriginal: flag });
      assert.equal(replaced(), false);
    });
  }

  test("A BARE BUNDLE CANNOT AUTHORISE ITSELF by carrying the flag", async () => {
    // The route also accepts the bundle itself as the body. A config file that
    // says replacesOriginal: true is still a config file, not the operator.
    await post("/api/config/import", { ...BUNDLE, replacesOriginal: true });
    assert.equal(replaced(), false, "a config file chose to take its own server id");
  });
});

describe("POST /api/config/snapshots/:id/recall", () => {
  test("with no body, keeps this server's id", async () => {
    await post("/api/config/snapshots/abc/recall");
    assert.equal(replaced(), false);
  });

  test("with {replacesOriginal: true}, replaces the original", async () => {
    await post("/api/config/snapshots/abc/recall", { replacesOriginal: true });
    assert.equal(replaced(), true);
  });

  test("with {replacesOriginal: \"true\"}, keeps this server's id", async () => {
    await post("/api/config/snapshots/abc/recall", { replacesOriginal: "true" });
    assert.equal(replaced(), false);
  });
});
