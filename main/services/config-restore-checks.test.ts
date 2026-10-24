// A config restore is checked like a save, and refused whole if any file fails.
//
// POST /api/config/import writes each store's file whole, and any device on the
// LAN can post one. Before every store declared a restore check, a crafted
// backup could put there what the settings routes refuse — a video feed whose
// address is `file:/etc/passwd`. These run the real apply() against a real data
// directory: a refused restore must leave every file as it was, and a backup
// this app made must come back unchanged.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restore-checks-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot, configFiles, RestoreRefusedError } = await import("./config-snapshot.js");
const { DEFAULT_VIDEO_PORTS } = await import("../types/video.js");

const LAYOUT = { objects: [], canvas: { width: 1920, height: 1080 } };

/** One value per config store that its settings routes would save, as the file holds it. */
const GOOD: Record<string, unknown> = {
  "automation-rules.json": [
    {
      id: "r1",
      name: "Lights off",
      enabled: false,
      trigger: { id: "call.by-name", params: { name: "lights_off" } },
      conditions: [],
      action: { id: "rosstalk.command", params: {} },
      cooldownSec: 0,
      oncePerService: false,
    },
  ],
  "automation-settings.json": { simulate: true, disarmed: false },
  "baptism-triggers.json": { "plan-1": { testimonyItemId: "item-1", baptismItemId: null } },
  "bar-config.json": { items: ["clock"], mobileItems: [], schema: 1 },
  "history-milestones.json": [{ id: "m1", date: "2026-01-04", label: "Launch", serviceTypeId: null }],
  "host-names.json": { accepted: [{ name: "stage.example.org", source: "added", at: "2026-10-01T00:00:00.000Z" }], dismissed: [] },
  "kiosk-devices.json": [{ id: "dev-1", token: "", outputId: "1", label: "Pi", macs: [] }],
  "layout-groups.json": [{ id: "g1", name: "Header", object: { id: "o1", type: "text" } }],
  "layout-templates.json": [{ id: "t1", name: "Blank", layout: LAYOUT }],
  "messaging.json": { version: 2, groups: [{ id: "g-0a1b2c3d", name: "Band" }], quickMessages: ["Go"], quickReplies: ["OK"] },
  "notes.json": { "obj-1": { text: "Bring the spare pack" } },
  "osc-targets.json": [{ id: "o1", name: "Board", enabled: false, config: { host: "192.0.2.5", port: 8000 } }],
  "patch.json": {
    sheets: [
      { id: "analog", name: "Analog", kind: "analog", devices: [], endpoints: [], variants: [], assignments: { byServiceType: {}, byPlan: {} } },
    ],
    updatedAt: "",
  },
  "presets.json": [{ id: "p1", name: "Sunday", slots: [] }],
  "rosstalk-settings.json": { simulate: true },
  "rosstalk-targets.json": [{ id: "rt1", name: "Carbonite", enabled: false, config: { port: 7788, family: "carbonite" } }],
  "saved-colors.json": ["#ff0000"],
  "scores-favourites.json": { favourites: [{ league: "nfl", teamId: "16" }] },
  "servicecue-config.json": { serviceTypeIds: ["123"] },
  "servicecue-layouts.json": [{ id: "l1", name: "Default", order: 0, columnRoles: ["role-audio"] }],
  "servicecue-publish.json": { enabled: false, url: "https://cue.example.org" },
  "servicecue-roles.json": [{ id: "role-audio", name: "Audio", members: ["Audio"] }],
  "settings.json": {
    appName: "Stage Utility",
    accentColor: "#2e6691",
    planMode: "auto",
    planSwitcherMode: "within-type",
    serviceTypeId: null,
    allowedServiceTypeIds: [],
    showQr: true,
    timezone: "America/Chicago",
    hourCycle: "12h",
    autoUpdate: { mode: "manual", dayOfWeek: null, hour: 3 },
    outputs: [{ id: "1", name: "Main", viewId: "v1", textSize: 100, rotation: 0 }],
    integrationConfigs: { propresenter: { host: "192.0.2.30", port: 1025 } },
    integrationEnabled: { propresenter: false },
    iconColors: { "tools/clock": "#ff8800" },
    captionChannelColors: { Pastor: "#ffcc00" },
    wirelessMeterRateMs: 250,
  },
  "slots.json": { version: 3, defaults: { v1: { "123": [{ id: "s1" }] } }, overrides: {} },
  "video-feeds.json": {
    feeds: [{ id: "cam-1", name: "Camera 1", source: { kind: "pull", url: "rtsp://192.0.2.10/stream", username: "" } }],
    ports: DEFAULT_VIDEO_PORTS,
  },
  "views.json": [{ id: "v1", name: "Main", kind: "custom", createdAt: "", surface: "display", layout: LAYOUT }],
  "wireless-connections.json": [{ id: "w1", name: "Rack", providerId: "none", enabled: false, config: { host: "192.0.2.20" } }],
};

