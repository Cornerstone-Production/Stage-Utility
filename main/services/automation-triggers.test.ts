// Edge-detection tests. These are the whole reason the engine is safe: the
// broadcast channels carry state SNAPSHOTS, re-sent constantly, so a trigger that
// fires on a level rather than an edge would fire dozens of times per service.
//
// The restart guard (prev === null must never fire) is asserted for EVERY trigger,
// because the failure it prevents is the worst one: an update or crash mid-service
// re-seeding state and firing every rule at once with nobody watching.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { AUTOMATION_TRIGGERS, triggersForChannel } from "./automation-triggers.js";
import type { PvpLayerDTO } from "../types/pvp.js";

const NOW = Date.parse("2026-07-26T10:00:00Z");
const live = (over: Record<string, unknown> = {}) => ({
  mode: "item", currentItemId: "i1", label: null, lengthSec: 300,
  liveStartAt: null, targetAt: null, serverNow: new Date(NOW).toISOString(),
  currentItemTitle: "Welcome", nextItemTitle: null,
  serviceTimeId: "st1", serviceTimeStartsAt: new Date(NOW + 600_000).toISOString(),
  ...over,
});
const people = (attendance: number | null, occupancy: number | null = null) => ({
  connected: true, updatedAt: null,
  total: { attendance, occupancy }, zones: [],
});
const rec = (recording: boolean, connected = true) => ({
  connected, recording, recordPaused: false, streaming: false, virtualCam: false, recordTimecode: null,
});

describe("the restart guard applies to every trigger", () => {
  test("no trigger fires when prev is null", () => {
    // On startup the engine has no previous snapshot. If any trigger treated that
    // as a transition, restarting mid-service would fire every rule at once.
    for (const [id, t] of Object.entries(AUTOMATION_TRIGGERS)) {
      const params: Record<string, unknown> = {};
      for (const p of t.params) params[p.key] = p.type === "number" ? 1 : (p.options?.[0]?.value ?? "x");
      assert.equal(
        t.didFire(null, live(), params, NOW), false,
        `${id} fired on a null prev — that is the restart guard broken`,
      );
    }
  });
});

describe("pco triggers", () => {
  test("service-started fires on preservice -> item", () => {
    const t = AUTOMATION_TRIGGERS["pco.service-started"];
    assert.equal(t.didFire(live({ mode: "preservice" }), live({ mode: "item" }), {}, NOW), true);
  });

  test("service-started does NOT fire while already live", () => {
    const t = AUTOMATION_TRIGGERS["pco.service-started"];
    assert.equal(t.didFire(live({ mode: "item" }), live({ mode: "item" }), {}, NOW), false);
  });

  test("service-ended fires on item -> none", () => {
    const t = AUTOMATION_TRIGGERS["pco.service-ended"];
    assert.equal(t.didFire(live({ mode: "item" }), live({ mode: "none" }), {}, NOW), true);
    assert.equal(t.didFire(live({ mode: "none" }), live({ mode: "none" }), {}, NOW), false);
  });

  test("item-reached fires when the current item title starts matching", () => {
    const t = AUTOMATION_TRIGGERS["pco.item-reached"];
    const p = { title: "Sermon" };
    assert.equal(t.didFire(live({ currentItemTitle: "Welcome" }), live({ currentItemTitle: "Sermon" }), p, NOW), true);
    assert.equal(t.didFire(live({ currentItemTitle: "Sermon" }), live({ currentItemTitle: "Sermon" }), p, NOW), false);
  });

  test("item-reached matches case-insensitively and ignores surrounding text", () => {
    const t = AUTOMATION_TRIGGERS["pco.item-reached"];
    const p = { title: "sermon" };
    assert.equal(t.didFire(live({ currentItemTitle: "Welcome" }), live({ currentItemTitle: "SERMON — Part 3" }), p, NOW), true);
  });
});

