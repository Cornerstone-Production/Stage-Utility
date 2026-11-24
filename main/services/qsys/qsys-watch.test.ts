// Runs QsysWatch against a real QsysService talking to the fake Core. The fake
// enforces QRC's rules that matter here: four change groups per connection,
// Remove works on named controls only, an add resends the control's state, and
// groups die with the connection.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { addBroadcastListener, setNamedSubscriberCheck, subscriptionsChanged } from "../broadcaster.js";
import { addressKey, type PanelKind, type QsysAddress } from "../../types/qsys.js";
import { FakeQrcServer } from "./fake-qrc-server.js";
import type { QrcChange } from "./qrc-types.js";
import { QsysService } from "./qsys-service.js";
import type { QsysSettings } from "./qsys-settings.js";
import { isMeterControl, QsysWatch, watchChannel } from "./qsys-watch.js";

let fake: FakeQrcServer;
let port: number;
let svc: QsysService;
let watch: QsysWatch;

const named = new Set<string>();
const sent: { channel: string; changes: QrcChange[] }[] = [];
addBroadcastListener((channel, payload) => {
  if (channel.startsWith("qsys:") && channel !== "qsys:status") sent.push({ channel, changes: (payload as { changes: QrcChange[] }).changes });
});

const settings = (over: Partial<QsysSettings> = {}): QsysSettings => ({
  host: "127.0.0.1",
  port,
  user: "",
  enabled: true,
  volunteerMeterHz: 10,
  staffMeterHz: 20,
  ...over,
});

const GAIN: QsysAddress = { component: "Lobby_Mixer", control: "gain" };
const MUTE: QsysAddress = { component: "Lobby_Mixer", control: "mute" };
const METER: QsysAddress = { component: "Zone 1", control: "meter_1" };
const METER2: QsysAddress = { component: "Zone 1", control: "meter_2" };
const ZONE_GAIN: QsysAddress = { component: "Zone 1", control: "gain" };

before(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  setNamedSubscriberCheck((ch) => named.has(ch));
});
after(() => {
  mock.timers.reset();
  setNamedSubscriberCheck(() => false);
});