/** For each store, one value its settings routes refuse, and a word the refusal must name. */
const BAD: Record<string, { value: unknown; says: string }> = {
  "automation-rules.json": {
    value: [{ ...(GOOD["automation-rules.json"] as object[])[0], trigger: { id: "call.by-name", params: { name: "Lights Off!" } } }],
    says: "not a usable cue name",
  },
  "automation-settings.json": { value: { simulate: "no" }, says: "simulate" },
  "baptism-triggers.json": { value: { "plan-1": { testimonyItemId: 5 } }, says: "testimonyItemId" },
  "bar-config.json": { value: { items: "clock" }, says: "items" },
  "history-milestones.json": { value: [{ id: "m1", date: "soon", label: "Launch" }], says: "date" },
  "host-names.json": { value: { accepted: [{ name: "192.0.2.1", source: "added" }], dismissed: [] }, says: "192.0.2.1" },
  "kiosk-devices.json": { value: [{ id: "", token: "", outputId: "1", macs: [] }], says: "device id" },
  "layout-groups.json": { value: [{ id: "g1", name: "Header", object: "text" }], says: "object" },
  "layout-templates.json": { value: [{ id: "t1", name: "Blank", layout: { objects: [] } }], says: "layout" },
  "messaging.json": { value: { version: 2, groups: [], quickMessages: [42], quickReplies: [] }, says: "quick message" },
  "notes.json": { value: { "not an id!": { text: "x" } }, says: "object id" },
  "osc-targets.json": { value: [{ id: "o1", name: "Board", enabled: "yes", config: {} }], says: "enabled" },
  "patch.json": { value: { sheets: [42] }, says: "sheet" },
  "presets.json": { value: [{ id: "p1", name: "   ", slots: [] }], says: "no name" },
  "rosstalk-settings.json": { value: { simulate: 1 }, says: "simulate" },
  "rosstalk-targets.json": { value: [{ id: "rt1", name: 5, enabled: false, config: {} }], says: "name" },
  "saved-colors.json": { value: Array.from({ length: 25 }, (_, i) => `#0000${String(i).padStart(2, "0")}`), says: "at most" },
  "scores-favourites.json": { value: { favourites: "nfl" }, says: "favourites" },
  "servicecue-config.json": { value: { serviceTypeIds: "123" }, says: "serviceTypeIds" },
  "servicecue-layouts.json": { value: [{ id: "l1", name: "Default", columnRoles: "role-audio" }], says: "columnRoles" },
  "servicecue-publish.json": { value: { enabled: true, url: "http://cue.example.org" }, says: "https" },
  "servicecue-roles.json": { value: { roles: [] }, says: "list" },
  "settings.json": { value: { ...(GOOD["settings.json"] as object), accentColor: "red" }, says: "accentColor" },
  "slots.json": { value: { version: 3, defaults: { v1: { "123": "s1" } }, overrides: {} }, says: "slots" },
  "video-feeds.json": {
    value: { feeds: [{ id: "cam-1", name: "Camera 1", source: { kind: "pull", url: "file:/etc/passwd", username: "" } }] },
    says: "protocol",
  },
  "views.json": { value: [{ id: "v1", name: "Main", kind: "nope", createdAt: "" }], says: "kind" },
  "wireless-connections.json": { value: [{ id: "w1", name: "Rack", providerId: "none", enabled: "yes", config: {} }], says: "enabled" },
};

function bundleOf(files: Record<string, unknown>) {
  return { kind: "stage-utility-config", version: 1, appVersion: "test", createdAt: "2026-10-24T00:00:00.000Z", files };
}

async function writeAll(files: Record<string, unknown>): Promise<void> {
  for (const [name, value] of Object.entries(files)) {
    await fs.writeFile(path.join(TMP, name), JSON.stringify(value, null, 2), "utf8");
  }
}

async function readOnDisk(name: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(TMP, name), "utf8"));
}

/** Every file in the data dir, as bytes: to show a refused restore changed nothing. */
async function snapshotDir(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of await fs.readdir(TMP)) {
    const full = path.join(TMP, name);
    if ((await fs.stat(full)).isFile()) out.set(name, await fs.readFile(full, "utf8"));
  }
  return out;
}

