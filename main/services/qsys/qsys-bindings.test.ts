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
const { checkBindings, panelsFromViews, QsysBindings, writeAddressesOf } = await import("./qsys-bindings.js");
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

  test("a numeric control that lists choices needs no range for a selector's choice list, and still does for a fader", () => {
    const withCombo: QsysCatalog = {
      ...CATALOG,
      components: [...CATALOG.components, { name: "Router", type: "router", controls: [{ ...ctl("source", "Float"), ValueMin: undefined, ValueMax: undefined, Choices: ["Mic", "Laptop"] } as never] }],
    };
    const allow = allowMap(entry("Router", "source", { min: null, max: null }));
    const selector: LayoutObjectConfig = { type: "qsys-selector", binding: bind("Router", "source"), items: [] };
    assert.deepEqual(checkBindings([view("p1", obj("s1", selector))], withCombo, allow), [], "a selector on a choice list was reported");
    assert.deepEqual(checkBindings([view("p1", obj("f1", fader(bind("Router", "source"))))], withCombo, allow), [
      { panelId: "p1", objectId: "f1", address: bind("Router", "source"), problem: "read-only" },
    ]);
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

// One table (slotsOf, main/types/qsys.ts) drives both the watch's addresses and the
// check, so they cannot disagree. What is left to hold is the table itself: every
// binding field of every type, with whether the object writes it.
describe("slotsOf: every binding of every Q-SYS object, and its role", () => {
  const A = (n: string) => bind("C", n);
  const B = (n: string) => ({ ...A(n), indicator: bind("I", n) });
  // A Record over every qsys-* type: a new type that is not listed here does not compile.
  type QsysType = Extract<LayoutObjectConfig["type"], `qsys-${string}`>;
  const FULL: Record<QsysType, LayoutObjectConfig> = {
    "qsys-fader": fader(B("a")),
    "qsys-meter": { type: "qsys-meter", binding: B("a"), binding2: B("b"), form: "bar" },
    "qsys-mute": { type: "qsys-mute", binding: B("a") },
    "qsys-button": { type: "qsys-button", binding: B("a"), label: "x", hold: false },
    "qsys-switch": { type: "qsys-switch", binding: B("a"), onBinding: B("b"), offBinding: B("c"), label: "x" },
    "qsys-presets": { type: "qsys-presets", items: [{ label: "1", binding: B("a") }, { label: "2", binding: B("b") }], previous: B("c") },
    "qsys-selector": { type: "qsys-selector", binding: B("a"), items: [{ label: "1", binding: B("b") }, { label: "2", binding: B("c") }] },
    "qsys-label": { type: "qsys-label", binding: B("a"), text: "" },
    "qsys-strip": { type: "qsys-strip", name: B("a"), label: "x", gain: B("b"), mute: B("c"), meter: B("d"), meter2: B("e") },
    "qsys-status": { type: "qsys-status" },
  };

  test("the Q-SYS object types, exactly", () => {
    assert.deepEqual(Object.keys(FULL).sort(), [
      "qsys-button",
      "qsys-fader",
      "qsys-label",
      "qsys-meter",
      "qsys-mute",
      "qsys-presets",
      "qsys-selector",
      "qsys-status",
      "qsys-strip",
      "qsys-switch",
    ]);
  });

  const ROLES: Record<QsysType, string[]> = {
    "qsys-fader": ["C/a write"],
    "qsys-meter": ["C/a read", "C/b read"],
    "qsys-mute": ["C/a write"],
    "qsys-button": ["C/a write"],
    "qsys-switch": ["C/a write", "C/b write", "C/c write"],
    "qsys-presets": ["C/a write", "C/b write", "C/c write"],
    "qsys-selector": ["C/a write", "C/b write", "C/c write"],
    "qsys-label": ["C/a read"],
    "qsys-strip": ["C/a read", "C/b write", "C/c write", "C/d read", "C/e read"],
    "qsys-status": [],
  };
  for (const [type, config] of Object.entries(FULL) as [QsysType, LayoutObjectConfig][]) {
    test(`${type}: its bindings and roles, exactly`, async () => {
      const { slotsOf } = await import("../../types/qsys.js");
      const got = slotsOf(config).flatMap(({ binding, role }) => (binding ? [`${binding.component}/${binding.control} ${role}`] : []));
      assert.deepEqual(got.sort(), ROLES[type]);
    });
  }
});

describe("panelsFromViews", () => {
  test("a view with Q-SYS objects is a panel, addresses deduped; a view without is not", () => {
    const panels = panelsFromViews([
      view("a", obj("f", fader(bind("Lobby_Mixer", "gain"))), obj("m", meter(bind("Lobby_Mixer", "gain")))),
      view("b", obj("x", { type: "container" } as LayoutObjectConfig)),
    ]);
    assert.deepEqual(panels, [{ id: "a", kind: "staff", addresses: [bind("Lobby_Mixer", "gain")] }]);
  });

  test("a panel's own kind picks its meter rate, and a panel with nothing on it yet is still a panel", () => {
    const block = (kind: "volunteer" | "staff", slug: string) => ({ kind, slug, siblings: [], returnAfterMin: 5 });
    const panels = panelsFromViews([
      { ...view("v", obj("f", fader(bind("Lobby_Mixer", "gain")))), qsys: block("volunteer", "zone-1") },
      { ...view("s", obj("f", fader(bind("Lobby_Mixer", "gain")))), qsys: block("staff", "zone-1-staff") },
      { ...view("e"), qsys: block("volunteer", "empty") },
    ]);
    assert.deepEqual(panels, [
      { id: "v", kind: "volunteer", addresses: [bind("Lobby_Mixer", "gain")] },
      { id: "s", kind: "staff", addresses: [bind("Lobby_Mixer", "gain")] },
      { id: "e", kind: "volunteer", addresses: [] },
    ]);
  });
});

describe("writeAddressesOf", () => {
  test("only the controls a panel writes: a strip's gain and mute, not its name, meter or an indicator", () => {
    const strip = { type: "qsys-strip", name: bind("M", "name"), label: "", gain: bind("M", "gain"), mute: { ...bind("M", "mute"), indicator: bind("M", "led") }, meter: bind("M", "meter") } as LayoutObjectConfig;
    assert.deepEqual(writeAddressesOf(view("p", obj("s", strip), obj("m", meter(bind("M", "meter2"))), obj("f", fader(bind("M", "gain"))))), [bind("M", "gain"), bind("M", "mute")]);
  });
});

describe("QsysBindings", () => {
  /** The report, or the reason there is none ("not-connected", "check-failed"). */
  const answer = (b: InstanceType<typeof QsysBindings>) => {
    const a = b.current();
    return "report" in a ? a.report : a.error;
  };
  const problems = (b: InstanceType<typeof QsysBindings>) => {
    const a = answer(b);
    return typeof a === "string" ? a : a.map((r) => r.problem);
  };
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
      assert.deepEqual(problems(h.b), ["not-allowed"]);

      h.setEntries([entry("Lobby_Mixer", "gain")]);
      h.on.allow();
      await h.b.refresh();
      assert.deepEqual(answer(h.b), [], "an allowlist save did not rerun the check");

      h.setViews([view("p2", obj("f", fader(bind("Lobby_Mixer", "mute"))))]);
      h.on.views();
      await h.b.refresh();
      assert.deepEqual((h.set.at(-1) as { id: string }[]).map((p) => p.id), ["p2"], "a views save did not rebuild the panels");

      h.setCatalog({ ...CATALOG, components: [] });
      h.on.catalog();
      await h.b.refresh();
      assert.deepEqual(problems(h.b), ["missing-component"], "a catalog read did not rerun the check");
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
    assert.equal(answer(h.b), "not-connected", "no Core: no report, so the route can say 503 rather than [] for all clear");
  });

  test("a report from an earlier connection is not served, and a reconnect says its problems again", async () => {
    const h = harness();
    const cap = lines();
    try {
      h.setViews([view("p1", obj("f1", fader(bind("Gone", "gain"))))]);
      await h.b.refresh();
      assert.equal(problems(h.b).length, 1);
      h.setCatalog(null);
      assert.equal(answer(h.b), "not-connected", "a stale report outlived the connection");
      // Nothing runs the check while the Core is away: the reconnect's catalog read is what does.
      h.setCatalog({ ...CATALOG });
      await h.b.refresh();
      assert.equal(cap.out.length, 2, "the new connection did not say the problem again");
      await h.b.refresh();
      assert.equal(cap.out.length, 2, "the same catalog said the problem twice");
    } finally {
      cap.restore();
    }
  });

  test("an unreadable views file serves no report (not the last one, not an empty one) and never says every binding resolves", async () => {
    const cap = lines();
    try {
      let broken = false;
      const b = new QsysBindings({
        getCatalog: () => CATALOG,
        onCatalog: () => {},
        loadViews: async () => {
          if (broken) throw new Error("views.json unreadable");
          return [view("p1", obj("f1", fader(bind("Gone", "gain"))))];
        },
        loadAllow: async () => [],
        onViewsSaved: () => {},
        onAllowSaved: () => {},
        setPanels: () => {},
      });
      await b.refresh();
      assert.equal(problems(b).length, 1);
      broken = true;
      await b.refresh();
      assert.equal(answer(b), "check-failed", "a report was served for a check that could not run");
      broken = false;
      await b.refresh();
      assert.equal(problems(b).length, 1, "a good run did not bring the report back");
      assert.ok(!cap.out.some((l) => l.includes("every binding resolves")), cap.out.join(" | "));
      assert.ok(cap.out.some((l) => l.startsWith("[qsys] binding check could not run")));
    } finally {
      cap.restore();
    }
  });

  test("settled() waits for a run in flight and starts none", async () => {
    const h = harness();
    await h.b.settled();
    assert.deepEqual(h.set, [], "settled() ran a check");
    h.setViews([view("p1", obj("f1", fader(bind("Gone", "gain"))))]);
    const run = h.b.refresh();
    await h.b.settled();
    assert.equal(problems(h.b).length, 1, "settled() returned before the run finished");
    await run;
    const n = h.set.length;
    await h.b.settled();
    assert.equal(h.set.length, n);
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
      assert.equal(answer(b), "check-failed", "a check that never ran served a report");
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
    // Not the real views store: reading it here would cache it, and "the real views
    // store" below needs it unread.
    writer.loadViews = async () => [];
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

describe("the real views store", () => {
  test("an unreadable views file stops the check instead of reading as no panels", async () => {
    // A directory where the file should be: a read that fails, as a permissions fault does.
    await fs.rm(path.join(TMP, "views.json"), { force: true });
    await fs.mkdir(path.join(TMP, "views.json"));
    const { qsysBindings } = await import("./qsys-bindings.js");
    const out: string[] = [];
    const m = mock.method(console, "warn", (...a: unknown[]) => void out.push(a.join(" ")));
    const e = mock.method(console, "error", () => {});
    try {
      await qsysBindings.refresh();
    } finally {
      m.mock.restore();
      e.mock.restore();
    }
    assert.ok(out.some((l) => l.startsWith("[qsys] binding check could not run")), `the failed read was not said: ${out.join(" | ")}`);
  });
});
