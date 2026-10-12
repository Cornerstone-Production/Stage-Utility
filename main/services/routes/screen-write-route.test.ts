// POST /api/outputs, PATCH /api/outputs/:id, POST /api/views/:id/surface and
// POST /api/devices/claim, driven through the real route modules and controller.
// A screen is a control surface when the view it shows is a console, so a `mode`
// in a body is refused with that reason from every one of the routes that took it.
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
const { screenIsControlSurface } = await import("../../types/views.js");
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
      { id: "display-3", name: "Booth panel", viewId: "ctl-a" },
      { id: "display-4", name: "Stage panel", viewId: "ctl-a" },
    ] as unknown as Output[],
  };
  ctl.recomputeResolved();
  resetKioskPresence();
  await kioskDevicesStore.save([]);
});

const post = (url: string, body: unknown) => callRoute(viewRoutes, url, { method: "POST", body });
const outputs = () => stageController.getState().outputs;
const views = () => stageController.getState().views;
const controlSurfaces = (viewId: string) =>
  outputs().filter((o) => o.viewId === viewId).map((o) => screenIsControlSurface(o, views()));

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
    const r = await post("/api/outputs", { name: "Wing", newView: "control", slug: "wing", showInSidebar: false });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const made = outputs().find((o) => o.name === "Wing")!;
    assert.equal(screenIsControlSurface(made, views()), true);
    assert.equal("mode" in made, false, "a screen has no stored role");
    assert.equal(made.slug, "wing");
    const v = views().find((x) => x.id === made.viewId)!;
    assert.equal(v.name, "Wing");
    assert.equal(v.surface, "console");
    assert.equal(v.showInSidebar, false);
  });

  it("makes a read-only screen with a new wall view", async () => {
    const r = await post("/api/outputs", { name: "Atrium", newView: "wall" });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const made = outputs().find((o) => o.name === "Atrium")!;
    assert.equal(views().find((x) => x.id === made.viewId)!.surface, "display");
    assert.equal(screenIsControlSurface(made, views()), false);
  });

  it("shows an existing console of either kind: the screen is a control surface", async () => {
    const r = await post("/api/outputs", { name: "Wing", viewId: "ctl-a", showInSidebar: false });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(screenIsControlSurface(outputs().find((o) => o.name === "Wing")!, views()), true);
  });

  it("refuses a mode with a 400 that says the view decides, and creates nothing", async () => {
    for (const mode of ["panel", "display", "kiosk", null]) {
      const r = await post("/api/outputs", { name: "Nope", mode, viewId: "ctl-a" });
      assert.equal(r.status, 400, String(mode));
      assert.match((r.json as { error: string }).error, /takes its role from the view/);
    }
    assert.equal(outputs().length, 4);
  });

  it("refuses a showInSidebar with no control surface to put it on, rather than dropping it", async () => {
    const r = await post("/api/outputs", { name: "Nope", viewId: "wall-a", showInSidebar: false });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /showInSidebar/);
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
    for (const body of [{ newView: true }, { newView: "yes" }, { slug: 5 }, { showInSidebar: "no" }]) {
      const r = await post("/api/outputs", body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(outputs().length, 4);
  });

  it("answers a failure part-way with a 500 that says what was undone", async () => {
    (stageController as unknown as Record<string, unknown>).setViewShowInSidebar = async () => { throw new Error("disk full"); };
    try {
      const r = await post("/api/outputs", { name: "Doomed", newView: "control", showInSidebar: false });
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

describe("PATCH /api/outputs/:id — the view decides", () => {
  const patch = (url: string, body: unknown) => callRoute(viewRoutes, url, { method: "PATCH", body });

  it("refuses a mode with a 400 that says the view decides, and changes nothing", async () => {
    const before = JSON.stringify(outputs());
    for (const mode of ["panel", "display", "kiosk"]) {
      const r = await patch("/api/outputs/display-1", { mode });
      assert.equal(r.status, 400, mode);
      assert.match((r.json as { error: string }).error, /takes its role from the view/);
    }
    // Even alongside a field that is fine: the whole request is refused, so a
    // script is not left believing the screen is a control surface.
    const mixed = await patch("/api/outputs/display-1", { name: "Renamed", mode: "panel" });
    assert.equal(mixed.status, 400);
    assert.equal(JSON.stringify(outputs()), before);
  });

  it("points a screen at a console and it is a control surface; back at a wall view and it is read-only", async () => {
    let r = await patch("/api/outputs/display-1", { viewId: "ctl-a" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(screenIsControlSurface(outputs().find((o) => o.id === "display-1")!, views()), true);
    r = await patch("/api/outputs/display-1", { viewId: "wall-a" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(screenIsControlSurface(outputs().find((o) => o.id === "display-1")!, views()), false);
  });
});

describe("POST /api/views/:id/surface", () => {
  const patch = (url: string, body: unknown) => callRoute(viewRoutes, url, { method: "PATCH", body });

  it("refuses a body with no surface, or one that is neither", async () => {
    for (const body of [{}, { surface: "kiosk" }, { surface: 1 }, { surface: null }]) {
      const r = await post("/api/views/wall-a/surface", body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(views().find((v) => v.id === "wall-a")!.surface, "display");
  });

  it("makes the view a console, and every screen showing it a control surface, and answers the state", async () => {
    const r = await post("/api/views/wall-a/surface", { surface: "console" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const answered = r.json as { views: View[]; outputs: Output[] };
    assert.equal(answered.views.find((v) => v.id === "wall-a")!.surface, "console");
    assert.deepEqual(controlSurfaces("wall-a"), [true, true]);
  });

  it("makes the screens read-only again", async () => {
    const r = await post("/api/views/ctl-a/surface", { surface: "display" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(views().find((v) => v.id === "ctl-a")!.surface, "display");
    assert.deepEqual(controlSurfaces("ctl-a"), [false, false]);
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

  it("answers a failed write with the 500 shape of POST /api/outputs, and puts the view back", async () => {
    const own = stageController as unknown as Record<string, unknown>;
    const proto = Object.getPrototypeOf(stageController) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    let calls = 0;
    // Lands in memory, then fails: what a full disk does. The first call is the
    // write, and the undo that follows must be allowed through.
    own.setViewSurface = async (...args: unknown[]) => {
      calls += 1;
      const result = await proto.setViewSurface.apply(stageController, args);
      if (calls === 1) throw new Error("disk full");
      return result;
    };
    try {
      const r = await post("/api/views/wall-a/surface", { surface: "console" });
      assert.equal(r.status, 500);
      const j = r.json as { error: string; failed: string; rolledBack: string[]; notRolledBack: string[] };
      assert.match(j.failed, /make the view a control surface/);
      assert.deepEqual(j.rolledBack, ["make the view a control surface"]);
      assert.deepEqual(j.notRolledBack, []);
    } finally {
      delete own.setViewSurface;
    }
    assert.equal(views().find((v) => v.id === "wall-a")!.surface, "display");
    assert.deepEqual(controlSurfaces("wall-a"), [false, false]);
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
    assert.deepEqual(controlSurfaces("wall-a"), [true, true]);
  });

  it("refuses a screens field that is not a list of ids", async () => {
    for (const screens of ["display-1", [1], null, { id: "display-1" }]) {
      const r = await post("/api/views/wall-a/surface", { surface: "console", screens });
      assert.equal(r.status, 400, JSON.stringify(screens));
    }
    assert.equal(views().find((v) => v.id === "wall-a")!.surface, "display");
  });

  it("leaves PATCH /api/views/:id { surface } as it was: it refuses a view that screens are showing", async () => {
    const r = await patch("/api/views/wall-a", { surface: "console" });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /"Lobby TV", "Hallway TV"/);
    assert.equal(views().find((v) => v.id === "wall-a")!.surface, "display");
    assert.deepEqual(controlSurfaces("wall-a"), [false, false], "a read-only screen went live");
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
    const r = await claim({ name: "Wing", newView: "control", slug: "wing", showInSidebar: false });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const made = outputs().find((o) => o.name === "Wing")!;
    assert.equal(screenIsControlSurface(made, views()), true);
    assert.equal(made.slug, "wing");
    assert.equal(views().find((v) => v.id === made.viewId)?.showInSidebar, false);
    assert.equal((await kioskDevicesStore.load()).find((d) => d.id === device.id)?.outputId, made.id);
  });

  it("refuses a bad body with nothing created and the device still unclaimed", async () => {
    recordSeen(device);
    const r = await claim({ name: "Nope", viewId: "ghost" });
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

  it("refuses a mode, with nothing created and the device still unclaimed", async () => {
    recordSeen(device);
    for (const body of [{ name: "Nope", mode: "panel", newView: "control" }, { outputId: "display-1", mode: "display" }]) {
      const r = await claim(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match((r.json as { error: string }).error, /takes its role from the view/);
    }
    assert.equal(outputs().length, 4);
    assert.equal((await kioskDevicesStore.load()).length, 0);
  });

  it("refuses creation fields alongside an existing screen to take over", async () => {
    recordSeen(device);
    const r = await claim({ outputId: "display-1", newView: "control" });
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
      const r = await claim({ name: "Wing", viewId: "ctl-a", showInSidebar: false });
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
      const r = await claim({ name: "Wing", newView: "control" });
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