describe("occupancy triggers", () => {
  test("crossed-above fires only on the crossing", () => {
    const t = AUTOMATION_TRIGGERS["occupancy.crossed-above"];
    const p = { threshold: 50, metric: "attendance" };
    assert.equal(t.didFire(people(49), people(51), p, NOW), true);
    assert.equal(t.didFire(people(51), people(52), p, NOW), false, "already above — not a crossing");
    assert.equal(t.didFire(people(51), people(51), p, NOW), false, "identical snapshots never fire");
  });

  test("crossed-below fires only on the downward crossing", () => {
    const t = AUTOMATION_TRIGGERS["occupancy.crossed-below"];
    const p = { threshold: 50, metric: "attendance" };
    assert.equal(t.didFire(people(51), people(49), p, NOW), true);
    assert.equal(t.didFire(people(49), people(48), p, NOW), false);
  });

  test("the occupancy metric is selectable", () => {
    const t = AUTOMATION_TRIGGERS["occupancy.crossed-above"];
    const p = { threshold: 10, metric: "occupancy" };
    assert.equal(t.didFire(people(null, 5), people(null, 15), p, NOW), true);
    assert.equal(t.didFire(people(5, null), people(15, null), p, NOW), false, "wrong metric must not fire");
  });

  test("a null reading never fires", () => {
    const t = AUTOMATION_TRIGGERS["occupancy.crossed-above"];
    const p = { threshold: 50, metric: "attendance" };
    assert.equal(t.didFire(people(null), people(60), p, NOW), false, "no baseline means no crossing");
    assert.equal(t.didFire(people(40), people(null), p, NOW), false);
  });
});

describe("recording triggers", () => {
  test("started fires false -> true, stopped fires true -> false", () => {
    const started = AUTOMATION_TRIGGERS["recording.started"];
    const stopped = AUTOMATION_TRIGGERS["recording.stopped"];
    assert.equal(started.didFire(rec(false), rec(true), {}, NOW), true);
    assert.equal(started.didFire(rec(true), rec(true), {}, NOW), false);
    assert.equal(stopped.didFire(rec(true), rec(false), {}, NOW), true);
    assert.equal(stopped.didFire(rec(false), rec(false), {}, NOW), false);
  });

  test("a recorder going offline is not a 'stopped recording' event", () => {
    // connected:false with recording:false is unknown, not "stopped". Firing a
    // stop rule because a machine dropped off the network would be wrong.
    const stopped = AUTOMATION_TRIGGERS["recording.stopped"];
    assert.equal(stopped.didFire(rec(true, true), rec(false, false), {}, NOW), false);
  });
});

describe("pco.item-due", () => {
  const t = AUTOMATION_TRIGGERS["pco.item-due"];
  const DOORS = NOW + 300_000; // due five minutes from NOW
  // Two consecutive snapshots. The trigger's edge is in time, not in the payload,
  // so what distinguishes them is serverNow — exactly as the live poller sends it.
  const at = (ms: number) =>
    live({
      serverNow: new Date(ms).toISOString(),
      itemSchedule: [
        { title: "Doors Open", dueAt: new Date(DOORS).toISOString(), exact: true },
        { title: "Welcome", dueAt: new Date(DOORS + 900_000).toISOString(), exact: false },
      ],
    });
  const params = { title: "doors", anchor: "item", offsetMinutes: 0 };

  test("does not fire before the due time", () => {
    assert.equal(t.didFire(at(NOW), at(NOW + 60_000), params, NOW), false);
  });

  test("fires on the snapshot whose window contains the due time", () => {
    assert.equal(t.didFire(at(DOORS - 30_000), at(DOORS + 30_000), params, NOW), true);
  });

  test("does NOT fire again on the next snapshot", () => {
    // The window that already covered the due moment must not cover it twice —
    // a second fire would advance the plan an extra item, live.
    assert.equal(t.didFire(at(DOORS - 30_000), at(DOORS + 30_000), params, NOW), true);
    assert.equal(t.didFire(at(DOORS + 30_000), at(DOORS + 90_000), params, NOW), false);
  });

  test("does not fire long after the due time", () => {
    // Starting the app mid-service must not fire a cue whose moment has passed.
    assert.equal(t.didFire(at(DOORS + 3_600_000), at(DOORS + 3_660_000), params, NOW), false);
  });

  test("does not fire when no item matches the title", () => {
    assert.equal(t.didFire(at(DOORS - 30_000), at(DOORS + 30_000), { ...params, title: "offering" }, NOW), false);
  });

  test("does not fire on an empty title rather than matching the first item", () => {
    assert.equal(t.didFire(at(DOORS - 30_000), at(DOORS + 30_000), { ...params, title: "" }, NOW), false);
  });

  test("a negative offset fires early by that many minutes", () => {
    const p = { ...params, offsetMinutes: -2 };
    const due = DOORS - 120_000;
    assert.equal(t.didFire(at(due - 10_000), at(due + 10_000), p, NOW), true);
    assert.equal(t.didFire(at(DOORS - 10_000), at(DOORS + 10_000), p, NOW), false);
  });

  test("the service-start anchor ignores the item's own time", () => {
    // serviceTimeStartsAt is NOW + 10m in the fixture; Doors is due at NOW + 5m.
    const p = { title: "doors", anchor: "service-start", offsetMinutes: 0 };
    const start = NOW + 600_000;
    assert.equal(t.didFire(at(start - 10_000), at(start + 10_000), p, NOW), true);
    assert.equal(t.didFire(at(DOORS - 10_000), at(DOORS + 10_000), p, NOW), false);
  });

  test("does not fire when the payload carries no schedule", () => {
    const bare = live({ serverNow: new Date(DOORS - 30_000).toISOString() });
    const bare2 = live({ serverNow: new Date(DOORS + 30_000).toISOString() });
    assert.equal(t.didFire(bare, bare2, params, NOW), false);
  });

  test("does not fire when the clock did not advance between snapshots", () => {
    // A repeated or out-of-order snapshot must not re-open a window.
    assert.equal(t.didFire(at(DOORS + 30_000), at(DOORS + 30_000), params, NOW), false);
    assert.equal(t.didFire(at(DOORS + 30_000), at(DOORS - 30_000), params, NOW), false);
  });
});

