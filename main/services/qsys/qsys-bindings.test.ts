// The binding check (pure), the panel wiring from Views to the watch, and the
// two-writers convergence run against the fake Core.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-bindings-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { addBroadcastListener, setNamedSubscriberCheck } = await import("../broadcaster.js");
const { FakeQrcServer } = await import("./fake-qrc-server.js");
const { QsysService } = await import("./qsys-service.js");
const { QsysWatch, watchChannel, QSYS_VALUES_CHANNEL } = await import("./qsys-watch.js");
const { QsysWriter } = await import("./qsys-write.js");
const { qsysAllowlist } = await import("./qsys-allowlist-store.js");
const { checkBindings, panelsFromViews, QsysBindings } = await import("./qsys-bindings.js");
const { addressKey } = await import("../../types/qsys.js");
type AllowEntry = import("./qsys-allowlist-store.js").AllowEntry;
type QsysCatalog = import("./qsys-service.js").QsysCatalog;
type View = import("../../types/views.js").View;
type LayoutObject = import("../../types/views.js").LayoutObject;
type LayoutObjectConfig = import("../../types/views.js").LayoutObjectConfig;
type QsysSettings = import("./qsys-settings.js").QsysSettings;
type QrcChange = import("./qrc-types.js").QrcChange;

after(() => fs.rm(TMP, { recursive: true, force: true }));

const bind = (component: string, control: string) => ({ component, control });

const ctl = (Name: string, Type: string, Direction = "Read/Write") => ({
  Name,
  Type,
  Value: 0,
  String: "0",
  Position: 0,
  Direction,
  ...(Type === "Float" ? { ValueMin: -100, ValueMax: 20 } : {}),
});

const CATALOG: QsysCatalog = {
  designCode: "d1",
  components: [
    { name: "Lobby_Mixer", type: "gain", controls: [ctl("gain", "Float"), ctl("mute", "Boolean"), ctl("locked", "Float", "Read"), ctl("norange", "Float")] },
    { name: "Zone 1", type: "meter", controls: [ctl("meter_1", "Float", "Read")] },
  ],
};

const entry = (component: string, control: string, over: Partial<AllowEntry> = {}): AllowEntry => ({
  component,
  control,
  label: `${component} ${control}`,
  min: -100,
  max: 0,
  confirm: "none",
  ...over,
});
const allowMap = (...es: AllowEntry[]) => new Map(es.map((e) => [addressKey(e), e]));

const obj = (id: string, config: LayoutObjectConfig, children?: LayoutObject[]): LayoutObject => ({ id, x: 0, y: 0, w: 0.1, h: 0.1, z: 0, config, ...(children ? { children } : {}) });
const view = (id: string, ...objects: LayoutObject[]): View =>
  ({ id, name: id, kind: "custom", createdAt: "2026-01-01", layout: { version: 1, canvas: {}, objects } }) as unknown as View;
const fader = (b: ReturnType<typeof bind> | null): LayoutObjectConfig => ({ type: "qsys-fader", binding: b, orientation: "vertical", showDb: true, steps: false, stepDb: 1 });
const meter = (b: ReturnType<typeof bind> | null): LayoutObjectConfig => ({ type: "qsys-meter", binding: b, form: "bar" });