beforeEach(async () => {
  named.clear();
  sent.length = 0;
  fake = new FakeQrcServer();
  fake.components.set("Lobby_Mixer", [
    { Name: "gain", Type: "Float", Value: -10, String: "-10dB", Position: 0.5, Direction: "Read/Write", ValueMin: -100, ValueMax: 20 },
    { Name: "mute", Type: "Boolean", Value: false, String: "false", Position: 0, Direction: "Read/Write" },
  ]);
  fake.components.set("Zone 1", [
    { Name: "gain", Type: "Float", Value: 0, String: "0dB", Position: 0.8, Direction: "Read/Write", ValueMin: -100, ValueMax: 20 },
    { Name: "meter_1", Type: "Float", Value: -40, String: "-40dB", Position: 0.5, Direction: "Read" },
    { Name: "meter_2", Type: "Float", Value: -50, String: "-50dB", Position: 0.4, Direction: "Read" },
  ]);
  port = await fake.start();
  svc = new QsysService();
  watch = new QsysWatch(svc);
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
  for (let i = 0; i < 2000; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}; fake saw ${fake.received.map((r) => r.method).join(",")}`);
}

async function connect(over: Partial<QsysSettings> = {}): Promise<void> {
  svc.configure(settings(over), null);
  await until(() => svc.transport !== null, "connected");
  await watch.recompute();
}

/** Open a panel the way a page does: name its demand channel, then let the watch catch up. */
async function open(...ids: string[]): Promise<void> {
  for (const id of ids) named.add(watchChannel(id));
  subscriptionsChanged();
  await watch.recompute();
  await settle();
}

async function close(...ids: string[]): Promise<void> {
  for (const id of ids) named.delete(watchChannel(id));
  subscriptionsChanged();
  await watch.recompute();
  await settle();
}

function panel(id: string, kind: PanelKind, ...addresses: QsysAddress[]) {
  return { id, kind, addresses };
}

type FakeGroup = { controls: Set<string>; rate: number | null };
/** The fake Core's live change groups, for the one connection the service holds. */
function liveGroups(): Map<string, FakeGroup> {
  const sessions = [...(fake["sessions"] as Set<{ groups: Map<string, FakeGroup> }>)];
  assert.equal(sessions.length, 1, "expected exactly one QRC connection");
  return sessions[0].groups;
}

/** Every key the Core has in any group, sorted, as "Component/control@group". */
function membership(): string[] {
  const out: string[] = [];
  for (const [id, g] of liveGroups()) for (const k of g.controls) out.push(`${k.replace("\u0000", "/")}@${id}`);
  return out.sort();
}

const methods = (from = 0): string[] => fake.received.slice(from).map((r) => r.method);
const autoPollRates = (from = 0): number[] =>
  fake.received.slice(from).filter((r) => r.method === "ChangeGroup.AutoPoll").map((r) => (r.params as { Rate: number }).Rate);

test("only controls of panels whose qsys:watch:<id> channel is named by a client are added", async () => {
  await connect();
  watch.setPanels([panel("a", "staff", GAIN), panel("b", "staff", MUTE)]);
  await watch.recompute();
  assert.equal(methods().filter((m) => m.startsWith("ChangeGroup.")).length, 0, "nothing is open, yet a change group was touched");
  await open("a");
  assert.deepEqual(membership(), ["Lobby_Mixer/gain@values"]);
  await open("b");
  assert.deepEqual(membership(), ["Lobby_Mixer/gain@values", "Lobby_Mixer/mute@values"]);
});

test("closing the last panel that uses a control removes it; no panels = groups cleared, no AutoPoll", async () => {
  await connect();
  watch.setPanels([panel("a", "staff", GAIN, MUTE, METER), panel("b", "staff", GAIN)]);
  await open("a", "b");
  assert.deepEqual(membership(), ["Lobby_Mixer/gain@values", "Lobby_Mixer/mute@values", "Zone 1/meter_1@meters-staff"]);
  assert.equal(watch.current([MUTE]).size, 1);
  await close("a");
  assert.deepEqual(membership(), ["Lobby_Mixer/gain@values"], "a control no open panel uses is still watched");
  assert.equal(watch.current([MUTE]).size, 0, "the cache still serves a control nobody watches, which will go stale");
  assert.ok(!methods().includes("ChangeGroup.Remove"), "QRC's Remove is named-controls only; it cannot remove a component control");
  const mark = fake.received.length;
  await close("b");
  assert.equal(liveGroups().size, 0, "with no panels open the Core still holds a change group (and its AutoPoll)");
  assert.deepEqual(autoPollRates(mark), [], "an AutoPoll was started with no panels open");
  assert.equal(watch.current([GAIN]).size, 0);
});

test("volunteer meters poll at 1/volunteerMeterHz, staff meters at 1/staffMeterHz, values at the faster active rate", async () => {
  await connect();
  watch.setPanels([panel("vol", "volunteer", GAIN, METER), panel("staff", "staff", MUTE, METER2)]);
  await open("vol");
  assert.deepEqual(
    [...liveGroups()].map(([id, g]) => `${id}@${g.rate}`).sort(),
    ["meters-volunteer@0.1", "values@0.1"],
    "a volunteer-only setup polls at the staff rate",
  );
  await open("staff");
  assert.deepEqual([...liveGroups()].map(([id, g]) => `${id}@${g.rate}`).sort(), ["meters-staff@0.05", "meters-volunteer@0.1", "values@0.05"]);
  assert.deepEqual([...new Set(autoPollRates())].sort(), [0.05, 0.1]);
  // The values group dropped back when the staff panel closed.
  await close("staff");
  assert.deepEqual([...liveGroups()].map(([id, g]) => `${id}@${g.rate}`).sort(), ["meters-volunteer@0.1", "values@0.1"]);
});

test("rates follow the settings: a volunteer rate of 5 polls every 0.2 s", async () => {
  await connect({ volunteerMeterHz: 5, staffMeterHz: 25 });
  watch.setPanels([panel("vol", "volunteer", METER), panel("staff", "staff", METER2)]);
  await open("vol", "staff");
  assert.deepEqual([...liveGroups()].map(([id, g]) => `${id}@${g.rate}`).sort(), ["meters-staff@0.04", "meters-volunteer@0.2"]);
});

test("a meter on both a volunteer and a staff panel goes in the staff group only, and reaches both channels", async () => {
  await connect();
  watch.setPanels([panel("vol", "volunteer", METER), panel("staff", "staff", METER)]);
  await open("vol", "staff");
  assert.deepEqual(membership(), ["Zone 1/meter_1@meters-staff"]);
  sent.length = 0;
  fake.setControl("Zone 1", "meter_1", -12);
  await settle();
  assert.deepEqual(
    sent.map((s) => s.channel).sort(),
    ["qsys:meters:staff", "qsys:meters:volunteer"],
    "a volunteer panel showing a meter that rides the staff group never hears it",
  );
});

test("never uses more than 3 change groups", async () => {
  await connect();
  watch.setPanels([
    panel("v1", "volunteer", GAIN, METER),
    panel("v2", "volunteer", MUTE, METER2),
    panel("s1", "staff", ZONE_GAIN, METER),
    panel("s2", "staff", METER2),
  ]);
  let most = 0;
  const step = async (fn: () => Promise<void>) => {
    await fn();
    most = Math.max(most, liveGroups().size);
  };
  await step(() => open("v1"));
  await step(() => open("s1"));
  await step(() => open("v2"));
  await step(() => open("s2"));
  await step(() => close("s1"));
  await step(() => open("s1"));
  await step(() => close("v1", "v2"));
  await step(() => open("v1"));
  fake.status = { ...fake.status, DesignCode: "design-2" };
  pushEngineStatus();
  await until(() => svc.getCatalog()?.designCode === "design-2", "design refresh");
  await step(() => watch.recompute());
  assert.ok(most <= 3, `the Core held ${most} change groups at once (QRC allows 4 per connection)`);
});

test("changes broadcast on the right channel with only the changed controls", async () => {
  await connect();
  watch.setPanels([panel("vol", "volunteer", GAIN, MUTE, METER), panel("staff", "staff", METER2)]);
  await open("vol", "staff");
  sent.length = 0;
  fake.setControl("Lobby_Mixer", "gain", -3);
  await settle();
  assert.deepEqual(sent, [{ channel: "qsys:values", changes: [{ Component: "Lobby_Mixer", Name: "gain", Value: -3, String: "-3dB", Position: 97 / 120 }] }]);
  sent.length = 0;
  fake.setControl("Zone 1", "meter_1", -20);
  fake.setControl("Zone 1", "meter_2", -30);
  await settle();
  assert.deepEqual(
    sent.map((s) => `${s.channel} ${s.changes.map((c) => c.Name).join(",")}`).sort(),
    ["qsys:meters:staff meter_2", "qsys:meters:volunteer meter_1"],
  );
  // An Invalidate resends every control; nothing that did not change goes out.
  sent.length = 0;
  for (const id of liveGroups().keys()) await svc.transport!.send("ChangeGroup.Invalidate", { Id: id });
  await settle();
  assert.deepEqual(sent, [], "an unchanged value was broadcast");
  assert.equal(watch.current([GAIN]).get(addressKey(GAIN))?.Value, -3, "the hydration cache missed a change");
});

test("a control the Core's catalog lacks is skipped with one [qsys] line, and its component's other controls still watched", async () => {
  await connect();
  const warn = mock.method(console, "warn", () => {});
  try {
    const gone: QsysAddress = { component: "Lobby_Mixer", control: "no_such" };
    watch.setPanels([panel("a", "staff", GAIN, gone)]);
    await open("a");
    await watch.recompute();
    assert.deepEqual(membership(), ["Lobby_Mixer/gain@values"]);
    const lines = warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("no_such"));
    assert.equal(lines.length, 1, `expected one skip line, got ${JSON.stringify(lines)}`);
    assert.ok(lines[0].startsWith("[qsys]"));
    assert.equal(watch.ready(), true, "a skipped address blocks readiness forever");
  } finally {
    warn.mock.restore();
  }
});

test("after a reconnect the groups are rebuilt, Invalidate resends values, and nothing stale is served meanwhile", async () => {
  await connect();
  watch.setPanels([panel("a", "staff", GAIN, METER)]);
  await open("a");
  assert.equal(watch.ready(), true);
  assert.equal(watch.current([GAIN, METER]).size, 2);

  // The Core changes while the connection is down: the old value must never come back.
  await fake.dropClients();
  await until(() => svc.transport === null, "disconnect");
  assert.equal(watch.ready(), false, "ready() stayed true with no connection");
  assert.equal(watch.current([GAIN]).size, 0, "the value cache outlived its connection");
  fake.components.get("Lobby_Mixer")![0].Value = 6;
  fake.components.get("Lobby_Mixer")![0].String = "6dB";

  const mark = fake.received.length;
  mock.timers.tick(3_000);
  await until(() => svc.transport !== null, "reconnected");
  await watch.recompute();
  await settle();

  const after = methods(mark);
  assert.ok(!after.includes("ChangeGroup.Destroy"), "a Destroy was sent for groups that died with the old connection");
  assert.ok(after.includes("ChangeGroup.AddComponentControl"));
  assert.ok(after.includes("ChangeGroup.Invalidate"), "no Invalidate after a reconnect");
  assert.deepEqual(membership(), ["Lobby_Mixer/gain@values", "Zone 1/meter_1@meters-staff"]);
  assert.equal(watch.ready(), true);
  assert.equal(watch.current([GAIN]).get(addressKey(GAIN))?.Value, 6, "the value was not re-read after the reconnect");
});

test("ready() stays false until the rebuilt groups have answered", async () => {
  await connect();
  watch.setPanels([panel("a", "staff", GAIN)]);
  named.add(watchChannel("a"));
  fake.holdReplies = true;
  const pending = watch.recompute();
  await until(() => methods().includes("ChangeGroup.AddComponentControl"), "group add sent");
  assert.equal(watch.ready(), false, "ready() while the group add is unanswered");
  fake.holdReplies = false;
  await fake.dropClients();
  await pending;
  assert.equal(watch.ready(), false);
});

test("a new DesignCode on the same connection destroys and rebuilds the groups and drops vanished controls", async () => {
  await connect();
  watch.setPanels([panel("a", "staff", GAIN, MUTE)]);
  await open("a");
  const mark = fake.received.length;
  fake.components.set("Lobby_Mixer", [
    { Name: "gain", Type: "Float", Value: -20, String: "-20dB", Position: 0.3, Direction: "Read/Write", ValueMin: -100, ValueMax: 20 },
  ]);
  fake.status = { ...fake.status, DesignCode: "design-2" };
  pushEngineStatus();
  await until(() => svc.getCatalog()?.designCode === "design-2", "design refresh");
  await watch.recompute();
  await settle();
  const after = methods(mark);
  assert.ok(after.includes("ChangeGroup.Destroy"), "the old design's groups were left on the Core");
  assert.ok(after.includes("ChangeGroup.Invalidate"), "no Invalidate after a design change");
  assert.deepEqual(membership(), ["Lobby_Mixer/gain@values"]);
  assert.equal(watch.current([GAIN]).get(addressKey(GAIN))?.Value, -20);
  assert.equal(watch.current([MUTE]).size, 0, "a control the new design lacks is still served from the cache");
  assert.equal(watch.ready(), true);
});

test("a refusal from the Core rejects recompute, leaves ready() false, and the next run rebuilds from nothing", async () => {
  await connect();
  watch.setPanels([panel("a", "staff", GAIN)]);
  named.add(watchChannel("a"));
  fake.failNext("ChangeGroup.AutoPoll", 5);
  await assert.rejects(watch.recompute(), (err: unknown) => (err as { code?: number }).code === 5);
  assert.equal(watch.current([GAIN]).size, 1, "the add's resend should have been cached");
  assert.equal(watch.ready(), false, "ready() after the Core refused part of the rebuild");
  const mark = fake.received.length;
  await watch.recompute();
  await settle();
  const after = methods(mark);
  assert.ok(after.includes("ChangeGroup.Destroy"), "the half-built group was trusted, not rebuilt");
  assert.deepEqual(autoPollRates(mark), [0.05], "the retried group never got its AutoPoll");
  assert.equal(watch.ready(), true);
});

test("isMeterControl: meter components and controls named meter*", () => {
  assert.equal(isMeterControl("meter2", { Name: "x", Type: "Float" }), true);
  assert.equal(isMeterControl("gain", { Name: "meter_1", Type: "Float" }), true);
  assert.equal(isMeterControl("gain", { Name: "Meter 1", Type: "Float" }), true);
  assert.equal(isMeterControl("gain", { Name: "gain", Type: "Float" }), false);
  assert.equal(isMeterControl("mixer", { Name: "parameter", Type: "Float" }), false);
});
