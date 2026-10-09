// POST /api/outputs, POST /api/outputs/:id/role, POST /api/views/:id/surface and
// POST /api/devices/claim, driven through the real route modules and controller.
//
// The first block is the ORIGINAL call, { name, viewId }, and it is written to
// pass unchanged against the build before createScreen existed: it is the check
// that scripts and integrations posting that body still get what they always did.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-screen-write-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { viewRoutes } = await import("./view-routes.js");
const { kioskDeviceRoutes } = await import("./kiosk-device-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");
const { recordSeen, resetKioskPresence } = await import("../kiosk-presence.js");
const { kioskDevicesStore } = await import("../kiosk-devices-store.js");

type Mutable = { state: { views: View[]; outputs: Output[]; [k: string]: unknown }; broadcast: () => void; recomputeResolved: () => void };
const ctl = stageController as unknown as Mutable;
ctl.broadcast = () => {};

const layout = { version: 1, canvas: { width: 1920, height: 1080 }, objects: [] };
const NOW = "2026-01-01T00:00:00.000Z";

beforeEach(async () => {
  ctl.state = {
    ...ctl.state,
    views: [
      { id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", createdAt: NOW, layout },
      { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW, layout },
    ] as unknown as View[],
    outputs: [
      { id: "display-1", name: "Lobby TV", viewId: "wall-a" },
      { id: "display-2", name: "Hallway TV", viewId: "wall-a" },
      { id: "display-3", name: "Booth panel", viewId: "ctl-a", mode: "panel" },
      { id: "display-4", name: "Stage panel", viewId: "ctl-a", mode: "panel" },
    ] as unknown as Output[],
  };
  ctl.recomputeResolved();
  resetKioskPresence();
  await kioskDevicesStore.save([]);
});

const post = (url: string, body: unknown) => callRoute(viewRoutes, url, { method: "POST", body });
const outputs = () => stageController.getState().outputs;
const views = () => stageController.getState().views;

describe("POST /api/outputs — the original { name, viewId } call", () => {
  it("answers 201 with the state, and the new screen is exactly { id, name, viewId }", async () => {
    const r = await post("/api/outputs", { name: "Cafe TV", viewId: "wall-a" });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const created = outputs().find((o) => o.name === "Cafe TV");
    assert.ok(created, "no screen was made");
    assert.deepEqual(Object.keys(created!).sort(), ["id", "name", "viewId"], "the new screen carries a field the original call never wrote");
    assert.equal(created!.viewId, "wall-a");
    assert.equal(views().length, 2, "a view was made for a call that did not ask for one");
    const body = r.json as { outputs: Output[] };
    assert.ok(body.outputs.some((o) => o.name === "Cafe TV"), "the answer is not the state");
  });

  it("with no body at all makes 'Display N' routed nowhere", async () => {
    const r = await post("/api/outputs", {});
    assert.equal(r.status, 201);
    const created = outputs()[outputs().length - 1];
    assert.match(created.name, /^Display \d+$/);
    assert.equal(created.viewId, null);
  });

  it("ignores a name or viewId of the wrong type, as it always did", async () => {
    const r = await post("/api/outputs", { name: 7, viewId: 7 });
    assert.equal(r.status, 201);
    assert.equal(outputs()[outputs().length - 1].viewId, null);
  });
});

describe("POST /api/outputs — the guided creation fields", () => {
  it("makes a control surface with a new view, a slug and the sidebar listing off", async () => {
    const r = await post("/api/outputs", { name: "Wing", mode: "panel", newView: true, slug: "wing", showInSidebar: false });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const made = outputs().find((o) => o.name === "Wing")!;
    assert.equal(made.mode, "panel");
    assert.equal(made.slug, "wing");
    const v = views().find((x) => x.id === made.viewId)!;
    assert.equal(v.name, "Wing");
    assert.equal(v.surface, "console");
    assert.equal(v.showInSidebar, false);
  });

  it("refuses a view that does not fit the role with a 400, and creates nothing", async () => {
    const r = await post("/api/outputs", { name: "Nope", mode: "panel", viewId: "wall-a" });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /control-surface view/);
    assert.equal(outputs().length, 4);
  });

  it("refuses a taken slug with a 400, and creates nothing", async () => {
    await post("/api/outputs", { name: "One", slug: "cafe" });
    const r = await post("/api/outputs", { name: "Two", slug: "cafe" });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /already used/);
    assert.equal(outputs().filter((o) => o.name === "Two").length, 0);
  });

  it("refuses a field of the wrong type rather than dropping it", async () => {
    for (const body of [{ mode: "kiosk" }, { newView: "yes" }, { slug: 5 }, { showInSidebar: "no" }]) {
      const r = await post("/api/outputs", body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(outputs().length, 4);
  });

  it("answers a failure part-way with a 500 that says what was undone", async () => {
    (stageController as unknown as Record<string, unknown>).setViewShowInSidebar = async () => { throw new Error("disk full"); };
    try {
      const r = await post("/api/outputs", { name: "Doomed", mode: "panel", newView: true, showInSidebar: false });
      assert.equal(r.status, 500);
      const j = r.json as { error: string; failed: string; rolledBack: string[]; notRolledBack: string[] };
      assert.equal(j.failed, "set the sidebar listing");
      assert.deepEqual([...j.rolledBack].sort(), ["add the screen", "make the view"]);
      assert.deepEqual(j.notRolledBack, []);
    } finally {
      delete (stageController as unknown as Record<string, unknown>).setViewShowInSidebar;
    }
    assert.equal(outputs().length, 4);
    assert.equal(views().length, 2);
  });
});

describe("POST /api/outputs/:id/role", () => {
  it("refuses a body with no mode", async () => {
    const r = await post("/api/outputs/display-4/role", {});
    assert.equal(r.status, 400);
  });

  it("refuses a copyView or viewId of the wrong type", async () => {
    assert.equal((await post("/api/outputs/display-4/role", { mode: "display", copyView: "yes" })).status, 400);
    assert.equal((await post("/api/outputs/display-4/role", { mode: "display", viewId: 5 })).status, 400);
  });

  it("refuses a screen that does not exist", async () => {
    const r = await post("/api/outputs/ghost/role", { mode: "display" });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /not found/);
  });

  it("refuses a shared view with neither a copy nor a view, naming the other screen", async () => {
    const r = await post("/api/outputs/display-4/role", { mode: "display" });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /Booth panel/);
    assert.equal(outputs().find((o) => o.id === "display-4")!.mode, "panel");
  });

  it("copies the view and leaves the other screen on the original", async () => {
    const r = await post("/api/outputs/display-4/role", { mode: "display", copyView: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const mine = outputs().find((o) => o.id === "display-4")!;
    const theirs = outputs().find((o) => o.id === "display-3")!;
    assert.equal(mine.mode, "display");
    assert.notEqual(mine.viewId, "ctl-a");
    assert.equal(views().find((v) => v.id === mine.viewId)!.name, "Booth controls (wall)");
    assert.equal(theirs.mode, "panel");
    assert.equal(theirs.viewId, "ctl-a");
  });

  it("answers a failure part-way with a 500 that says what was undone", async () => {
    (stageController as unknown as Record<string, unknown>).setOutputView = async () => { throw new Error("disk full"); };
    try {
      const r = await post("/api/outputs/display-4/role", { mode: "display", copyView: true });
      assert.equal(r.status, 500);
      const j = r.json as { failed: string; rolledBack: string[]; notRolledBack: string[] };
      assert.equal(j.failed, "point the screen at the copy");
      assert.ok(j.rolledBack.includes("copy the view"));
    } finally {
      delete (stageController as unknown as Record<string, unknown>).setOutputView;
    }
    assert.equal(views().length, 2, "the copy was left behind");
  });
});

describe("POST /api/views/:id/surface", () => {
  const patch = (url: string, body: unknown) => callRoute(viewRoutes, url, { method: "PATCH", body });

  it("refuses a body with no surface, or one that is neither", async () => {
    for (const body of [{}, { surface: "kiosk" }, { surface: 1 }, { surface: null }]) {
      const r = await post("/api/views/wall-a/surface", body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(outputs().map((o) => o.mode ?? "display"), ["display", "display", "panel", "panel"]);
  });

  it("makes the view and every screen showing it a control surface, and answers the state", async () => {
    const r = await post("/api/views/wall-a/surface", { surface: "console" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const answered = r.json as { views: View[]; outputs: Output[] };
    assert.equal(answered.views.find((v) => v.id === "wall-a")!.surface, "console");
    assert.deepEqual(answered.outputs.filter((o) => o.viewId === "wall-a").map((o) => o.mode), ["panel", "panel"]);
  });

  it("makes them wall displays again", async () => {
    const r = await post("/api/views/ctl-a/surface", { surface: "display" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(views().find((v) => v.id === "ctl-a")!.surface, "display");
    assert.deepEqual(outputs().filter((o) => o.viewId === "ctl-a").map((o) => o.mode), ["display", "display"]);
  });

  it("refuses a view that cannot be a control surface, and a missing one, with the reason as a 400", async () => {
    ctl.state = { ...ctl.state, views: [...views(), { id: "cal-a", name: "Week ahead", kind: "calendar", createdAt: NOW }] as unknown as View[] };
    const refused = await post("/api/views/cal-a/surface", { surface: "console" });
    assert.equal(refused.status, 400);
    assert.match((refused.json as { error: string }).error, /Week ahead.*Calendar view/s);
    const missing = await post("/api/views/ghost/surface", { surface: "display" });
    assert.equal(missing.status, 400);
    assert.match((missing.json as { error: string }).error, /not found/);
  });

  it("answers a failure part-way with the 500 shape of the role route, and puts everything back", async () => {
    let calls = 0;
    const own = stageController as unknown as Record<string, unknown>;
    const proto = Object.getPrototypeOf(stageController) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    own.setOutputMode = async (...args: unknown[]) => {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      return proto.setOutputMode.apply(stageController, args);
    };
    try {
      const r = await post("/api/views/wall-a/surface", { surface: "console" });
      assert.equal(r.status, 500);
      const j = r.json as { error: string; failed: string; rolledBack: string[]; notRolledBack: string[] };
      assert.match(j.failed, /"Hallway TV"/);
      assert.deepEqual(j.rolledBack, ['make "Lobby TV" a control surface']);
      assert.deepEqual(j.notRolledBack, []);
    } finally {
      delete own.setOutputMode;
    }
    assert.equal(views().find((v) => v.id === "wall-a")!.surface, "display");
    assert.deepEqual(outputs().filter((o) => o.viewId === "wall-a").map((o) => o.mode ?? "display"), ["display", "display"]);
  });

  it("answers 409 with the screens as they are now when the list the operator was shown is stale, and writes nothing", async () => {
    const before = JSON.stringify({ views: views(), outputs: outputs() });
    const r = await post("/api/views/wall-a/surface", { surface: "console", screens: ["display-1"] });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    const j = r.json as { error: string; code: string; screens: { id: string; name: string }[] };
    assert.equal(j.code, "screens-changed");
    assert.deepEqual(j.screens, [{ id: "display-1", name: "Lobby TV" }, { id: "display-2", name: "Hallway TV" }]);
    assert.match(j.error, /"Lobby TV", "Hallway TV"/);
    assert.equal(JSON.stringify({ views: views(), outputs: outputs() }), before);
  });

  it("goes ahead when the list matches", async () => {
    const r = await post("/api/views/wall-a/surface", { surface: "console", screens: ["display-2", "display-1"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(outputs().filter((o) => o.viewId === "wall-a").map((o) => o.mode), ["panel", "panel"]);
  });

  it("refuses a screens field that is not a list of ids", async () => {
    for (const screens of ["display-1", [1], null, { id: "display-1" }]) {
      const r = await post("/api/views/wall-a/surface", { surface: "console", screens });
      assert.equal(r.status, 400, JSON.stringify(screens));
    }
    assert.deepEqual(outputs().map((o) => o.mode ?? "display"), ["display", "display", "panel", "panel"]);
  });

  it("leaves PATCH /api/views/:id { surface } as it was: it refuses a view that screens are showing", async () => {
    const r = await patch("/api/views/wall-a", { surface: "console" });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /Lobby TV, Hallway TV/);
    assert.equal(views().find((v) => v.id === "wall-a")!.surface, "display");
    assert.deepEqual(outputs().filter((o) => o.viewId === "wall-a").map((o) => o.mode ?? "display"), ["display", "display"]);
  });
});

describe("POST /api/devices/claim — a new screen", () => {
  const device = { id: "kiosk-aaaa", macs: ["aa:bb:cc:dd:ee:ff"], hostname: "lobby-pi", os: "linux", ip: "192.0.2.10" };
  const claim = (body: Record<string, unknown>) => callRoute(kioskDeviceRoutes, "/api/devices/claim", { method: "POST", body: { deviceId: device.id, ...body } });

  it("with no other fields makes a screen named after the device and binds it, as it always did", async () => {
    recordSeen(device);
    const r = await claim({});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const made = outputs().find((o) => o.name === "lobby-pi");
    assert.ok(made, "no screen named after the device");
    assert.deepEqual(Object.keys(made!).sort(), ["id", "name", "viewId"]);
    assert.equal((await kioskDevicesStore.load()).find((d) => d.id === device.id)?.outputId, made!.id);
  });

  it("answers with the id of the screen it made", async () => {
    recordSeen(device);
    const r = await claim({});
    const made = outputs().find((o) => o.name === "lobby-pi");
    assert.equal((r.json as { outputId: string }).outputId, made!.id);
  });

  it("names the screen 'New screen' for a device that reports an empty hostname, as it always did", async () => {
    recordSeen({ ...device, hostname: "" });
    const r = await claim({});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(outputs().find((o) => o.id === (r.json as { outputId: string }).outputId)?.name, "New screen");
  });

  it("still takes the name the Screens page used to send as newName", async () => {
    recordSeen(device);
    await claim({ newName: "Atrium" });
    assert.ok(outputs().some((o) => o.name === "Atrium"));
  });

  it("makes the screen from the guided fields and binds the device to it", async () => {
    recordSeen(device);
    const r = await claim({ name: "Wing", mode: "panel", newView: true, slug: "wing", showInSidebar: false });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const made = outputs().find((o) => o.name === "Wing")!;
    assert.equal(made.mode, "panel");
    assert.equal(made.slug, "wing");
    assert.equal(views().find((v) => v.id === made.viewId)?.showInSidebar, false);
    assert.equal((await kioskDevicesStore.load()).find((d) => d.id === device.id)?.outputId, made.id);
  });

  it("refuses a bad body with nothing created and the device still unclaimed", async () => {
    recordSeen(device);
    const r = await claim({ name: "Nope", mode: "panel", viewId: "wall-a" });
    assert.equal(r.status, 400);
    assert.equal(outputs().length, 4);
    assert.equal(views().length, 2);
    assert.equal((await kioskDevicesStore.load()).length, 0);
  });

  it("refuses a device that is already bound, rather than moving it to a new screen", async () => {
    // Set up as a new screen is offered for a device that is waiting. If another
    // operator bound it meanwhile, a new screen must not silently take it away.
    recordSeen(device);
    assert.equal((await claim({ outputId: "display-1" })).status, 200);
    const count = outputs().length;
    const r = await claim({ name: "Wing" });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match((r.json as { error: string }).error, /Lobby TV/, "must name the screen it is on");
    assert.equal(outputs().length, count, "a screen was made");
    assert.equal((await kioskDevicesStore.load()).find((d) => d.id === device.id)?.outputId, "display-1", "the device was moved");
  });

  it("two operators setting the same device up at once make one screen, not two", async () => {
    recordSeen(device);
    const count = outputs().length;
    const answers = await Promise.all([claim({ name: "Wing A" }), claim({ name: "Wing B" })]);
    assert.deepEqual(answers.map((r) => r.status).sort(), [200, 500], JSON.stringify(answers.map((r) => r.json)));
    assert.equal(outputs().length, count + 1, "the losing claim left an empty screen behind");
  });

  it("still moves a bound device when the operator names the screen", async () => {
    recordSeen(device);
    await claim({ outputId: "display-1" });
    assert.equal((await claim({ outputId: "display-2" })).status, 200);
    assert.equal((await kioskDevicesStore.load()).find((d) => d.id === device.id)?.outputId, "display-2");
  });

  it("refuses creation fields alongside an existing screen to take over", async () => {
    recordSeen(device);
    const r = await claim({ outputId: "display-1", mode: "panel" });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /existing screen/);
    assert.equal((await kioskDevicesStore.load()).length, 0);
  });

  it("puts an existing console back in the sidebar when the binding fails", async () => {
    // The listing is written on a view that existed before the claim, so taking
    // back the screen and any view made for it is not enough.
    recordSeen(device);
    const file = path.join(TMP, "kiosk-devices.json");
    await fs.rm(file, { force: true });
    await fs.mkdir(file);
    try {
      const r = await claim({ name: "Wing", mode: "panel", viewId: "ctl-a", showInSidebar: false });
      assert.equal(r.status, 500, JSON.stringify(r.json));
    } finally {
      await fs.rm(file, { recursive: true, force: true });
    }
    assert.equal(outputs().some((o) => o.name === "Wing"), false, "the empty screen was left behind");
    assert.notEqual(views().find((v) => v.id === "ctl-a")!.showInSidebar, false, "the failed claim left the console hidden from the sidebar");
  });

  it("takes the screen AND the view it made back when the binding then fails", async () => {
    recordSeen(device);
    // A directory where the devices file goes: the write onto it cannot succeed.
    const file = path.join(TMP, "kiosk-devices.json");
    await fs.rm(file, { force: true });
    await fs.mkdir(file);
    try {
      const r = await claim({ name: "Wing", mode: "panel", newView: true });
      // A failure part-way, answered as POST /api/outputs answers one.
      assert.equal(r.status, 500, JSON.stringify(r.json));
      assert.equal((r.json as { failed: string }).failed, "bind the device");
    } finally {
      await fs.rm(file, { recursive: true, force: true });
    }
    assert.equal(outputs().some((o) => o.name === "Wing"), false, "the empty screen was left behind");
    assert.equal(views().some((v) => v.name === "Wing"), false, "the view made for it was left behind");
  });
});