describe("checkBindings", () => {
  test("reports a renamed component as missing-component", () => {
    const v = view("p1", obj("f1", fader(bind("Lobby_Mixer_Old", "gain"))));
    assert.deepEqual(checkBindings([v], CATALOG, allowMap(entry("Lobby_Mixer_Old", "gain"))), [
      { panelId: "p1", objectId: "f1", address: bind("Lobby_Mixer_Old", "gain"), problem: "missing-component" },
    ]);
  });

  test("reports a control the component lacks as missing-control", () => {
    const v = view("p1", obj("m1", meter(bind("Zone 1", "meter_9"))));
    assert.deepEqual(checkBindings([v], CATALOG, allowMap()).map((r) => r.problem), ["missing-control"]);
  });

  test("a fader bound to a non-allowlisted control is not-allowed; a meter on the same control is fine", () => {
    const v = view("p1", obj("f1", fader(bind("Lobby_Mixer", "gain"))), obj("m1", meter(bind("Lobby_Mixer", "gain"))));
    assert.deepEqual(checkBindings([v], CATALOG, allowMap()), [
      { panelId: "p1", objectId: "f1", address: bind("Lobby_Mixer", "gain"), problem: "not-allowed" },
    ]);
    assert.deepEqual(checkBindings([v], CATALOG, allowMap(entry("Lobby_Mixer", "gain"))), []);
  });

  test("a write object on a read-only control, or a number with no range, is read-only", () => {
    const v = view("p1", obj("a", fader(bind("Lobby_Mixer", "locked"))), obj("b", fader(bind("Lobby_Mixer", "norange"))));
    const report = checkBindings([v], CATALOG, allowMap(entry("Lobby_Mixer", "locked"), entry("Lobby_Mixer", "norange", { min: null, max: null })));
    assert.deepEqual(report.map((r) => `${r.objectId} ${r.problem}`), ["a read-only", "b read-only"]);
  });

  test("a boolean with no range is writable", () => {
    const v = view("p1", obj("mu", { type: "qsys-mute", binding: bind("Lobby_Mixer", "mute") }));
    assert.deepEqual(checkBindings([v], CATALOG, allowMap(entry("Lobby_Mixer", "mute", { min: null, max: null }))), []);
  });

  test("an indicator only has to exist; a strip's name and meter are read, its gain and mute written", () => {
    const strip = obj("s", {
      type: "qsys-strip",
      name: bind("Lobby_Mixer", "gain"),
      label: "x",
      gain: bind("Lobby_Mixer", "gain"),
      mute: bind("Lobby_Mixer", "mute"),
      meter: bind("Zone 1", "meter_1"),
    });
    const withIndicator = obj("b", { type: "qsys-button", binding: { ...bind("Lobby_Mixer", "mute"), indicator: bind("Zone 1", "meter_1") }, label: "x", hold: false });
    const report = checkBindings([view("p", strip, withIndicator)], CATALOG, allowMap(entry("Lobby_Mixer", "gain"), entry("Lobby_Mixer", "mute", { min: null, max: null })));
    assert.deepEqual(report, []);
    // Take the writes off the allowlist: gain, mute and the button's own control fail; name, meter and indicator do not.
    assert.deepEqual(
      checkBindings([view("p", strip, withIndicator)], CATALOG, allowMap()).map((r) => `${r.objectId} ${r.address.control} ${r.problem}`),
      ["s gain not-allowed", "s mute not-allowed", "b mute not-allowed"],
    );
  });

  test("objects nested in a container are checked, and unbound ones are skipped", () => {
    const inner = obj("f", fader(bind("Gone", "gain")));
    const v = view("p", obj("box", { type: "container" } as LayoutObjectConfig, [inner, obj("u", fader(null))]));
    assert.deepEqual(checkBindings([v], CATALOG, allowMap()).map((r) => r.objectId), ["f"]);
  });

  test("with no catalog there is nothing to check against", () => {
    assert.deepEqual(checkBindings([view("p", obj("f", fader(bind("Gone", "gain"))))], null, allowMap()), []);
  });
});

describe("panelsFromViews", () => {
  test("a view with Q-SYS objects is a panel, addresses deduped; a view without is not", () => {
    const panels = panelsFromViews([
      view("a", obj("f", fader(bind("Lobby_Mixer", "gain"))), obj("m", meter(bind("Lobby_Mixer", "gain")))),
      view("b", obj("x", { type: "container" } as LayoutObjectConfig)),
    ]);
    assert.deepEqual(panels, [{ id: "a", kind: "staff", addresses: [bind("Lobby_Mixer", "gain")] }]);
  });
});