describe("malformed payloads", () => {
  test("no trigger throws on a payload missing its fields", () => {
    for (const [id, t] of Object.entries(AUTOMATION_TRIGGERS)) {
      const params: Record<string, unknown> = {};
      for (const p of t.params) params[p.key] = p.type === "number" ? 1 : (p.options?.[0]?.value ?? "x");
      assert.doesNotThrow(() => t.didFire({}, {}, params, NOW), `${id} threw on an empty payload`);
      assert.doesNotThrow(() => t.didFire({ total: null }, { total: null }, params, NOW), `${id} threw on nulls`);
    }
  });
});

describe("triggersForChannel", () => {
  test("returns only triggers watching that channel", () => {
    for (const t of triggersForChannel("people:count")) assert.equal(t.channel, "people:count");
    assert.ok(triggersForChannel("people:count").length > 0);
    assert.equal(triggersForChannel("nope:none").length, 0);
  });
});

// ── Integration connections ────────────────────────────────────────────────

const INTEGRATION_IDS = [
  "companion", "obs", "osc", "planning-center", "prodcom", "propresenter",
  "reaper", "ross-tsl", "rosstalk", "sensource", "smaart", "wireless",
] as const;

const states = (over: Record<string, string> = {}) =>
  INTEGRATION_IDS.map((id) => ({
    id, enabled: true, connection: over[id] ?? "disconnected", message: null, config: {},
  }));

describe("integration connection triggers", () => {
  test("each integration fires on connect, and only on the transition", () => {
    for (const id of INTEGRATION_IDS) {
      const t = AUTOMATION_TRIGGERS[`${id}.connected`];
      assert.ok(t, `${id}.connected must be registered`);
      assert.equal(t.didFire(states(), states({ [id]: "connected" }), {}, NOW), true, `${id} connect`);
      // Already connected and still connected is a LEVEL, not an edge.
      assert.equal(
        t.didFire(states({ [id]: "connected" }), states({ [id]: "connected" }), {}, NOW), false,
        `${id} must not fire while merely staying connected`,
      );
    }
  });

  test("each integration fires on disconnect", () => {
    for (const id of INTEGRATION_IDS) {
      const t = AUTOMATION_TRIGGERS[`${id}.disconnected`];
      assert.ok(t, `${id}.disconnected must be registered`);
      assert.equal(t.didFire(states({ [id]: "connected" }), states(), {}, NOW), true, `${id} disconnect`);
      assert.equal(t.didFire(states(), states(), {}, NOW), false, `${id} stays down`);
    }
  });

  test("one integration's transition does not fire another's trigger", () => {
    const obs = AUTOMATION_TRIGGERS["obs.connected"];
    assert.equal(obs.didFire(states(), states({ reaper: "connected" }), {}, NOW), false);
  });

  test("'connecting' and 'error' are not connected", () => {
    const t = AUTOMATION_TRIGGERS["obs.connected"];
    assert.equal(t.didFire(states(), states({ obs: "connecting" }), {}, NOW), false);
    assert.equal(t.didFire(states(), states({ obs: "error" }), {}, NOW), false);
  });

  test("an integration vanishing from the payload is unknown, not disconnected", () => {
    const t = AUTOMATION_TRIGGERS["obs.disconnected"];
    const without = states({ obs: "connected" }).filter((s) => s.id !== "obs");
    assert.equal(t.didFire(states({ obs: "connected" }), without, {}, NOW), false);
  });
});