describe("config restore checks", () => {
  beforeEach(async () => {
    for (const name of await fs.readdir(TMP)) {
      if (name !== "home") await fs.rm(path.join(TMP, name), { recursive: true, force: true });
    }
    await writeAll(GOOD);
  });

  test("the fixtures cover every config store, good and bad", () => {
    // A new config store fails here until it has a value of each kind, which
    // is what makes the two tests below cover it.
    assert.deepEqual(Object.keys(GOOD).sort(), configFiles().slice().sort());
    assert.deepEqual(Object.keys(BAD).sort(), configFiles().slice().sort());
  });

  test("refuses a video feed whose address is file:/etc/passwd, and writes nothing", async () => {
    const before = await snapshotDir();
    const err = await configSnapshot
      .apply(bundleOf({ ...GOOD, "video-feeds.json": BAD["video-feeds.json"].value }))
      .then(() => null, (e: unknown) => e);
    assert.ok(err instanceof RestoreRefusedError, `expected a refusal, got ${String(err)}`);
    assert.match(err.message, /video-feeds\.json: video feed "cam-1": Pull source protocol must be/);
    assert.deepEqual(await snapshotDir(), before, "a refused restore changed a file");
  });

  for (const [name, bad] of Object.entries(BAD)) {
    test(`refuses a bad ${name}`, async () => {
      const err = await configSnapshot.apply(bundleOf({ [name]: bad.value })).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof RestoreRefusedError, `${name}: expected a refusal, got ${String(err)}`);
      assert.equal(err.failures.length, 1);
      assert.ok(err.failures[0].startsWith(`${name}: `), err.failures[0]);
      assert.ok(err.failures[0].includes(bad.says), `${name}: the reason should name "${bad.says}": ${err.failures[0]}`);
      assert.deepEqual(await readOnDisk(name), GOOD[name], `${name} was changed by a refused restore`);
    });
  }

  test("one bad file among good ones writes none of them", async () => {
    const changed = Object.fromEntries(
      Object.entries(GOOD).map(([name, v]) => [name, name === "presets.json" ? [{ id: "p2", name: "Changed", slots: [] }] : v]),
    );
    const before = await snapshotDir();
    await assert.rejects(() => configSnapshot.apply(bundleOf({ ...changed, "views.json": BAD["views.json"].value })), RestoreRefusedError);
    assert.deepEqual(await snapshotDir(), before);
  });

  test("a backup this app made restores unchanged", async () => {
    const bundle = await configSnapshot.build();
    assert.deepEqual(Object.keys(bundle.files).sort(), configFiles().slice().sort(), "build() should carry every fixture");
    // Restored onto an empty box, so what lands is the bundle's alone.
    for (const name of configFiles()) await fs.rm(path.join(TMP, name), { force: true });
    const applied = await configSnapshot.apply(JSON.parse(JSON.stringify(bundle)));
    assert.deepEqual(applied.slice().sort(), configFiles().slice().sort());
    for (const name of configFiles()) {
      const onDisk = (await readOnDisk(name)) as Record<string, unknown>;
      // The one deliberate difference: a restore records the id floors of what it brought.
      if (name === "settings.json") delete onDisk.idFloors;
      assert.deepEqual(onDisk, GOOD[name], `${name} did not come back as it was`);
    }
  });

  test("a restore cannot write the secrets file or the key, nor a credential into a config file", async () => {
    await fs.writeFile(path.join(TMP, "secrets.bin"), "sealed", "utf8");
    const applied = await configSnapshot.apply(
      bundleOf({
        "secrets.bin": { forged: true },
        "encryption.key": "0000",
        "wireless-connections.json": [
          { id: "w1", name: "Rack", providerId: "none", enabled: false, config: { host: "192.0.2.20", password: "planted" } },
        ],
        "settings.json": { integrationConfigs: { "planning-center": { appId: "x", secret: "planted" } } },
      }),
    );
    assert.deepEqual(applied.slice().sort(), ["settings.json", "wireless-connections.json"]);
    assert.equal(await fs.readFile(path.join(TMP, "secrets.bin"), "utf8"), "sealed");
    await assert.rejects(() => fs.stat(path.join(TMP, "encryption.key")), { code: "ENOENT" });
    const wireless = (await readOnDisk("wireless-connections.json")) as { config: Record<string, unknown> }[];
    assert.equal(wireless[0].config.password, undefined, "a credential reached wireless-connections.json");
    const settings = (await readOnDisk("settings.json")) as { integrationConfigs: Record<string, Record<string, unknown>> };
    assert.equal(settings.integrationConfigs["planning-center"].secret, undefined, "a credential reached settings.json");
    assert.equal(settings.integrationConfigs["planning-center"].appId, "x");
  });

  test("refuses a backup listing more files than a backup can hold", async () => {
    const files = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`extra-${i}.json`, {}]));
    await assert.rejects(() => configSnapshot.apply(bundleOf(files)), /lists 200 files/);
  });

  test("the start-up check names a file on disk a save would refuse, and leaves it", async () => {
    await writeAll({ "video-feeds.json": BAD["video-feeds.json"].value });
    const failures = await configSnapshot.checkOnDisk();
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^video-feeds\.json: /);
    assert.deepEqual(await readOnDisk("video-feeds.json"), BAD["video-feeds.json"].value);
  });
});
