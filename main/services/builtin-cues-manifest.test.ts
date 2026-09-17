// The built-in cues where they enter — the manifest, the call route, the state
// read and the reserved names.
//
// Driven through the REAL engine and the REAL manifest, because every question
// here is about the seam between them and none of the pieces answers it alone:
// `listRules()` must NOT see a built-in while `rulesWithBuiltins()` must, and
// the two are one method apart.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - A DISABLED INTEGRATION PUBLISHES NOTHING. An OBS recording switch in Home
//    Assistant on an install with no OBS is an entity that can only ever fail.
//  - THE AUTOMATION PAGE NEVER SEES ONE. A synthesised rule listed there is a
//    rule an operator can edit, cannot delete, and would find back next boot —
//    and it would land in the config archive as if it were their work.
//  - THE NAME IS REFUSED, WITH THE SENTENCE. Two rules behind one URL is a
//    coin toss at call time.
//  - A REPEAT PRESSES NOTHING. `POST /api/cues/obs_record_on` twice must
//    answer "already on" rather than send a second StartRecord, which OBS
//    answers with a request error over a healthy recording.
//  - THE VERSION MOVES when a PVP layer is renamed, or an integration's
//    entities never appear in Home Assistant until a restart.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "builtin-wiring-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { automationEngine } = await import("./automation-engine.js");
const { automationLog } = await import("./automation-log.js");
const { automationStore } = await import("./automation-store.js");
const { cueManifest, manifestVersion } = await import("./cue-manifest.js");
const { cueStates, cueStatesDeps } = await import("./cue-states.js");
const { cueLiveDeps } = await import("./cue-live.js");
const { builtinCuesDeps, __resetBuiltinCues } = await import("./builtin-cues.js");
const { obsOutputDeps } = await import("./obs-service.js");
const { broadcast } = await import("./broadcaster.js");
const { CALL_TRIGGER_ID } = await import("./cue-aliases.js");
const { homeAssistantYaml } = await import("./home-assistant-yaml.js");
type Rule = import("../types/automation.js").Rule;
type CuesEvent = import("./cue-live.js").CuesEvent;

let ENABLED = new Set<string>();
let LAYERS: string[] = [];
/** What the state seam answers per variable. See cueStatesDeps.read. */
let VALUES: Record<string, string> = {};
/** Every OBS request the action put on the wire, in order. */
let sent: string[] = [];
let recording = false;
let events: CuesEvent[] = [];

after(async () => {
  await automationLog.whenIdle();
  await fs.rm(TMP, { recursive: true, force: true });
});

before(async () => {
  await automationEngine.init();
  await automationEngine.setSettings({ simulate: false, disarmed: false });
});

beforeEach(async () => {
  for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
  ENABLED = new Set(["obs"]);
  LAYERS = [];
  VALUES = {};
  sent = [];
  recording = false;
  events = [];
  __resetBuiltinCues();
  builtinCuesDeps.enabled = () => ENABLED;
  builtinCuesDeps.connected = () => new Set();
  builtinCuesDeps.pvpLayers = () => LAYERS;
  // The same seam `GET /api/cues/states` reads through, so nothing below it —
  // the cache, the settle window, the manifest's state — knows this is a stub.
  // readAppState is what it replaces; see cue-states.ts.
  cueStatesDeps.read = async (variable) =>
    variable in VALUES ? { value: VALUES[variable]! } : { error: "no stub" };
  cueStates.invalidate();
  cueStates.__resetSettle();
  obsOutputDeps.status = () => ({
    connected: true,
    recording,
    recordPaused: false,
    streaming: false,
    virtualCam: false,
    recordAnchorMs: null,
    recordSampledAt: null,
  });
  obsOutputDeps.adapter = () => ({
    request: async (requestType: string) => {
      sent.push(requestType);
      return {};
    },
  });
  cueLiveDeps.emit = (e) => events.push(e);
  cueLiveDeps.emitAll = () => {};
});