// ── OBS outputs ────────────────────────────────────────────────────────────

describe("obs outputs", () => {
  const obs = (over: Record<string, unknown> = {}) => ({
    connected: true, recording: false, recordPaused: false,
    streaming: false, virtualCam: false, recordTimecode: null, ...over,
  });

  test("streaming fires on start and on stop, not while it runs", () => {
    const started = AUTOMATION_TRIGGERS["obs.streaming-started"];
    const stopped = AUTOMATION_TRIGGERS["obs.streaming-stopped"];
    assert.equal(started.didFire(obs(), obs({ streaming: true }), {}, NOW), true);
    assert.equal(started.didFire(obs({ streaming: true }), obs({ streaming: true }), {}, NOW), false);
    assert.equal(stopped.didFire(obs({ streaming: true }), obs(), {}, NOW), true);
  });

  test("virtual cam fires on start and stop", () => {
    const on = AUTOMATION_TRIGGERS["obs.virtualcam-started"];
    const off = AUTOMATION_TRIGGERS["obs.virtualcam-stopped"];
    assert.equal(on.didFire(obs(), obs({ virtualCam: true }), {}, NOW), true);
    assert.equal(off.didFire(obs({ virtualCam: true }), obs(), {}, NOW), true);
  });

  test("OBS dropping off the network is not 'stopped'", () => {
    // Same rule the existing recording.stopped trigger follows: unreachable is
    // unknown, and firing a stop rule because a machine went offline is wrong.
    const stopped = AUTOMATION_TRIGGERS["obs.streaming-stopped"];
    assert.equal(
      stopped.didFire(obs({ streaming: true }), obs({ connected: false, streaming: false }), {}, NOW),
      false,
    );
    const cam = AUTOMATION_TRIGGERS["obs.virtualcam-stopped"];
    assert.equal(
      cam.didFire(obs({ virtualCam: true }), obs({ connected: false, virtualCam: false }), {}, NOW),
      false,
    );
  });
});

// ── ProdCom transcript ─────────────────────────────────────────────────────

describe("prodcom.phrase-said", () => {
  const t = () => AUTOMATION_TRIGGERS["prodcom.phrase-said"];
  const line = (id: string, text: string, channelName: string | null = null) =>
    ({ id, text, channelName, channel: null, color: null, isFinal: true });
  const feed = (...lines: unknown[]) => lines;

  test("fires when a NEW line contains the phrase", () => {
    assert.equal(
      t().didFire(feed(line("1", "standby")), feed(line("1", "standby"), line("2", "go for doors")),
        { phrase: "go for doors" }, NOW),
      true,
    );
  });

  test("does not fire again for a line already seen", () => {
    // The transcript is a growing list, so matching the whole feed would fire
    // on every broadcast for the rest of the service.
    const before = feed(line("1", "go for doors"));
    assert.equal(t().didFire(before, before, { phrase: "go for doors" }, NOW), false);
  });

  test("matches case-insensitively", () => {
    assert.equal(
      t().didFire(feed(), feed(line("1", "GO FOR DOORS")), { phrase: "go for doors" }, NOW),
      true,
    );
  });

  test("an empty phrase matches nothing", () => {
    assert.equal(t().didFire(feed(), feed(line("1", "anything")), { phrase: "" }, NOW), false);
  });

  test("an optional channel filter restricts which channel counts", () => {
    assert.equal(
      t().didFire(feed(), feed(line("1", "go", "Director")), { phrase: "go", channel: "Director" }, NOW),
      true,
    );
    assert.equal(
      t().didFire(feed(), feed(line("1", "go", "Audio")), { phrase: "go", channel: "Director" }, NOW),
      false,
    );
  });
});

// ── Baptism timer ──────────────────────────────────────────────────────────

