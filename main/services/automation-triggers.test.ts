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
