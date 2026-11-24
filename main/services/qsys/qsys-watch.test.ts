// Runs QsysWatch against a real QsysService talking to the fake Core. The fake
// enforces QRC's rules that matter here: four change groups per connection,
// Remove works on named controls only, an add resends the control's state, and
// groups die with the connection.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { addBroadcastListener, setNamedSubscriberCheck } from "../broadcaster.js";
import { addressKey, type PanelKind, type QsysAddress } from "../../types/qsys.js";
import { FakeQrcServer } from "./fake-qrc-server.js";
import type { QrcChange } from "./qrc-types.js";
import { QsysService } from "./qsys-service.js";
import type { QsysSettings } from "./qsys-settings.js";
import { isMeterControl, QsysWatch, REREAD_TIMEOUT_MS, watchChannel } from "./qsys-watch.js";

let fake: FakeQrcServer;
let port: number;
let svc: QsysService;
let watch: QsysWatch;

const named = new Set<string>();
/** This test's watch hears subscription changes from here, not the shared broadcaster,
 *  so a previous test's watch never reacts to this one's. */
let subscriptionListeners: (() => void)[] = [];
const onSubscriptions = (cb: () => void) => void subscriptionListeners.push(cb);
const subscriptionsChanged = () => {
  for (const cb of subscriptionListeners) cb();
};
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
  subscriptionListeners = [];
  svc = new QsysService();
  watch = new QsysWatch(svc, onSubscriptions);
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