describe("baptism triggers", () => {
  const b = (phase: string, personNumber = 1) =>
    ({ mode: "grouped", phase, personNumber, baptismIndex: 0, segmentStartedAt: null });

  test("started fires when the timer leaves idle", () => {
    const t = AUTOMATION_TRIGGERS["baptism.started"];
    assert.equal(t.didFire(b("idle"), b("testimony"), {}, NOW), true);
    assert.equal(t.didFire(b("testimony"), b("baptism"), {}, NOW), false);
  });

  test("phase-changed fires on any phase transition", () => {
    const t = AUTOMATION_TRIGGERS["baptism.phase-changed"];
    assert.equal(t.didFire(b("testimony"), b("baptism"), {}, NOW), true);
    assert.equal(t.didFire(b("baptism"), b("baptism"), {}, NOW), false);
  });

  test("finished fires when it returns to idle", () => {
    const t = AUTOMATION_TRIGGERS["baptism.finished"];
    assert.equal(t.didFire(b("baptism"), b("idle"), {}, NOW), true);
    assert.equal(t.didFire(b("idle"), b("idle"), {}, NOW), false);
  });
});

// ── Display presence ───────────────────────────────────────────────────────

describe("display presence", () => {
  const p = (...connected: string[]) => ({ connected });

  test("connected fires for a named display arriving", () => {
    const t = AUTOMATION_TRIGGERS["display.connected"];
    assert.equal(t.didFire(p("display-1"), p("display-1", "display-2"), { name: "display-2" }, NOW), true);
    assert.equal(t.didFire(p("display-1"), p("display-1", "display-2"), { name: "display-3" }, NOW), false);
  });

  test("with no name it fires for any display arriving", () => {
    const t = AUTOMATION_TRIGGERS["display.connected"];
    assert.equal(t.didFire(p(), p("display-9"), {}, NOW), true);
  });

  test("disconnected fires for one leaving", () => {
    const t = AUTOMATION_TRIGGERS["display.disconnected"];
    assert.equal(t.didFire(p("display-1", "display-2"), p("display-1"), { name: "display-2" }, NOW), true);
  });

  test("none-connected fires only on the transition to empty", () => {
    // The alarm case: every display in the building has gone.
    const t = AUTOMATION_TRIGGERS["display.none-connected"];
    assert.equal(t.didFire(p("display-1"), p(), {}, NOW), true);
    assert.equal(t.didFire(p(), p(), {}, NOW), false);
  });
});

// ── SPL thresholds ─────────────────────────────────────────────────────────
//
// The real payload keys meters "device::channel" and carries a `metrics` map
// named exactly as Smaart names them — there is no single `value` field, so the
// trigger takes the metric name too.

describe("spl thresholds", () => {
  const spl = (v: number | null, metric = "SPL A Slow") => ({
    connected: true,
    apiVersion: "4",
    meters: {
      "Smaart::FOH": {
        deviceName: "Smaart", channelName: "FOH", ts: null,
        metrics: v === null ? {} : { [metric]: v },
      },
    },
  });
  const P = { meter: "Smaart::FOH", metric: "SPL A Slow", threshold: 95 };

  test("crossed-above fires on the crossing, not while it stays high", () => {
    const t = AUTOMATION_TRIGGERS["spl.crossed-above"];
    assert.equal(t.didFire(spl(90), spl(96), P, NOW), true);
    assert.equal(t.didFire(spl(96), spl(97), P, NOW), false);
  });

  test("crossed-below fires on the way down", () => {
    const t = AUTOMATION_TRIGGERS["spl.crossed-below"];
    assert.equal(t.didFire(spl(96), spl(90), P, NOW), true);
    assert.equal(t.didFire(spl(90), spl(88), P, NOW), false);
  });

  test("a missing reading is no baseline, so nothing fires", () => {
    // Same rule the occupancy triggers follow: without both sides there is no
    // crossing, and inventing one fires on a reconnect.
    const t = AUTOMATION_TRIGGERS["spl.crossed-above"];
    assert.equal(t.didFire(spl(null), spl(96), P, NOW), false);
  });

  test("an unknown meter fires nothing", () => {
    const t = AUTOMATION_TRIGGERS["spl.crossed-above"];
    assert.equal(t.didFire(spl(90), spl(96), { ...P, meter: "Nope" }, NOW), false);
  });

  test("with no metric named it uses the first preferred one present", () => {
    const t = AUTOMATION_TRIGGERS["spl.crossed-above"];
    assert.equal(t.didFire(spl(90), spl(96), { meter: "Smaart::FOH", threshold: 95 }, NOW), true);
  });
});

// ── Wireless battery and RF ────────────────────────────────────────────────
//
// slots:devices broadcasts Record<slotId, DeviceStatus>; the human label is the
// device's own `name`, and levels are `battery` (%) and `rfBars` (0-5).

