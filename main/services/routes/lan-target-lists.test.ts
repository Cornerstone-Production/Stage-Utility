// The LAN output target lists (RossTalk targets, OSC targets, wireless
// connections) refuse the same bad edits and the same unknown id, through the
// same route-to-status path the server uses. Before they shared one validated
// path, the RossTalk PATCH stored whatever arrived, and a RossTalk delete of an
// id that was not there answered success.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lan-targets-"));

const { rosstalkRoutes } = await import("./rosstalk-routes.js");
const { integrationRoutes } = await import("./integration-routes.js");
const { callRoute } = await import("./route-harness.js");
const { handlerErrorStatus } = await import("../remote-server.js");
const { rosstalkManager } = await import("../rosstalk-manager.js");
const { oscManager } = await import("../osc-manager.js");
const { wirelessManager } = await import("../wireless-manager.js");

after(() => {
  oscManager.stop();
  rosstalkManager.stopAll();
});

type Route = (c: import("./context.js").RouteCtx) => Promise<void>;

interface Kind {
  name: string;
  route: Route;
  base: string;
  /** Adds one and returns its id. */
  add: () => Promise<string>;
  /** What the list holds for that id. */
  read: (id: string) => { name: string; enabled: boolean; config: unknown } | undefined;
  /** A config the kind refuses (a wrong type, or a field it does not have); null when it takes any object. */
  badConfigs: unknown[] | null;
  /** Whether a PATCH body names the fields itself or wraps them in {patch}. */
  wrap: (patch: unknown) => unknown;
}

const KINDS: Kind[] = [
  {
    name: "rosstalk",
    route: rosstalkRoutes,
    base: "/api/rosstalk/targets",
    add: async () => (await rosstalkManager.addTarget({})).at(-1)!.id,
    read: (id) => rosstalkManager.listTargets().find((t) => t.id === id),
    badConfigs: [{ host: 5 }, { port: "x" }, { port: 70000 }, { port: 1.5 }, { family: "bogus" }, { nope: 1 }],
    wrap: (p) => p,
  },
  {
    name: "osc",
    route: integrationRoutes,
    base: "/api/osc/targets",
    add: async () => (await oscManager.addTarget({})).at(-1)!.id,
    read: (id) => oscManager.listTargets().find((t) => t.id === id),
    badConfigs: [{ host: 5 }, { port: "x" }, { port: 0 }, { subscribeIntervalSec: "x" }, { subscribeIntervalSec: -1 }, { nope: 1 }],
    wrap: (p) => ({ patch: p }),
  },
  {
    name: "wireless",
    route: integrationRoutes,
    base: "/api/wireless/connections",
    add: async () => (await wirelessManager.addConnection({})).at(-1)!.id,
    read: (id) => wirelessManager.listConnections().find((t) => t.id === id),
    // Deliberate: a connection's config is its provider's, and its secrets are folded by the manager.
    badConfigs: null,
    wrap: (p) => ({ patch: p }),
  },
];

/** The status the server would answer for what the route did. */
async function statusOf(k: Kind, p: string, method: string, body?: unknown): Promise<number> {
  try {
    const out = await callRoute(k.route, p, { method, body });
    return out.status ?? -1;
  } catch (err) {
    return handlerErrorStatus(err);
  }
}