describe("the manifest", () => {
  test("a disabled integration contributes nothing", async () => {
    ENABLED = new Set();
    const m = await cueManifest();
    assert.deepEqual(m.switches.map((s) => s.id), []);
    assert.deepEqual(m.buttons.map((b) => b.id), ["display_refresh"]);
  });

  test("an enabled one is listed with builtin, its tone and its state", async () => {
    VALUES["app:obs.recording"] = "on";
    const m = await cueManifest();
    const rec = m.switches.find((s) => s.id === "obs_record")!;
    assert.equal(rec.builtin, true);
    assert.equal(rec.tone, "live");
    assert.equal(rec.state, "on");
    assert.equal(rec.on, "obs_record_on");
    assert.equal(rec.off, "obs_record_off");
    assert.equal(rec.stateSource, "app:obs.recording");
    assert.equal(rec.name, "OBS recording");
    // The default tone is ABSENT, not "default": a user-made pair has no tone
    // setting at all and must render exactly as it did before.
    assert.equal(m.switches.find((s) => s.id === "obs_virtual_cam")!.tone, undefined);
  });

  test("a PVP layer's switches are listed under a slug of its name", async () => {
    ENABLED = new Set(["pvp"]);
    LAYERS = ["Lower Thirds"];
    VALUES["app:pvp.layer-hidden:Lower Thirds"] = "off";
    const m = await cueManifest();
    const shown = m.switches.find((s) => s.id === "pvp_lower_thirds_shown")!;
    // `off` in the family is the layer NOT hidden, which is the switch ON: the
    // binding is inverted, and a switch that read this backwards would light
    // for a layer that is off screen.
    assert.equal(shown.state, "on");
    assert.equal(shown.builtin, true);
    assert.equal(shown.tone, undefined);
    assert.ok(m.buttons.find((b) => b.id === "pvp_lower_thirds_clear")?.builtin);
  });

  test("the Automation page never sees one", async () => {
    assert.deepEqual(automationEngine.listRules(), []);
    assert.ok(automationEngine.rulesWithBuiltins().length > 0);
    assert.equal(
      automationEngine.rulesWithBuiltins().every((r) => r.conditions.length === 0),
      true,
    );
  });

  test("the generated Home Assistant config carries them", () => {
    const yaml = homeAssistantYaml(automationEngine.rulesWithBuiltins(), "http://192.0.2.10:8788");
    assert.match(yaml, /su_obs_record_on:/);
    assert.match(yaml, /su_display_refresh:/);
  });
});