describe("wireless thresholds", () => {
  const dev = (name: string, battery: number | null, rfBars: number | null, online = true) => ({
    "slot-1": {
      channelId: "c1", name, deviceType: "receiver", online,
      rfBars, rfLevelDbm: null, battery, charging: null,
      frequencyLabel: null, audioLevel: null, cycles: null, health: null, tempC: null,
      updatedAt: new Date(NOW).toISOString(),
    },
  });

  test("battery-below fires on the crossing for the named mic", () => {
    const t = AUTOMATION_TRIGGERS["wireless.battery-below"];
    const p = { slot: "Vox 1", threshold: 20 };
    assert.equal(t.didFire(dev("Vox 1", 25, 5), dev("Vox 1", 18, 5), p, NOW), true);
    assert.equal(t.didFire(dev("Vox 1", 18, 5), dev("Vox 1", 15, 5), p, NOW), false);
  });

  test("with no mic named it fires for any pack crossing", () => {
    const t = AUTOMATION_TRIGGERS["wireless.battery-below"];
    assert.equal(t.didFire(dev("Vox 1", 25, 5), dev("Vox 1", 18, 5), { threshold: 20 }, NOW), true);
  });

  test("a pack going offline is not a low battery", () => {
    // null is UNKNOWN. Firing a low-battery rule because a receiver dropped
    // would page someone about a pack that is fine.
    const t = AUTOMATION_TRIGGERS["wireless.battery-below"];
    assert.equal(
      t.didFire(dev("Vox 1", 25, 5), dev("Vox 1", null, null, false), { slot: "Vox 1", threshold: 20 }, NOW),
      false,
    );
  });

  test("another mic's low battery does not fire a named rule", () => {
    const t = AUTOMATION_TRIGGERS["wireless.battery-below"];
    assert.equal(
      t.didFire(dev("Vox 2", 25, 5), dev("Vox 2", 18, 5), { slot: "Vox 1", threshold: 20 }, NOW),
      false,
    );
  });

  test("rf-below fires on bars dropping past the threshold", () => {
    const t = AUTOMATION_TRIGGERS["wireless.rf-below"];
    assert.equal(
      t.didFire(dev("Vox 1", 80, 4), dev("Vox 1", 80, 1), { slot: "Vox 1", threshold: 2 }, NOW),
      true,
    );
  });
});

// ── Service pacing and updates ─────────────────────────────────────────────

describe("service pacing and updates", () => {
  // Cumulative overrun = sum of (actual - planned) across FINISHED counted items.
  // The timeline record carries no pre-computed drift field, so it is derived
  // here the same way the History tab derives it.
  const item = (seq: number, planned: number, actual: number | null, over: Record<string, unknown> = {}) => ({
    itemId: `i${seq}`, title: `Item ${seq}`, sequence: seq,
    plannedLengthSec: planned,
    startedAt: new Date(NOW).toISOString(),
    endedAt: actual === null ? null : new Date(NOW + actual * 1000).toISOString(),
    actualDurationSec: actual,
    ...over,
  });
  const timeline = (...items: unknown[]) => ({ serviceKey: "k", items });

  test("running-over fires once as the plan goes past the margin", () => {
    const t = AUTOMATION_TRIGGERS["service.running-over"];
    // 120s over, then 360s over, against a 5-minute margin.
    const before = timeline(item(1, 300, 420));
    const after = timeline(item(1, 300, 420), item(2, 300, 540));
    assert.equal(t.didFire(before, after, { minutes: 5 }, NOW), true);
    assert.equal(t.didFire(after, after, { minutes: 5 }, NOW), false);
  });

  test("an item still running does not count toward the overrun", () => {
    const t = AUTOMATION_TRIGGERS["service.running-over"];
    const before = timeline(item(1, 300, 420));
    const after = timeline(item(1, 300, 420), item(2, 300, null));
    assert.equal(t.didFire(before, after, { minutes: 5 }, NOW), false);
  });

  test("pre-service items are excluded, as they are in History", () => {
    const t = AUTOMATION_TRIGGERS["service.running-over"];
    const before = timeline(item(1, 60, 60));
    const after = timeline(item(1, 60, 60), item(2, 60, 600, { preService: true }));
    assert.equal(t.didFire(before, after, { minutes: 5 }, NOW), false);
  });

  test("update.available fires when a release appears, not while one waits", () => {
    const t = AUTOMATION_TRIGGERS["update.available"];
    assert.equal(t.didFire({ releasesBehind: 0 }, { releasesBehind: 1 }, {}, NOW), true);
    assert.equal(t.didFire({ releasesBehind: 1 }, { releasesBehind: 1 }, {}, NOW), false);
  });
});