describe("QsysBindings", () => {
  function harness() {
    let views: View[] = [];
    let entries: AllowEntry[] = [];
    let catalog: QsysCatalog | null = CATALOG;
    const set: unknown[] = [];
    const on: Record<string, () => void> = {};
    const b = new QsysBindings({
      getCatalog: () => catalog,
      onCatalog: (cb) => void (on.catalog = () => cb(CATALOG)),
      loadViews: async () => views,
      loadAllow: async () => entries,
      onViewsSaved: (cb) => void (on.views = cb),
      onAllowSaved: (cb) => void (on.allow = cb),
      setPanels: (p) => void set.push(p),
    });
    return { b, set, on, setViews: (v: View[]) => (views = v), setEntries: (e: AllowEntry[]) => (entries = e), setCatalog: (c: QsysCatalog | null) => (catalog = c) };
  }
  function lines() {
    const out: string[] = [];
    const m = mock.method(console, "warn", (...a: unknown[]) => void out.push(a.join(" ")));
    const l = mock.method(console, "log", (...a: unknown[]) => void out.push(a.join(" ")));
    return { out, restore: () => (m.mock.restore(), l.mock.restore()) };
  }

  test("an unchanged report logs nothing the second time; a new problem logs only itself; a fix says so", async () => {
    const h = harness();
    const cap = lines();
    try {
      h.setViews([view("p1", obj("f1", fader(bind("Gone", "gain"))))]);
      await h.b.refresh();
      assert.deepEqual(cap.out, ["[qsys] binding: p1/f1 missing-component (Gone/gain)"]);
      await h.b.refresh();
      assert.equal(cap.out.length, 1, "an unchanged report logged again");
      h.setViews([view("p1", obj("f1", fader(bind("Gone", "gain"))), obj("f2", fader(bind("Lobby_Mixer", "gain"))))]);
      await h.b.refresh();
      assert.deepEqual(cap.out.slice(1), ["[qsys] binding: p1/f2 not-allowed (Lobby_Mixer/gain)"]);
      h.setViews([]);
      await h.b.refresh();
      assert.equal(cap.out.at(-1), "[qsys] binding check: every binding resolves");
    } finally {
      cap.restore();
    }
  });

  test("a hostile object id cannot forge a line", async () => {
    const h = harness();
    const cap = lines();
    try {
      h.setViews([view("p1", obj("x\n[qsys] FORGED", fader(bind("Gone", "gain"))))]);
      await h.b.refresh();
      assert.equal(cap.out.length, 1);
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(cap.out[0], /[\u0000-\u001f]/);
    } finally {
      cap.restore();
    }
  });

  test("start() hands the watch the panels, and a views save, a catalog read and an allowlist save each rerun it", async () => {
    const h = harness();
    const cap = lines();
    try {
      h.setViews([view("p1", obj("f1", fader(bind("Lobby_Mixer", "gain"))))]);
      h.b.start();
      h.b.start();
      await h.b.refresh();
      assert.deepEqual(h.set.at(-1), [{ id: "p1", kind: "staff", addresses: [bind("Lobby_Mixer", "gain")] }]);
      const startedWith = h.set.length;
      assert.deepEqual(h.b.current().map((r) => r.problem), ["not-allowed"]);

      h.setEntries([entry("Lobby_Mixer", "gain")]);
      h.on.allow();
      await h.b.refresh();
      assert.deepEqual(h.b.current(), [], "an allowlist save did not rerun the check");

      h.setViews([view("p2", obj("f", fader(bind("Lobby_Mixer", "mute"))))]);
      h.on.views();
      await h.b.refresh();
      assert.deepEqual((h.set.at(-1) as { id: string }[]).map((p) => p.id), ["p2"], "a views save did not rebuild the panels");

      h.setCatalog({ ...CATALOG, components: [] });
      h.on.catalog();
      await h.b.refresh();
      assert.deepEqual(h.b.current().map((r) => r.problem), ["missing-component"], "a catalog read did not rerun the check");
      assert.ok(h.set.length > startedWith);
    } finally {
      cap.restore();
    }
  });

  test("a view with no Q-SYS objects leaves the watch with no panels, even with no catalog", async () => {
    const h = harness();
    h.setCatalog(null);
    h.setViews([view("p1", obj("x", { type: "container" } as LayoutObjectConfig))]);
    await h.b.refresh();
    assert.deepEqual(h.set.at(-1), []);
    assert.deepEqual(h.b.current(), []);
  });

  test("a failed read says so and does not throw", async () => {
    const cap = lines();
    try {
      const b = new QsysBindings({
        getCatalog: () => CATALOG,
        onCatalog: () => {},
        loadViews: async () => {
          throw new Error("disk\nFORGED");
        },
        loadAllow: async () => [],
        onViewsSaved: () => {},
        onAllowSaved: () => {},
        setPanels: () => {},
      });
      await b.refresh();
      assert.equal(cap.out.length, 1);
      assert.match(cap.out[0], /^\[qsys\] binding check could not run: /);
    } finally {
      cap.restore();
    }
  });
});