for (const k of KINDS) {
  test(`${k.name}: a blank, numeric or non-string name is refused with 400 and nothing is stored`, async () => {
    const id = await k.add();
    const before = JSON.stringify(k.read(id));
    for (const name of ["", "   ", 5, null, ["x"], { a: 1 }]) {
      assert.equal(await statusOf(k, `${k.base}/${id}`, "PATCH", k.wrap({ name })), 400, `name ${JSON.stringify(name)}`);
    }
    assert.equal(JSON.stringify(k.read(id)), before);
  });

  test(`${k.name}: a config that is not an object is refused with 400 and nothing is stored`, async () => {
    const id = await k.add();
    const before = JSON.stringify(k.read(id));
    for (const config of ["x", 5, null, ["a"]]) {
      assert.equal(await statusOf(k, `${k.base}/${id}`, "PATCH", k.wrap({ config })), 400, `config ${JSON.stringify(config)}`);
    }
    assert.equal(JSON.stringify(k.read(id)), before);
  });

  test(`${k.name}: ${k.badConfigs ? "a config with a wrong-typed or unknown field is refused with 400 and nothing is stored" : "any object config is taken"}`, async () => {
    const id = await k.add();
    const before = JSON.stringify(k.read(id));
    if (!k.badConfigs) {
      assert.equal(await statusOf(k, `${k.base}/${id}`, "PATCH", k.wrap({ config: { host: 5 } })), 200);
      return;
    }
    for (const config of k.badConfigs) {
      assert.equal(await statusOf(k, `${k.base}/${id}`, "PATCH", k.wrap({ config })), 400, `config ${JSON.stringify(config)}`);
    }
    assert.equal(JSON.stringify(k.read(id)), before);
  });

  test(`${k.name}: an enabled that is not a boolean is refused with 400`, async () => {
    const id = await k.add();
    assert.equal(await statusOf(k, `${k.base}/${id}`, "PATCH", k.wrap({ enabled: "yes" })), 400);
    assert.equal(k.read(id)?.enabled, false);
  });

  // RossTalk's body is the edit itself, with no {patch} wrapper to get wrong.
  if (k.name !== "rosstalk") {
    test(`${k.name}: a patch that is not an object is refused with 400`, async () => {
      const id = await k.add();
      assert.equal(await statusOf(k, `${k.base}/${id}`, "PATCH", { patch: "x" }), 400);
    });
  }

  test(`${k.name}: a good edit is trimmed and stored`, async () => {
    const id = await k.add();
    assert.equal(await statusOf(k, `${k.base}/${id}`, "PATCH", k.wrap({ name: "  Front of house  " })), 200);
    assert.equal(k.read(id)?.name, "Front of house");
    if (k.badConfigs) {
      assert.equal(await statusOf(k, `${k.base}/${id}`, "PATCH", k.wrap({ config: { host: "10.0.0.5", port: 7788 } })), 200);
      assert.deepEqual(k.read(id)?.config, { host: "10.0.0.5", port: 7788, ...(k.name === "rosstalk" ? { family: "carbonite" } : {}) });
    }
  });

  test(`${k.name}: an edit or a removal of an unknown id is 404`, async () => {
    assert.equal(await statusOf(k, `${k.base}/no-such-id`, "PATCH", k.wrap({ name: "x" })), 404);
    assert.equal(await statusOf(k, `${k.base}/no-such-id`, "DELETE"), 404);
  });

  test(`${k.name}: removing a known id removes it`, async () => {
    const id = await k.add();
    assert.equal(await statusOf(k, `${k.base}/${id}`, "DELETE"), 200);
    assert.equal(k.read(id), undefined);
  });
}

test("rosstalk: a config patch cannot spread a string into the stored config", async () => {
  // {"config":"x"} used to land as {0:"x"} in the persisted target.
  const id = await KINDS[0].add();
  await statusOf(KINDS[0], `${KINDS[0].base}/${id}`, "PATCH", { config: "x" });
  assert.equal(Object.hasOwn(rosstalkManager.listTargets().find((t) => t.id === id)!.config, "0"), false);
});

test("a default name is not one another entry already carries", async () => {
  // Two entries, the first removed: "<label> 3" would be the count-based name, and
  // the survivor is already called that.
  const a = await oscManager.addTarget({});
  const names = a.map((t) => t.name);
  const added = await oscManager.addTarget({});
  const all = added.map((t) => t.name);
  assert.equal(new Set(all).size, all.length, `duplicate default name in ${JSON.stringify(all)} (was ${JSON.stringify(names)})`);
  const first = added[0];
  await oscManager.removeTarget({ id: first.id });
  const again = (await oscManager.addTarget({})).map((t) => t.name);
  assert.equal(new Set(again).size, again.length, `duplicate default name in ${JSON.stringify(again)}`);
});