describe("the name is reserved", () => {
  const cue = (name: string): Omit<Rule, "id"> => ({
    name: `Rule ${name}`,
    enabled: true,
    trigger: { id: CALL_TRIGGER_ID, params: { name } },
    conditions: [],
    action: { id: "log.message", params: { message: name } },
    cooldownSec: 0,
    oncePerService: false,
  });

  test("saving a rule with a built-in's name is refused", async () => {
    await assert.rejects(
      () => automationEngine.addRule(cue("obs_record_on")),
      /^Error: "obs_record_on" is a built-in cue$/,
    );
    // Reserved whatever is enabled: a rule saved today must not collide with a
    // built-in that appears the moment somebody switches OBS on.
    ENABLED = new Set();
    await assert.rejects(
      () => automationEngine.addRule(cue("display_refresh")),
      /^Error: "display_refresh" is a built-in cue$/,
    );
  });

  test("claiming one as a FORMER name is refused", async () => {
    // A former name is a live URL and a live Home Assistant entity id — that is
    // what aliases are for — so this took the built-in's URL exactly as taking
    // its name would, and suppressed the built-in on the way past.
    await assert.rejects(
      () =>
        automationEngine.addRule({
          ...cue("rec_on"),
          trigger: { id: CALL_TRIGGER_ID, params: { name: "rec_on", aliases: "obs_record_on" } },
        }),
      /^Error: "obs_record_on" is a built-in cue$/,
    );
  });

  test("a rule renamed OUT of a built-in's name keeps it as a former name", async () => {
    // The legacy install again: its own name goes into its own alias list on a
    // rename, and refusing that would make a pair built before the built-ins
    // existed impossible to rename out of the way.
    await automationStore.saveRules([
      {
        id: "legacy-on",
        name: "REC on",
        enabled: true,
        trigger: { id: CALL_TRIGGER_ID, params: { name: "obs_record_on" } },
        conditions: [],
        action: { id: "log.message", params: { message: "rec" } },
        cooldownSec: 0,
        oncePerService: false,
      },
    ]);
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: false, disarmed: false });
    try {
      const updated = await automationEngine.updateRule("legacy-on", {
        trigger: { id: CALL_TRIGGER_ID, params: { name: "rec_on", aliases: "obs_record_on" } },
      });
      assert.equal(automationEngine.cueNameOf(updated.find((r) => r.id === "legacy-on")!), "rec_on");
      // And it stays editable AFTERWARDS, when the built-in's name is one it
      // holds as a former name rather than as its name — every later edit of
      // that rule, a switch toggled or a room typed, goes through this check.
      const again = await automationEngine.updateRule("legacy-on", { enabled: false });
      assert.equal(again.find((r) => r.id === "legacy-on")!.enabled, false);
    } finally {
      await automationStore.saveRules([]);
      await automationEngine.init();
      await automationEngine.setSettings({ simulate: false, disarmed: false });
    }
  });

  test("renaming a rule into one is refused too", async () => {
    const r = await automationEngine.addRule(cue("booth_record_on"));
    await assert.rejects(
      () =>
        automationEngine.updateRule(r.id, {
          trigger: { id: CALL_TRIGGER_ID, params: { name: "obs_record_on" } },
        }),
      /is a built-in cue/,
    );
  });

  test("a rule that already holds one keeps working and stays editable", async () => {
    // Written straight to the store and reloaded: this is the install that
    // built its own OBS pair before the built-ins existed, which addRule would
    // refuse today.
    const legacy: Rule[] = [
      {
        id: "legacy-on",
        name: "REC on",
        enabled: true,
        trigger: { id: CALL_TRIGGER_ID, params: { name: "obs_record_on", says: "REC" } },
        conditions: [],
        action: { id: "log.message", params: { message: "rec" } },
        cooldownSec: 0,
        oncePerService: false,
      },
    ];
    await automationStore.saveRules(legacy);
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: false, disarmed: false });
    try {
      const names = automationEngine.rulesWithBuiltins().map((r) => String(r.trigger.params.name));
      assert.equal(names.filter((n) => n === "obs_record_on").length, 1, "two rules under one name");
      assert.equal(names.includes("obs_record_off"), false, "half the built-in pair survived");
      // Still editable: the guard excepts the rule that already holds the name.
      const updated = await automationEngine.updateRule("legacy-on", { enabled: false });
      assert.equal(updated.find((r) => r.id === "legacy-on")!.enabled, false);
    } finally {
      await automationStore.saveRules([]);
      await automationEngine.init();
      await automationEngine.setSettings({ simulate: false, disarmed: false });
    }
  });
});

describe("calling one", () => {
  test("runs the action, and a repeat while it reads on presses nothing", async () => {
    const first = await automationEngine.callByName("obs_record_on", { caller: "test" });
    assert.equal(first.status, 200);
    assert.deepEqual(sent, ["StartRecord"]);

    // What the device is now doing, through the same seam the states route
    // reads. The cached answer is dropped by noteCommand, so this is read
    // fresh — but the SETTLE window is what a repeat is compared against first,
    // so it is cleared here to ask the question the cue button asks a minute
    // later rather than a second later.
    recording = true;
    VALUES["app:obs.recording"] = "on";
    cueStates.__resetSettle();
    cueStates.invalidate();

    const again = await automationEngine.callByName("obs_record_on", { caller: "test" });
    assert.equal(again.status, 200);
    const body = again.body as Record<string, unknown>;
    assert.equal(body.detail, "already on");
    assert.equal(body.skipped, true);
    assert.deepEqual(sent, ["StartRecord"], "a second StartRecord reached OBS");
  });

  test("an unknown built-in is still a 404", async () => {
    const r = await automationEngine.callByName("obs_record_sideways", { caller: "test" });
    assert.equal(r.status, 404);
  });

  test("a built-in for a disabled integration is not callable", async () => {
    ENABLED = new Set();
    const r = await automationEngine.callByName("obs_record_on", { caller: "test" });
    assert.equal(r.status, 404);
    assert.deepEqual(sent, []);
  });
});