describe("two writers converge", () => {
  let fake: InstanceType<typeof FakeQrcServer>;
  let svc: InstanceType<typeof QsysService>;
  let watch: InstanceType<typeof QsysWatch>;
  const named = new Set<string>();
  const sent: { channel: string; changes: QrcChange[] }[] = [];
  const GAIN = bind("Lobby_Mixer", "gain");
  /** This test's watch hears subscription changes from here, not the shared broadcaster. */
  let subscriptionListeners: (() => void)[] = [];
  const subscriptionsChanged = () => {
    for (const cb of subscriptionListeners) cb();
  };

  before(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    setNamedSubscriberCheck((ch) => named.has(ch));
    addBroadcastListener((channel, payload) => {
      if (channel === QSYS_VALUES_CHANNEL) sent.push({ channel, changes: (payload as { changes: QrcChange[] }).changes });
    });
  });
  after(() => {
    mock.timers.reset();
    setNamedSubscriberCheck(() => false);
  });
  beforeEach(async () => {
    sent.length = 0;
    fake = new FakeQrcServer();
    fake.components.set("Lobby_Mixer", [
      { Name: "gain", Type: "Float", Value: -10, String: "-10dB", Position: 0.5, Direction: "Read/Write", ValueMin: -100, ValueMax: 20 },
    ]);
    const port = await fake.start();
    svc = new QsysService();
    subscriptionListeners = [];
    watch = new QsysWatch(svc, (cb) => void subscriptionListeners.push(cb));
    await qsysAllowlist.replace([entry("Lobby_Mixer", "gain", { min: -100, max: 20 })]);
    const settings: QsysSettings = { host: "127.0.0.1", port, user: "", enabled: true, volunteerMeterHz: 10, staffMeterHz: 20 };
    svc.configure(settings, null);
    for (let i = 0; i < 200000 && !svc.transport; i++) await new Promise((r) => setImmediate(r));
    await watch.recompute();
  });
  afterEach(async () => {
    svc.stop();
    await fake.stop();
  });
  const settle = async () => {
    for (let i = 0; i < 2000; i++) await new Promise((r) => setImmediate(r));
  };

  test("a UCI change after an iPad write reaches qsys:values and the cache", async () => {
    watch.setPanels([{ id: "p", kind: "staff", addresses: [GAIN] }]);
    named.add(watchChannel("p"));
    subscriptionsChanged();
    await watch.recompute();
    await settle();

    const writer = new QsysWriter(svc, watch);
    const wrote = await writer.write({ component: "Lobby_Mixer", control: "gain", value: -5, panelId: "p", device: "ipad", remote: "192.0.2.10" });
    assert.equal(wrote.ok, true);
    await settle();
    assert.equal(watch.current([GAIN]).get(addressKey(GAIN))?.Value, -5, "the iPad's write did not reach the cache");

    sent.length = 0;
    fake.setControl("Lobby_Mixer", "gain", -2);
    await settle();
    assert.deepEqual(sent.map((s) => s.changes.map((c) => c.Value)), [[-2]], "the UCI's value was not broadcast");
    assert.equal(watch.current([GAIN]).get(addressKey(GAIN))?.Value, -2, "the cache kept the iPad's value");
  });
});
