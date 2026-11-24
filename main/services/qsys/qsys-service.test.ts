import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { FakeQrcServer } from "./fake-qrc-server.js";
import { QsysService } from "./qsys-service.js";
import type { QsysCatalog } from "./qsys-service.js";
import type { QsysSettings } from "./qsys-settings-store.js";

let fake: FakeQrcServer;
let port: number;
let svc: QsysService;

const settings = (over: Partial<QsysSettings> = {}): QsysSettings => ({
  host: "127.0.0.1",
  port,
  user: "",
  enabled: true,
  volunteerMeterHz: 10,
  staffMeterHz: 20,
  ...over,
});

// setTimeout is mocked for the whole file: enabling and resetting it per test left the
// next test's timers unfired. Only setTimeout is mocked; sockets and setImmediate are real.
before(() => mock.timers.enable({ apis: ["setTimeout"] }));
after(() => mock.timers.reset());

beforeEach(async () => {
  fake = new FakeQrcServer();
  fake.components.set("Lobby_Mixer", [
    { Name: "gain", Type: "Float", Value: -10, String: "-10dB", Position: 0.5, Direction: "Read/Write", ValueMin: -100, ValueMax: 20 },
    { Name: "mute", Type: "Boolean", Value: false, String: "false", Position: 0, Direction: "Read/Write" },
  ]);
  fake.components.set("Zone 1", [
    { Name: "gain", Type: "Float", Value: 0, String: "0dB", Position: 0.8, Direction: "Read/Write", ValueMin: -100, ValueMax: 20 },
  ]);
  port = await fake.start();
  svc = new QsysService();
});

afterEach(async () => {
  svc.stop();
    await fake.stop();
});

/** The fake pushes EngineStatus only on accept; reach into it to push a change. */
function pushEngineStatus(): void {
  for (const session of fake["sessions"]) fake["notify"](session, "EngineStatus", { ...fake.status });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20000; i++) await new Promise((r) => setImmediate(r));
}

/** Poll on the real event loop; sockets are real even when timers are mocked. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}; fake saw ${fake.received.map((r) => r.method).join(",")}; status ${JSON.stringify(svc.getStatus())}`);
}

test("connects, logs on when a user is set, reads status and the catalog", async () => {
  fake.requireLogon = { User: "op", Password: "pw" };
  svc.configure(settings({ user: "op" }), "pw");
  await until(() => svc.getStatus().connected && svc.getCatalog() !== null, "connected + catalog");
  const status = svc.getStatus();
  assert.equal(status.state, "connected");
  assert.equal(status.designName, "Test Design");
  assert.equal(status.isEmulator, true);
  assert.ok(status.catalogAt !== null);
  const cat = svc.getCatalog()!;
  assert.equal(cat.designCode, "design-1");
  assert.deepEqual(cat.components.map((c) => c.name).sort(), ["Lobby_Mixer", "Zone 1"]);
  assert.equal(cat.components.find((c) => c.name === "Lobby_Mixer")!.controls.length, 2);
  assert.ok(svc.transport);
  assert.equal(fake.received[0].method, "Logon");
});

test("sends NoOp after 30 s of silence", async () => {
    svc.configure(settings(), null);
  await until(() => svc.getStatus().connected, "connected");
  assert.ok(!fake.received.some((r) => r.method === "NoOp"));
  mock.timers.tick(29_000);
  await settle();
  assert.ok(!fake.received.some((r) => r.method === "NoOp"), "not yet at 29 s");
  mock.timers.tick(1_000);
  await until(() => fake.received.some((r) => r.method === "NoOp"), "NoOp");
});

test("a send through the transport resets the silence timer", async () => {
    svc.configure(settings(), null);
  await until(() => svc.getStatus().connected, "connected");
  mock.timers.tick(20_000);
  await svc.transport!.send("StatusGet");
  mock.timers.tick(20_000);
  await settle();
  assert.ok(!fake.received.some((r) => r.method === "NoOp"), "40 s since connect but only 20 s since the last send");
  mock.timers.tick(10_000);
  await until(() => fake.received.some((r) => r.method === "NoOp"), "NoOp");
});

test("logon failure (code 10) reports error and schedules a reconnect, no catalog", async () => {
  fake.requireLogon = { User: "op", Password: "pw" };
  const states: string[] = [];
  svc.setConnectionListener((s) => states.push(s));
    svc.configure(settings({ user: "op" }), "wrong");
  await until(() => states.includes("error"), "error report");
  assert.equal(svc.getCatalog(), null);
  assert.equal(svc.getStatus().connected, false);
  assert.equal(svc.getStatus().state, "reconnecting");
  const logons = () => fake.received.filter((r) => r.method === "Logon").length;
  assert.equal(logons(), 1);
  // A reconnect is armed: advancing the clock dials again.
  mock.timers.tick(3_000);
  await until(() => logons() === 2, "second logon attempt");
});

test("EngineStatus with a new DesignCode triggers refreshCatalog and onCatalog", async () => {
  const seen: QsysCatalog[] = [];
  svc.onCatalog((c) => seen.push(c));
  svc.configure(settings(), null);
  await until(() => seen.length === 1, "initial catalog");
  // Same DesignCode again: no refresh.
  const getComponents = () => fake.received.filter((r) => r.method === "Component.GetComponents").length;
  assert.equal(getComponents(), 1);
  fake.components.set("Hall_Amp", [
    { Name: "mute", Type: "Boolean", Value: false, String: "false", Position: 0, Direction: "Read/Write" },
  ]);
  fake.status = { ...fake.status, DesignCode: "design-2" };
  pushEngineStatus();
  await until(() => seen.length === 2, "refreshed catalog");
  assert.equal(seen[1].designCode, "design-2");
  assert.ok(seen[1].components.some((c) => c.name === "Hall_Amp"));
  assert.equal(svc.getCatalog()!.designCode, "design-2");
});

test("an EngineStatus with the same DesignCode does not refresh", async () => {
  svc.configure(settings(), null);
  await until(() => svc.getCatalog() !== null, "catalog");
  pushEngineStatus();
  await settle();
  assert.equal(fake.received.filter((r) => r.method === "Component.GetComponents").length, 1);
});

test("socket drop reports reconnecting then reconnects with backoff", async () => {
  svc.configure(settings(), null);
  await until(() => svc.getStatus().connected, "connected");
    await fake.dropClients();
  await until(() => svc.getStatus().state === "reconnecting", "reconnecting");
  assert.equal(svc.getStatus().connected, false);
  assert.equal(svc.transport, null);
  mock.timers.tick(3_000);
  await until(() => svc.getStatus().state === "connected", "reconnected");
});

test("stop() is quiet: no reconnecting state, no reconnect", async () => {
  svc.configure(settings(), null);
  await until(() => svc.getStatus().connected, "connected");
  svc.stop();
  assert.equal(svc.getStatus().state, "offline");
  await settle();
  assert.equal(svc.getStatus().state, "offline");
});

test("test() never stores the password and reports component count", async () => {
  fake.requireLogon = { User: "op", Password: "pw" };
  const result = await svc.test(settings({ user: "op" }), "pw");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.components, 2);
    assert.equal(result.status.DesignName, "Test Design");
  }
  assert.equal(svc.getStatus().state, "offline");
  assert.equal(svc.transport, null);
  assert.equal(svc.getCatalog(), null);
  assert.ok(!JSON.stringify(svc).includes("pw"), "the password is not held on the instance");
  const bad = await svc.test(settings({ user: "op" }), "nope");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(!bad.error.includes("nope"));
});
