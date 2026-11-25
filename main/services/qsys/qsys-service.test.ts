import assert from "node:assert/strict";
import net from "node:net";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { FakeQrcServer } from "./fake-qrc-server.js";
import { QsysService, qsysTestMessage } from "./qsys-service.js";
import type { QsysCatalog } from "./qsys-service.js";
import type { QsysSettings } from "./qsys-settings.js";

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

test("connects, logs on when a user is set, reads status and the catalog", { timeout: 20_000 }, async () => {
  fake.requireLogon = { User: "op", Password: "pw" };
  svc.configure(settings({ user: "op" }), "pw");
  await until(() => svc.getStatus().connected && svc.getCatalog() !== null, "connected + catalog");
  const status = svc.getStatus();
  assert.equal(status.state, "connected");
  assert.ok(!JSON.stringify(status).includes("pw"), "the status payload carries the password");
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

test("sends NoOp after 30 s of silence", { timeout: 20_000 }, async () => {
  svc.configure(settings(), null);
  await until(() => svc.getStatus().connected, "connected");
  assert.ok(!fake.received.some((r) => r.method === "NoOp"));
  mock.timers.tick(29_000);
  await settle();
  assert.ok(!fake.received.some((r) => r.method === "NoOp"), "not yet at 29 s");
  mock.timers.tick(1_000);
  await until(() => fake.received.some((r) => r.method === "NoOp"), "NoOp");
});

test("a send through the transport resets the silence timer", { timeout: 20_000 }, async () => {
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

test("logon failure (code 10) reports error and schedules a reconnect, no catalog", { timeout: 20_000 }, async () => {
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

test("EngineStatus with a new DesignCode triggers refreshCatalog and onCatalog", { timeout: 20_000 }, async () => {
  const seen: QsysCatalog[] = [];
  const messages: (string | null)[] = [];
  svc.onCatalog((c) => seen.push(c));
  svc.setConnectionListener((_s, m) => messages.push(m));
  svc.configure(settings(), null);
  await until(() => seen.length === 1, "initial catalog");
  // Same DesignCode again: no refresh.
  const getComponents = () => fake.received.filter((r) => r.method === "Component.GetComponents").length;
  assert.equal(getComponents(), 1);
  fake.components.set("Hall_Amp", [
    { Name: "mute", Type: "Boolean", Value: false, String: "false", Position: 0, Direction: "Read/Write" },
  ]);
  fake.status = { ...fake.status, DesignCode: "design-2", DesignName: "Hall Design" };
  fake.pushStatus();
  await until(() => seen.length === 2, "refreshed catalog");
  assert.equal(seen[1].designCode, "design-2");
  assert.ok(seen[1].components.some((c) => c.name === "Hall_Amp"));
  assert.equal(svc.getCatalog()!.designCode, "design-2");
  assert.equal(svc.getStatus().designName, "Hall Design");
  assert.equal(messages.at(-1), "Connected to Hall Design", "the Integrations row still names the old design");
});

test("an EngineStatus with the same DesignCode does not refresh", { timeout: 20_000 }, async () => {
  svc.configure(settings(), null);
  await until(() => svc.getCatalog() !== null, "catalog");
  fake.pushStatus();
  await settle();
  assert.equal(fake.received.filter((r) => r.method === "Component.GetComponents").length, 1);
});

test("socket drop reports reconnecting then reconnects with backoff", { timeout: 20_000 }, async () => {
  svc.configure(settings(), null);
  await until(() => svc.getStatus().connected, "connected");
  await fake.dropClients();
  await until(() => svc.getStatus().state === "reconnecting", "reconnecting");
  assert.equal(svc.getStatus().connected, false);
  assert.equal(svc.transport, null);
  assert.equal(svc.getCatalog(), null, "the catalog does not outlive its connection");
  mock.timers.tick(3_000);
  await until(() => svc.getStatus().state === "connected", "reconnected");
});

test("stop() is quiet: no reconnecting state, no reconnect", { timeout: 20_000 }, async () => {
  svc.configure(settings(), null);
  await until(() => svc.getStatus().connected, "connected");
  svc.stop();
  assert.equal(svc.getStatus().state, "offline");
  await settle();
  assert.equal(svc.getStatus().state, "offline");
});

test("test() never stores the password and reports component count", { timeout: 20_000 }, async () => {
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
  assert.ok(!JSON.stringify(svc).includes("pw"), "test() did not leave the password on the instance");
  const bad = await svc.test(settings({ user: "op" }), "nope");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(!bad.error.includes("nope"));
});

test("configure() twice back to back leaves exactly one connection", { timeout: 20_000 }, async () => {
  svc.configure(settings(), null);
  svc.configure(settings(), null);
  await until(() => svc.getStatus().connected, "connected");
  // The superseded dial's socket is closed, not leaked.
  await until(() => fake["sessions"].size === 1, "one live session");
  await settle();
  assert.equal(fake["sessions"].size, 1);
});

test("stop() during a dial that then fails reports and logs nothing", { timeout: 20_000 }, async () => {
  // A port nothing listens on: the dial is refused after stop() has landed.
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const deadPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const warn = mock.method(console, "warn", () => {});
  try {
    const states: string[] = [];
    svc.setConnectionListener((s) => states.push(s));
    svc.configure(settings({ port: deadPort }), null);
    svc.stop();
    await settle();
    assert.deepEqual(states, [], "a dial that failed after stop() reported a state");
    assert.equal(svc.getStatus().state, "offline");
    assert.equal(warn.mock.calls.length, 0, "a dial that failed after stop() logged");
  } finally {
    warn.mock.restore();
  }
});

test("the transport stays closed to other code until the catalog has been read", { timeout: 20_000 }, async () => {
  fake.holdReplies = true;
  svc.configure(settings(), null);
  await until(() => fake.received.some((r) => r.method === "StatusGet"), "StatusGet sent");
  await settle();
  assert.equal(svc.transport, null, "transport was exposed before the connect sequence finished");
  assert.equal(svc.getCatalog(), null);
  assert.equal(svc.getStatus().connected, false);
});

test("an error the Core answered with is not reported as unreachable", { timeout: 20_000 }, async () => {
  fake.failNext("Component.GetComponents", 7);
  const messages: (string | null)[] = [];
  svc.setConnectionListener((_s, m) => messages.push(m));
  svc.configure(settings(), null);
  await until(() => messages.length > 0, "a report");
  assert.match(messages[0] ?? "", /answered with an error/);
  assert.doesNotMatch(messages[0] ?? "", /Can't reach/);
});

const lobby = { State: "Active" as const, DesignName: "Lobby Design", DesignCode: "c1", IsRedundant: false, IsEmulator: false };

test("a successful Test says which design it reached and how many components it read", () => {
  assert.deepEqual(qsysTestMessage({ ok: true, status: lobby, components: 12 }), {
    ok: true,
    message: "Connected to Lobby Design — 12 component(s)",
    rowMessage: "Lobby Design — 12 component(s)",
  });
});

test("an emulator is named as one in the Test answer", () => {
  const r = qsysTestMessage({ ok: true, status: { ...lobby, IsEmulator: true }, components: 1 });
  assert.equal(r.message, "Connected to Lobby Design (emulator) — 1 component(s)");
  assert.equal(r.rowMessage, "Lobby Design (emulator) — 1 component(s)");
});

test("a failed Test carries the reason, not a success", () => {
  assert.deepEqual(qsysTestMessage({ ok: false, error: "connection refused" }), { ok: false, message: "connection refused", rowMessage: "connection refused" });
});

/** [qsys] lines written while `run` runs, via console.log and console.warn. */
async function qsysLines(run: () => Promise<void>): Promise<string[]> {
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  try {
    await run();
    return [...log.mock.calls, ...warn.mock.calls].map((c) => String(c.arguments[0])).filter((l) => l.startsWith("[qsys]"));
  } finally {
    log.mock.restore();
    warn.mock.restore();
  }
}

const sent = (method: string) => fake.received.filter((r) => r.method === method).length;

test("a send through a transport kept past its connection leaves the live keepalive alone", { timeout: 20_000 }, async () => {
  svc.configure(settings(), null);
  await until(() => svc.getStatus().connected, "connected");
  const stale = svc.transport!;
  await fake.dropClients();
  await until(() => svc.getStatus().state === "reconnecting", "reconnecting");
  mock.timers.tick(3_000);
  await until(() => svc.getStatus().connected, "reconnected");
  const before = sent("NoOp");
  await assert.rejects(stale.send("StatusGet"));
  mock.timers.tick(30_000);
  await until(() => sent("NoOp") > before, "a NoOp on the new connection 30 s after the stale send");
  assert.equal(svc.getStatus().state, "connected");
});

test("a new design pushed while the connect sequence is reading is read once connected", { timeout: 20_000 }, async () => {
  fake.holdReplies = true;
  svc.configure(settings(), null);
  await until(() => sent("StatusGet") === 1, "StatusGet sent");
  fake.releaseHeld(); // status answers design-1; the catalog read starts and is held
  await until(() => sent("Component.GetComponents") === 1, "catalog read started");
  fake.status = { ...fake.status, DesignCode: "design-2" };
  fake.pushStatus();
  await settle();
  fake.holdReplies = false;
  fake.releaseHeld();
  await until(() => svc.getCatalog()?.designCode === "design-2", "the catalog re-read for design-2");
  assert.equal(sent("Component.GetComponents"), 2);
});

test("a second design pushed while a refresh is reading is read after it", { timeout: 20_000 }, async () => {
  svc.configure(settings(), null);
  await until(() => svc.getCatalog() !== null, "catalog");
  fake.holdReplies = true;
  fake.status = { ...fake.status, DesignCode: "design-2" };
  fake.pushStatus();
  await until(() => sent("StatusGet") === 2, "the refresh's StatusGet");
  fake.releaseHeld(); // the refresh reads design-2 ...
  await until(() => sent("Component.GetComponents") === 2, "the refresh's component list");
  fake.status = { ...fake.status, DesignCode: "design-3" }; // ... and the Core moves on while it reads
  fake.pushStatus();
  await settle();
  fake.holdReplies = false;
  fake.releaseHeld();
  await until(() => svc.getCatalog()?.designCode === "design-3", "the catalog for design-3");
});

test("a catalog read from an earlier connection neither lands nor is joined", { timeout: 20_000 }, async () => {
  svc.configure(settings(), null);
  await until(() => svc.getCatalog() !== null, "catalog");
  // A read the real code reaches only through a transport whose replies outlive
  // its connection; a stub stands in for one, since a real closed client rejects first.
  const answers: ((v: unknown) => void)[] = [];
  const stub = { send: () => new Promise<unknown>((r) => answers.push(r)), onNotification: () => {}, close: () => {} };
  const idle = { send: () => new Promise<unknown>(() => {}), onNotification: () => {}, close: () => {} };
  const loadCatalog = (svc as unknown as { loadCatalog(t: unknown): Promise<unknown> }).loadCatalog.bind(svc);
  const stale = loadCatalog(stub);
  svc.stop();
  assert.notEqual(loadCatalog(idle), stale, "a read from the earlier connection was joined");
  answers[0]({ ...fake.status, DesignCode: "stale" }); // StatusGet
  await settle();
  answers[1]([]); // Component.GetComponents: an empty design
  await stale;
  assert.equal(svc.getCatalog(), null, "a read from the earlier connection landed");
});

test("a wrong password is logged once, not on every retry", { timeout: 20_000 }, async () => {
  fake.requireLogon = { User: "op", Password: "pw" };
  const lines = await qsysLines(async () => {
    svc.configure(settings({ user: "op" }), "wrong");
    await until(() => sent("Logon") === 1, "first logon");
    await settle();
    mock.timers.tick(3_000);
    await until(() => sent("Logon") === 2, "second logon");
    await settle();
  });
  assert.deepEqual(lines.filter((l) => l.includes("logon")), ["[qsys] logon refused"]);
});

test("a Core that wants a logon when no user is set says so, not that a password was wrong", { timeout: 20_000 }, async () => {
  fake.requireLogon = { User: "op", Password: "pw" };
  const messages: (string | null)[] = [];
  svc.setConnectionListener((_s, m) => messages.push(m));
  const lines = await qsysLines(async () => {
    svc.configure(settings(), null);
    await until(() => messages.length > 0, "a report");
  });
  assert.equal(messages[0], "The Core requires a logon: set User and Password");
  assert.ok(lines.includes("[qsys] logon required, and no user is set"));
  const tested = await svc.test(settings(), null);
  assert.deepEqual(tested, { ok: false, error: "The Core requires a logon: set User and Password" });
});

test("the emulator flag reaches /log as a boolean, whatever the Core sent", { timeout: 20_000 }, async () => {
  fake.status = { ...fake.status, IsEmulator: "yes\n[qsys] forged" as unknown as boolean };
  const lines = await qsysLines(async () => {
    svc.configure(settings(), null);
    await until(() => svc.getStatus().connected, "connected");
  });
  const connected = lines.find((l) => l.startsWith("[qsys] connected to"));
  assert.match(connected ?? "", /emulator=false\)$/);
});

test("the status says whether a Core is set up, so a panel can tell 'not set up' from 'can't reach it'", { timeout: 20_000 }, async () => {
  assert.equal(svc.getStatus().configured, false, "a fresh service has no Core");
  svc.configure(settings(), null);
  // Set up before it has connected: a slow first dial is not "no Core".
  assert.equal(svc.getStatus().configured, true, "set up, still dialling");
  await until(() => svc.getStatus().connected, "connected");
  assert.equal(svc.getStatus().configured, true);
  await fake.stop();
  await until(() => svc.getStatus().state === "reconnecting", "reconnecting");
  assert.equal(svc.getStatus().configured, true, "unreachable is still set up");
  svc.configure(settings({ enabled: false }), null);
  assert.equal(svc.getStatus().state, "offline");
  assert.equal(svc.getStatus().configured, false, "switched off reads as no Core");
});

test("switched off by the integration manager (a bare stop) reads as no Core; a save that reconnects never does", { timeout: 20_000 }, async () => {
  svc.configure(settings(), null);
  await until(() => svc.getStatus().connected, "connected");
  const seen: boolean[] = [];
  const listen = mock.method(svc as unknown as { emit: (s: { configured: boolean }) => void }, "emit");
  // A save of the meter rates restarts the connection: never "no Core" on the way.
  svc.configure(settings({ staffMeterHz: 15 }), null);
  for (const c of listen.mock.calls) seen.push((c.arguments[0] as { configured: boolean }).configured);
  listen.mock.restore();
  assert.ok(seen.length > 0, "the restart published nothing (positive control)");
  assert.ok(seen.every((c) => c === true), `a restart said no Core on the way: ${JSON.stringify(seen)}`);
  await until(() => svc.getStatus().connected, "reconnected");
  // The manager switches an integration off with stop(), its settings untouched.
  svc.stop();
  assert.equal(svc.getStatus().configured, false);
  svc.configure(settings(), null);
  assert.equal(svc.getStatus().configured, true, "switched on again");
});

/** A selector plugin as a Core lists it: Button 1..N whatever its configured count, names only from Component.Get. */
function selector(): void {
  fake.components.set("Lobby_Source", [
    ...[1, 2, 3, 10].map((n) => ({ Name: `Button ${n}`, Type: "Boolean", Value: n === 1, String: String(n === 1), Position: n === 1 ? 1 : 0, Direction: "Read/Write", Legend: n <= 2 ? ["Stage", "Lectern"][n - 1] : "" })),
    { Name: "Label 1", Type: "Text", Value: "Stage", String: "Stage", Position: 0, Direction: "Read/Write" },
  ]);
}

test("a selector's buttons carry the names the Core draws on them, read with one Component.Get", { timeout: 20_000 }, async () => {
  selector();
  svc.configure(settings(), null);
  await until(() => svc.getCatalog() !== null, "catalog");
  const comp = svc.getCatalog()!.components.find((c) => c.name === "Lobby_Source")!;
  assert.deepEqual(
    comp.controls.map((c) => [c.Name, c.Legend]),
    [["Button 1", "Stage"], ["Button 2", "Lectern"], ["Button 3", ""], ["Button 10", ""], ["Label 1", undefined]],
  );
  assert.equal(comp.legendError, undefined);
  const gets = fake.received.filter((r) => r.method === "Component.Get");
  assert.equal(gets.length, 1, "one read per selector, none for a component without buttons");
  assert.deepEqual(gets[0]!.params, { Name: "Lobby_Source", Controls: ["Button 1", "Button 2", "Button 3", "Button 10"].map((Name) => ({ Name })) });
});

test("a Core that will not say its buttons' names still connects; the component says why, and /log has one line", { timeout: 20_000 }, async () => {
  selector();
  fake.failNext("Component.Get", 8);
  const warn = mock.method(console, "warn", () => {});
  try {
    svc.configure(settings(), null);
    await until(() => svc.getCatalog() !== null, "catalog");
    const comp = svc.getCatalog()!.components.find((c) => c.name === "Lobby_Source")!;
    assert.match(comp.legendError ?? "", /forced failure/);
    assert.ok(comp.controls.every((c) => c.Legend === undefined));
    const lines = warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("button names"));
    assert.deepEqual(lines.length, 1, lines.join("\n"));
    assert.match(lines[0]!, /^\[qsys\] could not read the button names of Lobby_Source/);
  } finally {
    warn.mock.restore();
  }
});
