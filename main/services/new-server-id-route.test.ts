// New server id: the operator's way out when another server answers with this id.
//
// A box that already carries another server's id (a restore made before the
// question existed, or the box ticked by mistake) has no other fix: a restore
// keeps the id it has, and that id is the copy. The action is offered only while
// a duplicate is heard, and the server holds it to that too, so nobody orphans
// this server's screens through the API on a whim.
//
// Driven through the real request handler and the settings file on disk.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-new-server-id-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("./remote-server.js");
const { stageController } = await import("./stage-controller.js");
const { settingsStore } = await import("./settings-store.js");

const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";
let server: SocketServer;
const realLog = console.log;
const logged: string[] = [];

before(async () => {
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  server = await serveOnSocket(new RemoteServer().handle);
});

after(async () => {
  await server.close();
  console.log = realLog;
  await fs.rm(TMP, { recursive: true, force: true });
});

async function onDisk(): Promise<unknown> {
  return (JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as { serverId?: unknown }).serverId;
}

function heard(addresses: string[]) {
  stageController.setServerId(OWN);
  stageController.setDuplicateCheck({
    check: { state: "ok", at: 1 },
    duplicates: addresses.map((address) => ({ address, since: 1 })),
  });
}

beforeEach(async () => {
  await settingsStore.patch({ serverId: OWN });
});

const post = () => server.send("POST", "/api/server-id/new", { headers: { "Content-Type": "application/json" }, body: "{}" });

describe("POST /api/server-id/new", () => {
  test("IS REFUSED WHILE NO OTHER SERVER ANSWERS WITH THIS ID, and changes nothing", async () => {
    heard([]);
    const r = await post();
    assert.equal(r.status, 409);
    assert.equal(await onDisk(), OWN, "the id changed with no duplicate heard: every screen bound here is orphaned");
    assert.equal(stageController.getState().serverIdentity.id, OWN);
  });

  test("while one does, gives this server a new id, on disk and in the state, and logs both", async () => {
    heard(["192.0.2.60"]);
    const r = await post();
    assert.equal(r.status, 200);
    const next = await onDisk();
    assert.equal(typeof next, "string");
    assert.notEqual(next, OWN);
    const identity = stageController.getState().serverIdentity;
    assert.equal(identity.id, next);
    assert.deepEqual(identity.duplicates, [], "the duplicate of the OLD id outlived the change");
    assert.ok(logged.some((l) => l.includes(`[stage-controller] newServerId: ${OWN} → ${String(next)}`)));
  });
});