describe("ProVideoPlayer triggers", () => {
  const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
    uuid: "l1", name: "Graphics", index: 0, state: "video",
    mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC",
    hidden: false, muted: false, opacity: 1, playbackRate: 1,
    anchorElapsedSec: 1, durationSec: 20,
    ...over,
  });
  const EMPTY = {
    state: "empty" as const, mediaUuid: null, mediaName: null,
    anchorElapsedSec: null, durationSec: null, playbackRate: 0,
  };
  const snap = (...layers: PvpLayerDTO[]) => ({
    connected: true, layers, sampledAt: "2026-08-30T12:00:00.000Z",
  });
  const fire = (id: string, prev: unknown, next: unknown, params: Record<string, unknown> = {}) =>
    AUTOMATION_TRIGGERS[id].didFire(prev, next, params, NOW);

  test("a cue starting on a layer fires when the media uuid changes", () => {
    assert.equal(
      fire("pvp.cue-started", snap(layer()), snap(layer({ mediaUuid: "m2", mediaName: "loop_b.mp4" }))),
      true,
    );
  });

  test("a cue starting does NOT fire on the same media looping round", () => {
    // The media uuid is unchanged, and a loop is not a new cue. Firing here would
    // run the rule every twenty seconds for the whole of pre-service.
    assert.equal(
      fire("pvp.cue-started", snap(layer({ anchorElapsedSec: 19 })), snap(layer({ anchorElapsedSec: 0.2 }))),
      false,
    );
  });

  test("a cue starting fires when a layer goes from empty to holding media", () => {
    assert.equal(fire("pvp.cue-started", snap(layer(EMPTY)), snap(layer())), true);
  });

  test("a layer going EMPTY is not a cue starting", () => {
    // The uuid changed - to null. A rule that read that as a new cue would fire
    // on a clear, which is what pvp.layer-cleared is for.
    assert.equal(fire("pvp.cue-started", snap(layer()), snap(layer(EMPTY))), false);
  });

  test("a cue starting on the NAMED layer only", () => {
    const other = layer({ uuid: "l2", name: "Lower third" });
    const moved = { ...other, mediaUuid: "m9" };
    assert.equal(fire("pvp.cue-started", snap(layer(), other), snap(layer(), moved), { layer: "Lower third" }), true);
    assert.equal(fire("pvp.cue-started", snap(layer(), other), snap(layer(), moved), { layer: "Graphics" }), false);
    // Blank means any layer, so a half-built rule fires rather than never firing.
    assert.equal(fire("pvp.cue-started", snap(layer(), other), snap(layer(), moved), { layer: "" }), true);
    // And the name match ignores case and stray spaces, like every other one.
    assert.equal(fire("pvp.cue-started", snap(layer(), other), snap(layer(), moved), { layer: " lower THIRD " }), true);
  });

  test("layers are paired by UUID, not by position in the array", () => {
    // An operator reordering layers in PVP must not read as every layer changing
    // at once. Same two layers, swapped in the payload, nothing else different.
    const a = layer();
    const b = layer({ uuid: "l2", name: "Lower third", mediaUuid: "m2" });
    assert.equal(fire("pvp.cue-started", snap(a, b), snap(b, a)), false);
  });

  test("a layer clearing fires when playingMedia goes away", () => {
    assert.equal(fire("pvp.layer-cleared", snap(layer()), snap(layer(EMPTY))), true);
    assert.equal(fire("pvp.layer-cleared", snap(layer(EMPTY)), snap(layer())), false);
  });

  test("a layer VANISHING from the payload is not a clear", () => {
    // A layer PVP stopped reporting is unknown, not empty. The same rule "an
    // integration vanishing is not a disconnect" makes.
    assert.equal(fire("pvp.layer-cleared", snap(layer()), snap()), false);
  });

  test("a layer APPEARING in the payload is not an edge either", () => {
    // The other direction, and the one that actually bites: a layer we have
    // never seen before has no `before` to compare against, and treating a
    // missing `before` as "not empty" would fire a CLEARED rule for a layer that
    // has only just turned up empty. A workspace being opened would fire every
    // clear rule at once.
    const fresh = layer({ uuid: "l9", name: "New layer" });
    assert.equal(fire("pvp.layer-cleared", snap(layer()), snap(layer(), { ...fresh, ...EMPTY })), false);
    assert.equal(fire("pvp.cue-started", snap(layer()), snap(layer(), fresh)), false);
    assert.equal(fire("pvp.layer-hidden", snap(layer()), snap(layer(), { ...fresh, hidden: true })), false);
    assert.equal(fire("pvp.playback-stopped", snap(layer()), snap(layer(), { ...fresh, playbackRate: 0 })), false);
  });

  test("playback stopping fires when a rolling layer stops rolling", () => {
    assert.equal(
      fire("pvp.playback-stopped", snap(layer()), snap(layer({ state: "still", playbackRate: 0 }))),
      true,
    );
  });

  test("NOTHING fires because PVP went offline", () => {
    // A dropped connection reports an empty workspace, so the pairing alone
    // handles the shape the service actually emits. The `connected` check is
    // there for the shape it does NOT: a snapshot that still carries layers
    // while saying it is unreachable — a stale or partial frame. Both are
    // asserted, because the first on its own cannot tell a working guard from a
    // deleted one, and a guard that cannot go red is not a guard.
    const offlineEmpty = { connected: false, layers: [], sampledAt: null };
    const offlineStale = { connected: false, layers: [layer({ hidden: true, muted: true, ...EMPTY })], sampledAt: null };
    for (const id of Object.keys(AUTOMATION_TRIGGERS).filter((k) => k.startsWith("pvp.") && !k.endsWith("connected") && !k.endsWith("disconnected"))) {
      assert.equal(AUTOMATION_TRIGGERS[id].didFire(snap(layer()), offlineEmpty, {}, NOW), false, `${id} fired on an offline empty workspace`);
      assert.equal(AUTOMATION_TRIGGERS[id].didFire(snap(layer()), offlineStale, {}, NOW), false, `${id} fired on an offline workspace that still carried layers`);
    }
  });

  test("hide, unhide, mute and unmute each fire on their own edge", () => {
    assert.equal(fire("pvp.layer-hidden", snap(layer()), snap(layer({ hidden: true }))), true);
    assert.equal(fire("pvp.layer-hidden", snap(layer({ hidden: true })), snap(layer())), false);
    assert.equal(fire("pvp.layer-unhidden", snap(layer({ hidden: true })), snap(layer())), true);
    assert.equal(fire("pvp.layer-muted", snap(layer()), snap(layer({ muted: true }))), true);
    assert.equal(fire("pvp.layer-unmuted", snap(layer({ muted: true })), snap(layer())), true);
  });

  test("a hide edge is not also a mute edge", () => {
    // The two are generated from one function, and a generator that read the
    // wrong key would make every hidden layer fire the mute rule too.
    assert.equal(fire("pvp.layer-muted", snap(layer()), snap(layer({ hidden: true }))), false);
    assert.equal(fire("pvp.layer-hidden", snap(layer()), snap(layer({ muted: true }))), false);
  });

  test("every generated flag trigger is registered under the id it declares", () => {
    // A template-literal key and a hand-written `id` are exactly the pair that
    // can drift, and nothing else in the suite would notice.
    for (const [key, t] of Object.entries(AUTOMATION_TRIGGERS)) {
      if (key.startsWith("pvp.")) assert.equal(t.id, key, `${key} declares id ${t.id}`);
    }
  });

  test("no PVP trigger fires on a null prev", () => {
    // The restart guard. Asserted globally for every trigger elsewhere in this
    // file; named here too because these are the ones that would fire a whole
    // service's worth of rules at once after an update.
    for (const id of Object.keys(AUTOMATION_TRIGGERS).filter((k) => k.startsWith("pvp."))) {
      assert.equal(AUTOMATION_TRIGGERS[id].didFire(null, snap(layer()), {}, NOW), false, `${id} fired on a null prev`);
    }
  });

  test("every PVP trigger survives a malformed payload without throwing", () => {
    for (const id of Object.keys(AUTOMATION_TRIGGERS).filter((k) => k.startsWith("pvp."))) {
      for (const junk of [{}, { layers: null }, { layers: "no" }, { layers: [null, 7] }]) {
        assert.doesNotThrow(
          () => AUTOMATION_TRIGGERS[id].didFire(junk, junk, {}, NOW),
          `${id} threw on ${JSON.stringify(junk)}`,
        );
      }
    }
  });
});