describe("the boot line", () => {
  test("init says what is offered, without anything reading the manifest", async () => {
    // An install with no Home Assistant and no panel open never reads the
    // manifest, so the count line — emitted on a read — was never said at all
    // and `/log` had nothing about the cues a console is bound to.
    __resetBuiltinCues();
    ENABLED = new Set(["obs"]);
    const said: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => said.push(args.map(String).join(" "));
    try {
      await automationEngine.init();
      await automationEngine.setSettings({ simulate: false, disarmed: false });
    } finally {
      console.log = realLog;
    }
    assert.deepEqual(
      said.filter((l) => l.includes("built-in cues offered")),
      ["[cues] 4 built-in cues offered (obs 3, app 1)"],
    );
  });
});

describe("poll demand", () => {
  test("a built-in switch holds its integration's poll at the active cadence", () => {
    // NO stored rules at all, which is the install this whole feature is for.
    // REAPER and PVP fall to their idle cadence when nothing is watching, so a
    // built-in that registered no demand would be a switch in Home Assistant —
    // and a cue button on a panel — reading a snapshot five seconds old, with
    // nothing anywhere saying so.
    assert.deepEqual(automationEngine.listRules(), []);
    ENABLED = new Set(["reaper", "pvp"]);
    LAYERS = ["Lyrics"];
    assert.equal(automationEngine.wantsAppStateSource("reaper.recording"), true);
    assert.equal(automationEngine.wantsAppStateFamily("pvp.layer-hidden"), true);
    assert.equal(automationEngine.wantsAppStateFamily("pvp.layer-muted"), true);
    // And nothing is demanded for an integration that is switched off.
    assert.equal(automationEngine.wantsAppStateSource("obs.recording"), false);
  });
});

describe("the set changing", () => {
  test("a PVP layer rename bumps the version and says manifest on cues", async () => {
    ENABLED = new Set(["pvp"]);
    LAYERS = ["Lyrics"];
    // Seeds the signature. Boot publishes a status on every channel, and a bump
    // per channel at start-up would be a manifest re-read per integration for a
    // set that has not changed.
    broadcast("pvp:status", { connected: true, layers: [] });
    await settle();
    const before = manifestVersion();
    events = [];

    LAYERS = ["Lyrics Two"];
    broadcast("pvp:status", { connected: true, layers: [] });
    await settle();

    assert.equal(manifestVersion() > before, true, "the manifest version did not move");
    assert.deepEqual(
      events.filter((e) => e.type === "manifest").map((e) => e.type),
      ["manifest"],
    );
    const m = await cueManifest();
    assert.ok(m.switches.find((s) => s.id === "pvp_lyrics_two_shown"));
    assert.equal(m.switches.some((s) => s.id === "pvp_lyrics_shown"), false);
  });

  test("an unchanged status says nothing", async () => {
    ENABLED = new Set(["pvp"]);
    LAYERS = ["Lyrics"];
    broadcast("pvp:status", { connected: true, layers: [] });
    await settle();
    events = [];
    const before = manifestVersion();
    broadcast("pvp:status", { connected: true, layers: [] });
    await settle();
    assert.deepEqual(events, []);
    assert.equal(manifestVersion(), before);
  });
});

/** The dynamic import behind builtinCuesDeps.changed, plus its microtasks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}