for (const form of ["notify", "reply"] as const) {
  describe(`pushes as ${form}`, () => {
    beforeEach(() => {
      fake.autoPollForm = form;
    });

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

    test("unchanged demand sends nothing, and a pure addition sends only the new control's add", async () => {
      // Every subscribe anywhere in the app runs a recompute; it must cost the Core nothing.
      await connect();
      watch.setPanels([panel("a", "staff", GAIN, METER), panel("b", "staff", MUTE)]);
      await open("a");
      let mark = fake.received.length;
      subscriptionsChanged();
      await watch.recompute();
      await settle();
      assert.deepEqual(methods(mark).filter((m) => m.startsWith("ChangeGroup.")), [], "a recompute with unchanged demand touched the Core");
      mark = fake.received.length;
      await open("b");
      assert.deepEqual(
        fake.received.slice(mark).filter((r) => r.method.startsWith("ChangeGroup.")),
        [{ method: "ChangeGroup.AddComponentControl", params: { Id: "values", Component: { Name: "Lobby_Mixer", Controls: [{ Name: "mute" }] } } }],
        "adding one control rebuilt more than it added",
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
      const step = (fn: () => Promise<void>) => fn();
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
      // The fake's high-water mark sees a group that lived only inside one run.
      assert.ok(fake.maxGroups <= 3, `the Core held ${fake.maxGroups} change groups at once (QRC allows 4 per connection)`);
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

    test("opening a panel on a live connection keeps write readiness while its controls are added", async () => {
      await connect();
      watch.setPanels([panel("a", "staff", GAIN), panel("b", "staff", MUTE)]);
      await open("a");
      assert.equal(watch.ready(), true);
      named.add(watchChannel("b"));
      fake.holdReplies = true;
      const pending = watch.recompute();
      await until(() => methods().filter((m) => m === "ChangeGroup.AddComponentControl").length === 2, "second add sent");
      assert.equal(watch.ready(), true, "adding one panel's controls blocked writes on every panel");
      assert.equal(watch.current([MUTE]).size, 0, "a control with no value read yet was served");
      fake.holdReplies = false;
      await fake.dropClients();
      await pending;
    });

    test("after a reconnect, write readiness waits for the rebuild's Invalidate, and a retry gets there on its own", async () => {
      await connect();
      watch.setPanels([panel("a", "staff", GAIN)]);
      await open("a");
      await fake.dropClients();
      await until(() => svc.transport === null, "disconnect");
      fake.failNext("ChangeGroup.Invalidate", -32604);
      mock.timers.tick(3_000);
      await until(() => svc.transport !== null, "reconnected");
      // The catalog event runs the rebuild; a recompute() here would queue a second pass.
      await until(() => fake.received.some((r) => r.method === "ChangeGroup.Invalidate"), "refused Invalidate");
      await settle();
      assert.equal(watch.ready(), false, "ready() before the post-reconnect Invalidate was answered");
      mock.timers.tick(1_000);
      await until(() => watch.ready(), "retry completes the rebuild");
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

    test("a refusal on a live connection keeps readiness, logs, and retries on its own with a growing delay", async () => {
      await connect();
      watch.setPanels([panel("a", "staff", GAIN), panel("b", "volunteer", METER)]);
      await open("a");
      assert.equal(watch.ready(), true);
      const warn = mock.method(console, "warn", () => {});
      const retries = () => warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith("[qsys] change group update failed"));
      try {
        fake.failNext("ChangeGroup.AutoPoll", 5);
        fake.failNext("ChangeGroup.AutoPoll", 5);
        // One pass, from the subscription change alone.
        named.add(watchChannel("b"));
        subscriptionsChanged();
        await until(() => retries().length === 1, "refused update");
        await settle();
        assert.equal(watch.ready(), true, "one Core refusal on a live connection blocked every write");
        assert.equal(watch.current([GAIN]).size, 1, "a refusal for another group dropped a good value");
        assert.equal(retries().length, 1);
        assert.match(retries()[0], /retrying in 1 s$/);
        const mark = fake.received.length;
        // No subscription change: only the retry timer can bring the group back.
        mock.timers.tick(1_000);
        await until(() => retries().length === 2, "first retry, refused again");
        assert.match(retries()[1], /retrying in 2 s$/);
        assert.ok(methods(mark).includes("ChangeGroup.Destroy"), "the retry trusted a half-built group");
        mock.timers.tick(2_000);
        await until(() => liveGroups().get("meters-volunteer")?.rate === 0.1, "second retry builds the group");
        assert.equal(retries().length, 2);
        assert.equal(watch.ready(), true);
      } finally {
        warn.mock.restore();
      }
    });

    test("a pass queued while a run fails still runs", async () => {
      await connect();
      watch.setPanels([panel("a", "staff", GAIN), panel("b", "staff", MUTE)]);
      await watch.recompute(); // let setPanels' own pass finish, so the next run reads only "a"
      named.add(watchChannel("a"));
      fake.failNext("ChangeGroup.AutoPoll", 5);
      const warn = mock.method(console, "warn", () => {});
      try {
        const first = watch.recompute();
        named.add(watchChannel("b"));
        const second = watch.recompute();
        assert.equal(first, second);
        await second.catch(() => undefined);
        assert.deepEqual(membership(), ["Lobby_Mixer/gain@values", "Lobby_Mixer/mute@values"], "the queued pass was dropped with the failed one");
      } finally {
        warn.mock.restore();
      }
    });

    test("between a new DesignCode and the rebuild, nothing old is served and writes wait", async () => {
      // A source whose catalog events never reach the watch holds the window open.
      const quiet = {
        get transport() {
          return svc.transport;
        },
        get meterRates() {
          return svc.meterRates;
        },
        getCatalog: () => svc.getCatalog(),
        onCatalog: () => {},
      };
      subscriptionListeners = [];
      watch = new QsysWatch(quiet, onSubscriptions);
      await connect();
      watch.setPanels([panel("a", "staff", GAIN)]);
      await open("a");
      assert.equal(watch.ready(), true);
      fake.status = { ...fake.status, DesignCode: "design-2" };
      pushEngineStatus();
      await until(() => svc.getCatalog()?.designCode === "design-2", "design refresh");
      assert.equal(watch.ready(), false, "writes allowed against a design the groups have not caught up with");
      assert.equal(watch.current([GAIN]).size, 0, "a value from the old design was served");
      await watch.recompute();
      await until(() => watch.ready(), "the rebuilt group's values");
      assert.equal(watch.current([GAIN]).size, 1);
    });

    test("a design change while a failed update is pending destroys a group the watch had stopped tracking", async () => {
      await connect();
      watch.setPanels([panel("a", "staff", GAIN, MUTE)]);
      await open("a");
      const warn = mock.method(console, "warn", () => {});
      try {
        // Dropping MUTE rebuilds "values": the watch forgets the group, then the Core refuses its Destroy.
        fake.failNext("ChangeGroup.Destroy", -32604);
        // setPanels runs the one pass; a recompute() here would queue a second, which would repair it.
        watch.setPanels([panel("a", "staff", GAIN)]);
        await until(() => warn.mock.calls.length > 0, "refused Destroy");
        await settle();
        assert.deepEqual(membership(), ["Lobby_Mixer/gain@values", "Lobby_Mixer/mute@values"], "setup: the refused Destroy left the old group");
        // The design changes before the retry timer fires.
        fake.status = { ...fake.status, DesignCode: "design-2" };
        pushEngineStatus();
        await until(() => svc.getCatalog()?.designCode === "design-2", "design refresh");
        await watch.recompute();
        await settle();
        assert.deepEqual(membership(), ["Lobby_Mixer/gain@values"], "an old-design control stayed in a group nobody tracked");
      } finally {
        warn.mock.restore();
      }
    });

    test("a new connection starts the retry backoff over", async () => {
      await connect();
      watch.setPanels([panel("a", "staff", GAIN)]);
      const warn = mock.method(console, "warn", () => {});
      const retries = () => warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith("[qsys] change group update failed"));
      try {
        fake.failNext("ChangeGroup.AutoPoll", 5);
        fake.failNext("ChangeGroup.AutoPoll", 5);
        named.add(watchChannel("a"));
        subscriptionsChanged();
        await until(() => retries().length === 1, "first refusal");
        mock.timers.tick(1_000);
        await until(() => retries().length === 2, "second refusal");
        assert.match(retries()[1], /retrying in 2 s$/);
        await fake.dropClients();
        await until(() => svc.transport === null, "disconnect");
        fake.failNext("ChangeGroup.Invalidate", -32604);
        mock.timers.tick(3_000);
        await until(() => retries().length === 3, "refused rebuild on the new connection");
        assert.match(retries()[2], /retrying in 1 s$/, "the new connection inherited the old backoff, blocking writes longer");
        assert.equal(watch.ready(), false);
        mock.timers.tick(1_000);
        await until(() => watch.ready(), "retry after 1 s");
      } finally {
        warn.mock.restore();
      }
    });

    test("after a reconnect, writes wait until the Invalidate's resent values have arrived, not its reply", async () => {
      watch.setPanels([panel("a", "staff", GAIN)]);
      named.add(watchChannel("a"));
      fake.holdInvalidatePushes = true;
      await connect();
      await until(() => fake.received.some((r) => r.method === "ChangeGroup.Invalidate"), "Invalidate");
      await settle();
      assert.equal(watch.ready(), false, "ready() on the Invalidate's reply, before its values arrived");
      fake.releaseInvalidatePushes();
      await until(() => watch.ready(), "the resent values");
      assert.equal(watch.current([GAIN]).size, 1);
    });

    test("resent values that never come are asked for again, with a [qsys] line", async () => {
      watch.setPanels([panel("a", "staff", GAIN)]);
      named.add(watchChannel("a"));
      fake.holdInvalidatePushes = true;
      const warn = mock.method(console, "warn", () => {});
      try {
        await connect();
        await until(() => methods().includes("ChangeGroup.Invalidate"), "Invalidate");
        await settle();
        mock.timers.tick(REREAD_TIMEOUT_MS);
        await until(() => methods().filter((m) => m === "ChangeGroup.Invalidate").length === 2, "a second Invalidate");
        const lines = warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("has not resent the values"));
        assert.equal(lines.length, 1, "no [qsys] line for values that never came");
        assert.equal(watch.ready(), false);
        fake.holdInvalidatePushes = false;
        fake.releaseInvalidatePushes();
        await until(() => watch.ready(), "the resent values");
      } finally {
        warn.mock.restore();
      }
    });

    test("with no panel open there is nothing to read back: writes are ready once the catalog is read", async () => {
      await connect();
      assert.equal(watch.ready(), true);
      assert.deepEqual(methods().filter((m) => m.startsWith("ChangeGroup.")), []);
    });

    test("a component the Core will not add is dropped with one line; the rest is watched and writes are not blocked", async () => {
      watch.setPanels([panel("a", "staff", GAIN, ZONE_GAIN)]);
      named.add(watchChannel("a"));
      fake.failNext("ChangeGroup.AddComponentControl", 8);
      const warn = mock.method(console, "warn", () => {});
      try {
        await connect();
        await until(() => watch.ready(), "readiness on the fresh connection");
        assert.deepEqual(membership(), ["Zone 1/gain@values"]);
        await watch.recompute();
        subscriptionsChanged();
        await watch.recompute();
        const lines = warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("would not watch"));
        assert.equal(lines.length, 1, `expected one line, got ${JSON.stringify(lines)}`);
        assert.equal(methods().filter((m) => m === "ChangeGroup.AddComponentControl").length, 2, "the refused component was asked for again");
      } finally {
        warn.mock.restore();
      }
    });

    test("a push from the old connection after a reconnect never reaches the new connection's cache", async () => {
      await connect();
      watch.setPanels([panel("a", "staff", GAIN)]);
      await open("a");
      const old = svc.transport!;
      // The QrcClient under it, whose notification handlers the watch registered on.
      const oldClient = (svc as unknown as { client: { notify(m: string, p: unknown): void } }).client;
      await fake.dropClients();
      await until(() => svc.transport === null, "disconnect");
      mock.timers.tick(3_000);
      await until(() => svc.transport !== null && svc.transport !== old, "reconnected");
      await until(() => watch.ready(), "re-read");
      oldClient.notify("ChangeGroup.Poll", {
        Id: "values",
        Changes: [{ Component: "Lobby_Mixer", Name: "gain", Value: 99, String: "99dB", Position: 1 }],
      });
      assert.equal(watch.current([GAIN]).get(addressKey(GAIN))?.Value, -10, "the old connection's push was cached");
    });
  });
}

test("a recompute that joins a run as it finishes still gets its pass", async () => {
  // A stub Core: every request answers at once, so a run is a few microtasks long.
  const transport = { send: async () => true, onNotification: () => {}, close: () => {} };
  const catalog = { designCode: "d", components: [] };
  for (let hops = 0; hops < 40; hops++) {
    let reads = 0;
    let armed = true;
    let late: Promise<void> | null = null;
    const source = {
      transport,
      get meterRates() {
        reads++;
        if (armed) {
          armed = false;
          // Join the run this many microtasks before (or after) it ends.
          let p = Promise.resolve();
          for (let i = 0; i < hops; i++) p = p.then(() => undefined);
          late = p.then(() => {
            void w.recompute().catch(() => undefined);
          });
        }
        return { volunteerMeterHz: 10, staffMeterHz: 20 };
      },
      getCatalog: () => catalog,
      onCatalog: () => {},
    };
    const w = new QsysWatch(source, () => {});
    await w.recompute();
    await late;
    await settle();
    assert.equal(reads, 2, `a recompute ${hops} microtasks into the end of a run was dropped`);
  }
});

test("isMeterControl: meter components and controls named meter*", () => {
  assert.equal(isMeterControl("meter2", { Name: "x", Type: "Float" }), true);
  assert.equal(isMeterControl("gain", { Name: "meter_1", Type: "Float" }), true);
  assert.equal(isMeterControl("gain", { Name: "Meter 1", Type: "Float" }), true);
  assert.equal(isMeterControl("gain", { Name: "gain", Type: "Float" }), false);
  assert.equal(isMeterControl("mixer", { Name: "parameter", Type: "Float" }), false);
});
