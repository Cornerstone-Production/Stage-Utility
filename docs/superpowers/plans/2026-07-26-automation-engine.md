# Automation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared rule engine — when something happens in Stage, do something to a device — with pluggable triggers and actions so each integration contributes rather than growing its own automation.

**Architecture:** The engine subscribes to the existing `broadcaster.ts` event bus (21 channels) and converts state **snapshots** into **edges** using a registry of pure `didFire(prev, next)` functions. Conditions and actions are two further registries. Only the action registry performs I/O, so the risky logic is pure and testable without a device.

**Tech Stack:** TypeScript, `node:net`-free (no new transports — actions reuse existing managers), `node:test` via `npm test`, React 19 renderer.

## Global Constraints

- **No test may perform device I/O.** Actions are tested through recording fakes; nothing dials real hardware.
- **`didFire` MUST return `false` when `prev` is null.** This is the restart guard; it is asserted for every trigger.
- Global simulate defaults **on**; each action provider honours `simulate` itself.
- The activity log records **fires AND suppressions**, with the reason.
- Cooldown defaults to **30 seconds**; `oncePerService` defaults to **false**.
- Conditions are exactly four: `service.is-live`, `service.type-is`, `time.day-of-week`, `time.between`.
- No emojis anywhere. Numeric fields use the themed `NumberInput`. Zero purple; dark surfaces strictly R=G=B.
- Unsaved state uses the shared neutral `UnsavedBanner`, never a bespoke bar.
- Commits follow Conventional Commits (`docs/contributing.md`) and end with the repo's `Co-Authored-By` / `Claude-Session` trailers.

**Prerequisite:** `rosstalkManager.send()` must exist for the `rosstalk.command` action (PR #131). Everything else in this plan is independent of it — if RossTalk has not landed, omit that one action entry and its test; nothing else changes.

## File Structure

| File | Responsibility |
|---|---|
| `main/types/automation.ts` | `Rule`, `TriggerDef`, `ConditionDef`, `ActionDef`, `ParamDef`, `LogEntry` |
| `main/services/automation-triggers.ts` | Trigger registry — **pure**, no I/O |
| `main/services/automation-triggers.test.ts` | Edge cases per trigger, incl. the restart guard |
| `main/services/automation-conditions.ts` | Condition registry — **pure**, no I/O |
| `main/services/automation-conditions.test.ts` | Each condition holds/fails; unknown id fails closed |
| `main/services/automation-actions.ts` | Action registry — the only I/O |
| `main/services/automation-log.ts` | Activity log (capped, persisted) |
| `main/services/automation-store.ts` | Persisted rules + simulate + panic |
| `main/services/automation-engine.ts` | Bus subscriber, edge detection, dispatch |
| `main/services/automation-engine.test.ts` | Cooldown, once-per-service, panic, simulate, restart seeding |
| `main/services/routes/automation-routes.ts` | `/api/automation/*` |
| `renderer/settings/sections/automation-section.tsx` | The guided builder + activity log |

---

### Task 1: Types

**Files:**
- Create: `main/types/automation.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ParamDef`, `TriggerDef`, `ConditionDef`, `ActionDef`, `ActionResult`, `Rule`, `AutomationLogEntry`, `AutomationSettings`.

- [ ] **Step 1: Write the types**

```ts
// Types for the automation engine — "when X happens in Stage, do Y to a device".
// See docs/superpowers/specs/2026-07-26-automation-engine-design.md.

/** A typed parameter on a trigger, condition or action — renders a form field. */
export interface ParamDef {
  key: string;
  label: string;
  type: "number" | "string" | "enum" | "multi-enum";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  /** Options that can only be known at runtime (targets, service types, commands). */
  optionsFrom?: "rosstalk-targets" | "rosstalk-commands" | "osc-targets" | "service-types" | "displays";
  optional?: boolean;
  help?: string;
}

export interface TriggerDef {
  id: string;
  label: string;
  /** Broadcast channel to watch, or "clock" for the internal timer. */
  channel: string;
  params: ParamDef[];
  /**
   * PURE. Did this fire on the transition prev -> next?
   * MUST return false when `prev` is null — that is the restart guard.
   */
  didFire(prev: unknown | null, next: unknown, params: Record<string, unknown>, now: number): boolean;
  help?: string;
}

export interface ConditionDef {
  id: string;
  label: string;
  params: ParamDef[];
  /** PURE. Does this qualifier hold right now? */
  holds(ctx: ConditionCtx, params: Record<string, unknown>, now: number): boolean;
}

/** The current-state snapshot conditions are evaluated against. */
export interface ConditionCtx {
  pcoLive: { mode: string; serviceTimeId: string | null } | null;
  serviceTypeId: string | null;
}

export interface ActionResult {
  ok: boolean;
  detail: string;
}

export interface ActionDef {
  id: string;
  label: string;
  params: ParamDef[];
  /** NEVER throws — a failure is a returned result, so one bad provider cannot
   *  stop the engine or block other rules. */
  run(params: Record<string, unknown>, ctx: { simulate: boolean }): Promise<ActionResult>;
  help?: string;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { id: string; params: Record<string, string | number> };
  conditions: { id: string; params: Record<string, string | number> }[];
  action: { id: string; params: Record<string, string | number> };
  /** Seconds since this rule last fired before it may fire again. */
  cooldownSec: number;
  /** Fire at most once per PCO service occurrence (keyed on serviceTimeId). */
  oncePerService: boolean;
}

export type AutomationOutcome = "fired" | "failed" | "simulated" | "suppressed" | "condition-not-met";

export interface AutomationLogEntry {
  at: string;
  ruleId: string;
  ruleName: string;
  triggerId: string;
  actionId: string;
  outcome: AutomationOutcome;
  /** The resolved action detail, or the suppression reason. */
  detail: string;
}

export interface AutomationSettings {
  simulate: boolean;
  /** Panic — disables every rule regardless of its own enabled flag. */
  disarmed: boolean;
}
```

- [ ] **Step 2: Type-check and commit**

```bash
npm run type-check
git add main/types/automation.ts
git commit -m "feat(automation): types for rules, triggers, conditions and actions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 2: Trigger registry

The highest-risk piece and the one with the most tests. Pure functions only.

**Files:**
- Create: `main/services/automation-triggers.ts`
- Test: `main/services/automation-triggers.test.ts`

**Interfaces:**
- Consumes: `TriggerDef` (Task 1).
- Produces: `AUTOMATION_TRIGGERS: Record<string, TriggerDef>`, `triggersForChannel(channel: string): TriggerDef[]`.

- [ ] **Step 1: Write the failing tests**

Create `main/services/automation-triggers.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: FAIL — `Cannot find module './automation-triggers.js'`

- [ ] **Step 3: Implement the registry**

Create `main/services/automation-triggers.ts`:

```ts
// automation-triggers.ts — the trigger registry.
//
// PURE: no I/O, no wall-clock reads beyond the `now` passed in. Every entry turns a
// pair of state SNAPSHOTS into a yes/no "did this fire", which is what converts the
// broadcaster's constantly-repeated state into edges.
//
// THE CONTRACT: didFire MUST return false when `prev` is null. On startup the engine
// has no previous snapshot; treating that as a transition would fire every rule at
// once after an update or crash mid-service, unattended. Asserted for every trigger
// in automation-triggers.test.ts.

import type { ParamDef, TriggerDef } from "../types/automation.js";

type Live = { mode?: string; currentItemTitle?: string | null; serviceTimeStartsAt?: string | null };
type People = { total?: { attendance?: number | null; occupancy?: number | null } | null };
type Rec = { connected?: boolean; recording?: boolean };

const asLive = (v: unknown): Live => (v && typeof v === "object" ? (v as Live) : {});
const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const metricOf = (v: unknown, metric: string): number | null => {
  const t = (v && typeof v === "object" ? (v as People).total : null) ?? null;
  const n = t ? (metric === "occupancy" ? t.occupancy : t.attendance) : null;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const METRIC: ParamDef = {
  key: "metric",
  label: "Metric",
  type: "enum",
  options: [
    { value: "attendance", label: "Attendance (entered)" },
    { value: "occupancy", label: "Occupancy (in room)" },
  ],
};

function def(t: TriggerDef): TriggerDef {
  return t;
}

export const AUTOMATION_TRIGGERS: Record<string, TriggerDef> = {
  "pco.service-started": def({
    id: "pco.service-started",
    label: "Service goes live",
    channel: "pco:live",
    params: [],
    help: "Fires the moment PCO Live moves from pre-service into the plan.",
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asLive(prev).mode !== "item" && asLive(next).mode === "item";
    },
  }),

  "pco.service-ended": def({
    id: "pco.service-ended",
    label: "Service ends",
    channel: "pco:live",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asLive(prev).mode === "item" && asLive(next).mode !== "item";
    },
  }),

  "pco.item-reached": def({
    id: "pco.item-reached",
    label: "Plan reaches an item",
    channel: "pco:live",
    params: [{ key: "title", label: "Item title contains", type: "string", help: "Case-insensitive, matches part of the title" }],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const want = String(params.title ?? "").trim().toLowerCase();
      if (!want) return false;
      const before = (asLive(prev).currentItemTitle ?? "").toLowerCase();
      const after = (asLive(next).currentItemTitle ?? "").toLowerCase();
      // Fire on the transition INTO a matching item, not while sitting on it.
      return !before.includes(want) && after.includes(want);
    },
  }),

  "occupancy.crossed-above": def({
    id: "occupancy.crossed-above",
    label: "People count rises above",
    channel: "people:count",
    params: [{ key: "threshold", label: "Threshold", type: "number", min: 0, max: 100000 }, METRIC],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const metric = String(params.metric ?? "attendance");
      const a = metricOf(prev, metric);
      const b = metricOf(next, metric);
      if (a === null || b === null) return false; // no baseline, no crossing
      const th = Number(params.threshold);
      return Number.isFinite(th) && a <= th && b > th;
    },
  }),

  "occupancy.crossed-below": def({
    id: "occupancy.crossed-below",
    label: "People count falls below",
    channel: "people:count",
    params: [{ key: "threshold", label: "Threshold", type: "number", min: 0, max: 100000 }, METRIC],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const metric = String(params.metric ?? "attendance");
      const a = metricOf(prev, metric);
      const b = metricOf(next, metric);
      if (a === null || b === null) return false;
      const th = Number(params.threshold);
      return Number.isFinite(th) && a >= th && b < th;
    },
  }),

  "recording.started": def({
    id: "recording.started",
    label: "Recording starts",
    channel: "obs:status",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return !asRec(prev).recording && asRec(next).recording === true;
    },
  }),

  "recording.stopped": def({
    id: "recording.stopped",
    label: "Recording stops",
    channel: "obs:status",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      const p = asRec(prev);
      const n = asRec(next);
      // A recorder dropping off the network is UNKNOWN, not "stopped" — firing a
      // stop rule because a machine went offline would be wrong.
      if (n.connected === false) return false;
      return p.recording === true && n.recording === false;
    },
  }),
};

export function triggersForChannel(channel: string): TriggerDef[] {
  return Object.values(AUTOMATION_TRIGGERS).filter((t) => t.channel === channel);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: PASS, 0 fail.

- [ ] **Step 5: Prove the restart guard test actually works**

Break it deliberately; the guard test must fail. Then restore:

```bash
perl -0pi -e 's/if \(prev === null\) return false;\n      return asLive\(prev\)\.mode !== "item"/return asLive(prev)?.mode !== "item"/' main/services/automation-triggers.ts
npm test 2>&1 | grep -E "^. fail"   # expect: fail 1 or more
git checkout main/services/automation-triggers.ts
```

- [ ] **Step 6: Type-check, lint and commit**

```bash
npm run type-check && npm run lint
git add main/services/automation-triggers.ts main/services/automation-triggers.test.ts
git commit -m "feat(automation): trigger registry with pure edge detection

The broadcast channels carry state snapshots, re-sent constantly, so a trigger
that fired on a level would fire dozens of times per service. Every entry is a
pure didFire(prev, next) turning two snapshots into an edge, testable with no
device and no running service.

didFire returns false when prev is null — the restart guard. Without it an update
or crash mid-service would re-seed state and fire every rule at once, unattended.
Asserted for every trigger.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 3: Condition registry

**Files:**
- Create: `main/services/automation-conditions.ts`
- Test: `main/services/automation-conditions.test.ts`

**Interfaces:**
- Consumes: `ConditionDef`, `ConditionCtx` (Task 1).
- Produces: `AUTOMATION_CONDITIONS: Record<string, ConditionDef>`, `allConditionsHold(list, ctx, now): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `main/services/automation-conditions.test.ts`:

```ts
// Conditions are the cross-cutting qualifiers — "only during a service", "only on
// Sundays". Without them the trigger list would explode into combinations like
// occupancy.crossed-above-during-service-on-sunday.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { AUTOMATION_CONDITIONS, allConditionsHold } from "./automation-conditions.js";
import type { ConditionCtx } from "../types/automation.js";

// Sunday 2026-07-26 is a Sunday; 10:00 local.
const SUNDAY_10AM = Date.parse("2026-07-26T10:00:00Z");
const ctx = (over: Partial<ConditionCtx> = {}): ConditionCtx => ({
  pcoLive: { mode: "item", serviceTimeId: "st1" },
  serviceTypeId: "weekend",
  ...over,
});

describe("service.is-live", () => {
  const c = AUTOMATION_CONDITIONS["service.is-live"];
  test("holds while an item is live", () => {
    assert.equal(c.holds(ctx(), {}, SUNDAY_10AM), true);
  });
  test("does not hold pre-service or when nothing is live", () => {
    assert.equal(c.holds(ctx({ pcoLive: { mode: "preservice", serviceTimeId: null } }), {}, SUNDAY_10AM), false);
    assert.equal(c.holds(ctx({ pcoLive: null }), {}, SUNDAY_10AM), false);
  });
});

describe("service.type-is", () => {
  const c = AUTOMATION_CONDITIONS["service.type-is"];
  test("holds when the active service type matches", () => {
    assert.equal(c.holds(ctx(), { serviceTypeId: "weekend" }, SUNDAY_10AM), true);
    assert.equal(c.holds(ctx(), { serviceTypeId: "youth" }, SUNDAY_10AM), false);
  });
  test("does not hold when no service type is active", () => {
    assert.equal(c.holds(ctx({ serviceTypeId: null }), { serviceTypeId: "weekend" }, SUNDAY_10AM), false);
  });
});

describe("time.day-of-week", () => {
  const c = AUTOMATION_CONDITIONS["time.day-of-week"];
  test("holds on a selected day", () => {
    const sunday = new Date(SUNDAY_10AM).getDay(); // local day index
    assert.equal(c.holds(ctx(), { days: String(sunday) }, SUNDAY_10AM), true);
  });
  test("does not hold on an unselected day", () => {
    const notToday = (new Date(SUNDAY_10AM).getDay() + 1) % 7;
    assert.equal(c.holds(ctx(), { days: String(notToday) }, SUNDAY_10AM), false);
  });
  test("accepts a comma-separated list", () => {
    const today = new Date(SUNDAY_10AM).getDay();
    assert.equal(c.holds(ctx(), { days: `${(today + 3) % 7},${today}` }, SUNDAY_10AM), true);
  });
  test("an empty selection holds — an unconfigured condition must not block", () => {
    assert.equal(c.holds(ctx(), { days: "" }, SUNDAY_10AM), true);
  });
});

describe("time.between", () => {
  const c = AUTOMATION_CONDITIONS["time.between"];
  const at = (h: number, m = 0) => {
    const d = new Date(SUNDAY_10AM);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  test("holds inside the window", () => {
    assert.equal(c.holds(ctx(), { from: "09:00", to: "12:00" }, at(10)), true);
  });
  test("does not hold outside it", () => {
    assert.equal(c.holds(ctx(), { from: "09:00", to: "12:00" }, at(8)), false);
    assert.equal(c.holds(ctx(), { from: "09:00", to: "12:00" }, at(13)), false);
  });
  test("handles a window crossing midnight", () => {
    assert.equal(c.holds(ctx(), { from: "22:00", to: "02:00" }, at(23)), true);
    assert.equal(c.holds(ctx(), { from: "22:00", to: "02:00" }, at(1)), true);
    assert.equal(c.holds(ctx(), { from: "22:00", to: "02:00" }, at(12)), false);
  });
});

describe("allConditionsHold", () => {
  test("an empty list always holds", () => {
    assert.equal(allConditionsHold([], ctx(), SUNDAY_10AM), true);
  });
  test("every condition must hold", () => {
    const ok = { id: "service.is-live", params: {} };
    const no = { id: "service.type-is", params: { serviceTypeId: "youth" } };
    assert.equal(allConditionsHold([ok], ctx(), SUNDAY_10AM), true);
    assert.equal(allConditionsHold([ok, no], ctx(), SUNDAY_10AM), false);
  });
  test("an unknown condition id fails CLOSED", () => {
    // A rule referencing a condition this build does not have must not fire.
    assert.equal(allConditionsHold([{ id: "nope", params: {} }], ctx(), SUNDAY_10AM), false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: FAIL — `Cannot find module './automation-conditions.js'`

- [ ] **Step 3: Implement**

Create `main/services/automation-conditions.ts`:

```ts
// automation-conditions.ts — the four cross-cutting qualifiers.
//
// The test for whether something belongs here rather than as a trigger param: does
// it apply across triggers? "Which PCO item" only means something to the plan
// trigger (a param). "Only on Sundays" applies to every trigger (a condition).
//
// Four is the whole list on purpose. If a rule needs more, the answer is a better
// trigger, not a query language.

import type { ConditionCtx, ConditionDef } from "../types/automation.js";

/** "HH:MM" -> minutes since midnight, or null. */
function hhmm(v: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export const AUTOMATION_CONDITIONS: Record<string, ConditionDef> = {
  "service.is-live": {
    id: "service.is-live",
    label: "A service is live",
    params: [],
    holds: (ctx) => ctx.pcoLive?.mode === "item",
  },

  "service.type-is": {
    id: "service.type-is",
    label: "Service type is",
    params: [{ key: "serviceTypeId", label: "Service type", type: "enum", optionsFrom: "service-types" }],
    holds: (ctx, params) => {
      const want = String(params.serviceTypeId ?? "");
      return !!want && ctx.serviceTypeId === want;
    },
  },

  "time.day-of-week": {
    id: "time.day-of-week",
    label: "Day of week is",
    params: [{
      key: "days",
      label: "Days",
      type: "multi-enum",
      options: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => ({ value: String(i), label: d })),
    }],
    holds: (_ctx, params, now) => {
      const raw = String(params.days ?? "").trim();
      // Unconfigured must not silently block every rule that carries it.
      if (!raw) return true;
      const days = raw.split(",").map((d) => Number(d.trim()));
      return days.includes(new Date(now).getDay());
    },
  },

  "time.between": {
    id: "time.between",
    label: "Time is between",
    params: [
      { key: "from", label: "From", type: "string", help: "HH:MM, 24-hour" },
      { key: "to", label: "To", type: "string", help: "HH:MM, 24-hour" },
    ],
    holds: (_ctx, params, now) => {
      const from = hhmm(params.from);
      const to = hhmm(params.to);
      if (from === null || to === null) return true; // unconfigured -> no opinion
      const d = new Date(now);
      const cur = d.getHours() * 60 + d.getMinutes();
      // A window may cross midnight (22:00 -> 02:00).
      return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
    },
  },
};

/** Every condition must hold. An unknown id fails CLOSED: a rule referencing a
 *  condition this build does not have must not fire. */
export function allConditionsHold(
  list: { id: string; params: Record<string, string | number> }[],
  ctx: ConditionCtx,
  now: number,
): boolean {
  for (const c of list) {
    const def = AUTOMATION_CONDITIONS[c.id];
    if (!def) return false;
    if (!def.holds(ctx, c.params, now)) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run type-check && npm run lint
git add main/services/automation-conditions.ts main/services/automation-conditions.test.ts
git commit -m "feat(automation): condition registry — four cross-cutting qualifiers

An unknown condition id fails CLOSED, so a rule referencing a condition this
build does not have never fires.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 4: Activity log and store

**Files:**
- Create: `main/services/automation-log.ts`
- Create: `main/services/automation-store.ts`

**Interfaces:**
- Consumes: `AutomationLogEntry`, `Rule`, `AutomationSettings` (Task 1).
- Produces: `automationLog.add(entry)`, `automationLog.list()`, `automationLog.clear()`; `automationStore.loadRules()`, `saveRules(r)`, `loadSettings()`, `saveSettings(s)`.

- [ ] **Step 1: Implement the log**

Create `main/services/automation-log.ts`:

```ts
// automation-log.ts — what the engine did, and what it declined to do.
//
// Suppressions are logged as loudly as fires. A suppressed rule is otherwise
// invisible, and "my rule did not run and I do not know why" is far harder to debug
// than "it ran twice".

import type { AutomationLogEntry } from "../types/automation.js";
import { broadcast } from "./broadcaster.js";
import { DataStore } from "./data-store.js";

/** Enough to cover several services; small enough to keep in memory and on disk. */
const CAP = 500;

const store = new DataStore<AutomationLogEntry[]>("automation-log.json", []);
let entries: AutomationLogEntry[] = [];
let loaded = false;

export const automationLog = {
  async init(): Promise<void> {
    entries = await store.load();
    loaded = true;
  },

  add(entry: AutomationLogEntry): void {
    entries = [entry, ...entries].slice(0, CAP);
    broadcast("automation:log", { entries: entries.slice(0, 50) });
    // Fire-and-forget: losing the tail of the log on a hard kill is acceptable,
    // blocking a rule's dispatch on a disk write is not.
    if (loaded) void store.save(entries).catch(() => {});
  },

  list(): AutomationLogEntry[] {
    return entries;
  },

  async clear(): Promise<void> {
    entries = [];
    await store.save(entries);
    broadcast("automation:log", { entries: [] });
  },
};
```

- [ ] **Step 2: Implement the store**

Create `main/services/automation-store.ts`:

```ts
// Persisted rules + the two global flags.
//
// simulate defaults TRUE and disarmed defaults FALSE: a fresh install evaluates
// rules and logs what they would do, but cannot command anything.

import type { AutomationSettings, Rule } from "../types/automation.js";
import { DataStore } from "./data-store.js";

const rules = new DataStore<Rule[]>("automation-rules.json", []);
const settings = new DataStore<AutomationSettings>("automation-settings.json", {
  simulate: true,
  disarmed: false,
});

export const automationStore = {
  async loadRules(): Promise<Rule[]> {
    return rules.load();
  },
  async saveRules(next: Rule[]): Promise<void> {
    return rules.save(next);
  },
  async loadSettings(): Promise<AutomationSettings> {
    const s = await settings.load();
    return { simulate: s.simulate !== false, disarmed: s.disarmed === true };
  },
  async saveSettings(patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
    return settings.update((c) => ({ ...c, ...patch }));
  },
};
```

- [ ] **Step 3: Type-check and commit**

```bash
npm run type-check
git add main/services/automation-log.ts main/services/automation-store.ts
git commit -m "feat(automation): activity log and rule store

Suppressions are logged as loudly as fires — a suppressed rule is otherwise
invisible, and 'it did not run and I do not know why' is harder to debug than
'it ran twice'.

simulate defaults true and disarmed defaults false, so a fresh install evaluates
rules and logs what they would do but cannot command anything.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 5: Action registry

**Files:**
- Create: `main/services/automation-actions.ts`

**Interfaces:**
- Consumes: `ActionDef`, `ActionResult` (Task 1); `oscManager.send()`, `rosstalkManager.send()`, `broadcast()`.
- Produces: `AUTOMATION_ACTIONS: Record<string, ActionDef>`.

- [ ] **Step 1: Implement**

Create `main/services/automation-actions.ts`:

```ts
// automation-actions.ts — the ONLY part of the engine that touches hardware.
//
// Each provider honours `simulate` itself, so suppression happens at the one place
// that does I/O rather than being trusted to the engine. No provider throws: a
// failure is a returned result, so one bad device cannot stop the engine or block
// the next rule.

import type { ActionDef, ActionResult } from "../types/automation.js";
import { broadcast } from "./broadcaster.js";
import { oscManager } from "./osc-manager.js";
import { rosstalkManager } from "./rosstalk-manager.js";

const ok = (detail: string): ActionResult => ({ ok: true, detail });
const fail = (detail: string): ActionResult => ({ ok: false, detail });

export const AUTOMATION_ACTIONS: Record<string, ActionDef> = {
  "log.message": {
    id: "log.message",
    label: "Write a log message",
    help: "Does nothing else. Use it to prove a rule fires at the right moment before pointing it at real gear.",
    params: [{ key: "message", label: "Message", type: "string" }],
    run: async (params) => ok(String(params.message ?? "(no message)")),
  },

  "rosstalk.command": {
    id: "rosstalk.command",
    label: "Send a RossTalk command",
    params: [
      { key: "targetId", label: "Target", type: "enum", optionsFrom: "rosstalk-targets" },
      { key: "commandId", label: "Command", type: "enum", optionsFrom: "rosstalk-commands" },
    ],
    run: async (params, ctx) => {
      try {
        // RossTalk has its OWN simulate too; they compose by AND, so a command
        // reaches the wire only when both are off.
        if (ctx.simulate) return ok(`would send ${String(params.commandId)}`);
        const r = await rosstalkManager.send(String(params.targetId), {
          commandId: String(params.commandId),
          params: params as Record<string, string | number>,
        });
        return ok(`${r.line}${r.simulated ? " (RossTalk simulate)" : ""}`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  },

  "osc.send": {
    id: "osc.send",
    label: "Send an OSC message",
    params: [
      { key: "targetId", label: "Target", type: "enum", optionsFrom: "osc-targets" },
      { key: "address", label: "Address", type: "string", help: "e.g. /ch/01/mix/on" },
    ],
    run: async (params, ctx) => {
      try {
        if (ctx.simulate) return ok(`would send ${String(params.address)}`);
        await oscManager.send(String(params.targetId), String(params.address), []);
        return ok(`sent ${String(params.address)}`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  },

  "display.refresh": {
    id: "display.refresh",
    label: "Refresh all displays",
    params: [],
    run: async (_params, ctx) => {
      if (ctx.simulate) return ok("would refresh displays");
      broadcast("display:refresh", { at: new Date().toISOString() });
      return ok("refreshed displays");
    },
  },
};
```

- [ ] **Step 2: Type-check and commit**

```bash
npm run type-check && npm run lint
git add main/services/automation-actions.ts
git commit -m "feat(automation): action registry

Each provider honours simulate itself, so suppression happens where the I/O is
rather than being trusted to the engine. No provider throws — a failure is a
returned result, so one bad device cannot block the next rule.

log.message is not filler: it is how a rule is validated against a real service
without touching gear.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 6: The engine

**Files:**
- Create: `main/services/automation-engine.ts`
- Test: `main/services/automation-engine.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `automationEngine.init()`, `listRules()`, `addRule()`, `updateRule()`, `removeRule()`, `testFire(id)`, `getSettings()`, `setSettings(patch)`, and (for tests) `__handleBroadcast(channel, payload, now)`.

- [ ] **Step 1: Write the failing tests**

Create `main/services/automation-engine.test.ts`:

```ts
// Engine tests: the dispatch rules that sit around the pure registries.
//
// Everything here runs through synthetic broadcasts and a recording fake action —
// no sockets, no devices.

import assert from "node:assert/strict";
import { test, describe, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-automation-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { automationEngine } = await import("./automation-engine.js");
const { automationLog } = await import("./automation-log.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const NOW = Date.parse("2026-07-26T10:00:00Z");
const live = (mode: string) => ({ mode, currentItemTitle: null, serviceTimeId: "st1" });

async function ruleFiringOnServiceStart(over: Record<string, unknown> = {}) {
  const rules = await automationEngine.listRules();
  for (const r of rules) await automationEngine.removeRule(r.id);
  await automationLog.clear();
  const r = await automationEngine.addRule({
    name: "test rule",
    enabled: true,
    trigger: { id: "pco.service-started", params: {} },
    conditions: [],
    action: { id: "log.message", params: { message: "fired" } },
    cooldownSec: 0,
    oncePerService: false,
    ...over,
  });
  return r.id;
}

/** How many log entries record an actual fire (not a suppression)? */
const fires = () => automationLog.list().filter((e) => e.outcome === "fired" || e.outcome === "simulated").length;

describe("dispatch", () => {
  beforeEach(async () => {
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: true, disarmed: false });
  });

  test("a rule fires on its trigger's edge", async () => {
    await ruleFiringOnServiceStart();
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW); // seeds
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(fires(), 1);
  });

  test("THE RESTART GUARD: the first snapshot after start never fires", async () => {
    await ruleFiringOnServiceStart();
    // Engine restarts mid-service: the very first thing it sees is mode "item".
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW);
    assert.equal(fires(), 0, "seeding must never fire — this is the worst failure mode");
  });

  test("an identical repeated snapshot never fires twice", async () => {
    await ruleFiringOnServiceStart();
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 2000);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 3000);
    assert.equal(fires(), 1);
  });

  test("a disabled rule never fires", async () => {
    await ruleFiringOnServiceStart({ enabled: false });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(fires(), 0);
  });

  test("panic disarms every rule", async () => {
    await ruleFiringOnServiceStart();
    await automationEngine.setSettings({ disarmed: true });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(fires(), 0);
  });
});

describe("suppression", () => {
  beforeEach(async () => {
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: true, disarmed: false });
  });

  test("cooldown blocks a second fire and is logged with a reason", async () => {
    await ruleFiringOnServiceStart({ cooldownSec: 60 });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW + 2000);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 3000);

    assert.equal(fires(), 1, "the second edge is inside the cooldown");
    const suppressed = automationLog.list().filter((e) => e.outcome === "suppressed");
    assert.equal(suppressed.length, 1);
    assert.match(suppressed[0].detail, /cooldown/i, "the reason must be visible, not silent");
  });

  test("cooldown permits a fire once it has elapsed", async () => {
    await ruleFiringOnServiceStart({ cooldownSec: 10 });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW + 2000);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 60_000);
    assert.equal(fires(), 2);
  });

  test("oncePerService fires once across repeated edges in one service", async () => {
    await ruleFiringOnServiceStart({ oncePerService: true, cooldownSec: 0 });
    for (const t of [0, 1000, 2000, 3000]) {
      await automationEngine.__handleBroadcast("pco:live", { ...live("preservice"), serviceTimeId: "st1" }, NOW + t);
      await automationEngine.__handleBroadcast("pco:live", { ...live("item"), serviceTimeId: "st1" }, NOW + t + 500);
    }
    assert.equal(fires(), 1);
  });

  test("oncePerService fires again for a different service", async () => {
    await ruleFiringOnServiceStart({ oncePerService: true, cooldownSec: 0 });
    await automationEngine.__handleBroadcast("pco:live", { ...live("preservice"), serviceTimeId: "st1" }, NOW);
    await automationEngine.__handleBroadcast("pco:live", { ...live("item"), serviceTimeId: "st1" }, NOW + 1000);
    await automationEngine.__handleBroadcast("pco:live", { ...live("preservice"), serviceTimeId: "st2" }, NOW + 2000);
    await automationEngine.__handleBroadcast("pco:live", { ...live("item"), serviceTimeId: "st2" }, NOW + 3000);
    assert.equal(fires(), 2);
  });

  test("a failed condition is logged rather than silently dropped", async () => {
    await ruleFiringOnServiceStart({
      conditions: [{ id: "service.type-is", params: { serviceTypeId: "nope" } }],
    });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(fires(), 0);
    assert.ok(automationLog.list().some((e) => e.outcome === "condition-not-met"));
  });
});

describe("simulate and test-fire", () => {
  beforeEach(async () => {
    await automationEngine.init();
  });

  test("simulate records the action as simulated, never as fired", async () => {
    await automationEngine.setSettings({ simulate: true, disarmed: false });
    await ruleFiringOnServiceStart();
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(automationLog.list()[0].outcome, "simulated");
  });

  test("test fire runs the action ignoring the trigger, and respects disabled", async () => {
    await automationEngine.setSettings({ simulate: true, disarmed: false });
    const id = await ruleFiringOnServiceStart({ enabled: false });
    const r = await automationEngine.testFire(id);
    assert.equal(r.ok, true, "test fire is explicit operator intent — it runs even when disabled");
    assert.equal(fires(), 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: FAIL — `Cannot find module './automation-engine.js'`

- [ ] **Step 3: Implement the engine**

Create `main/services/automation-engine.ts`:

```ts
// automation-engine.ts — subscribes to the broadcast bus and runs the rules.
//
// The bus carries state SNAPSHOTS, so the engine keeps the previous snapshot per
// channel and asks each trigger's pure didFire whether an EDGE occurred.
//
// The most important line in this file is the seeding guard in handleBroadcast:
// the first snapshot on a channel is stored and never evaluated. Without it a
// restart mid-service would read the first snapshot as a transition and fire every
// rule at once, unattended.

import { randomUUID } from "node:crypto";

import type { AutomationSettings, ConditionCtx, Rule } from "../types/automation.js";
import { addBroadcastListener, broadcast } from "./broadcaster.js";
import { AUTOMATION_ACTIONS } from "./automation-actions.js";
import { allConditionsHold } from "./automation-conditions.js";
import { automationLog } from "./automation-log.js";
import { automationStore } from "./automation-store.js";
import { AUTOMATION_TRIGGERS, triggersForChannel } from "./automation-triggers.js";
import { stageController } from "./stage-controller.js";

class AutomationEngine {
  private rules: Rule[] = [];
  private settings: AutomationSettings = { simulate: true, disarmed: false };
  /** Last snapshot seen per channel. Absent = not yet seeded. */
  private prev = new Map<string, unknown>();
  private lastFiredAt = new Map<string, number>();
  private firedForService = new Map<string, string>();
  private subscribed = false;

  async init(): Promise<void> {
    await automationLog.init();
    this.rules = await automationStore.loadRules();
    this.settings = await automationStore.loadSettings();
    // Re-seeding on every init is deliberate: a restart must never inherit stale
    // edges from the previous process.
    this.prev.clear();
    this.lastFiredAt.clear();
    this.firedForService.clear();

    if (!this.subscribed) {
      this.subscribed = true;
      addBroadcastListener((channel, payload) => {
        // Never recurse on our own channels.
        if (channel.startsWith("automation:")) return;
        void this.handleBroadcast(channel, payload, Date.now());
      });
    }
  }

  listRules(): Rule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  getSettings(): AutomationSettings {
    return { ...this.settings };
  }

  async setSettings(patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
    this.settings = await automationStore.saveSettings(patch);
    broadcast("automation:settings", this.getSettings());
    return this.getSettings();
  }

  async addRule(rule: Omit<Rule, "id">): Promise<Rule> {
    const next: Rule = { ...rule, id: randomUUID() };
    this.rules.push(next);
    await automationStore.saveRules(this.rules);
    broadcast("automation:rules", { rules: this.listRules() });
    return next;
  }

  async updateRule(id: string, patch: Partial<Omit<Rule, "id">>): Promise<Rule[]> {
    const r = this.rules.find((x) => x.id === id);
    if (!r) throw new Error(`Automation: unknown rule ${id}`);
    Object.assign(r, patch);
    await automationStore.saveRules(this.rules);
    broadcast("automation:rules", { rules: this.listRules() });
    return this.listRules();
  }

  async removeRule(id: string): Promise<Rule[]> {
    this.rules = this.rules.filter((r) => r.id !== id);
    await automationStore.saveRules(this.rules);
    broadcast("automation:rules", { rules: this.listRules() });
    return this.listRules();
  }

  /** Run a rule's action now, ignoring its trigger. Explicit operator intent, so it
   *  runs even for a disabled rule — but still honours simulate. */
  async testFire(id: string): Promise<{ ok: boolean; detail: string }> {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw new Error(`Automation: unknown rule ${id}`);
    return this.runAction(rule, "test fire");
  }

  /** Exposed for tests — drives the engine with a synthetic broadcast. */
  async __handleBroadcast(channel: string, payload: unknown, now: number): Promise<void> {
    return this.handleBroadcast(channel, payload, now);
  }

  private async handleBroadcast(channel: string, payload: unknown, now: number): Promise<void> {
    const triggers = triggersForChannel(channel);
    if (triggers.length === 0) return;

    const had = this.prev.has(channel);
    const prev = this.prev.get(channel) ?? null;
    this.prev.set(channel, payload);
    // SEEDING: the first snapshot on a channel establishes a baseline and is never
    // evaluated. This is what stops a restart mid-service firing everything.
    if (!had) return;

    if (this.settings.disarmed) return;

    const ctx = this.conditionCtx();
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const trigger = AUTOMATION_TRIGGERS[rule.trigger.id];
      if (!trigger || trigger.channel !== channel) continue;

      let fired = false;
      try {
        fired = trigger.didFire(prev, payload, rule.trigger.params, now);
      } catch {
        // A malformed payload must not take the engine down.
        fired = false;
      }
      if (!fired) continue;

      if (!allConditionsHold(rule.conditions, ctx, now)) {
        this.log(rule, "condition-not-met", "a condition did not hold");
        continue;
      }

      const suppression = this.suppressionFor(rule, now);
      if (suppression) {
        this.log(rule, "suppressed", suppression);
        continue;
      }

      this.lastFiredAt.set(rule.id, now);
      if (rule.oncePerService) {
        const key = this.serviceKey();
        if (key) this.firedForService.set(rule.id, key);
      }
      await this.runAction(rule, "trigger");
    }
  }

  /** Why this rule may not fire right now, or null if it may. */
  private suppressionFor(rule: Rule, now: number): string | null {
    const last = this.lastFiredAt.get(rule.id);
    if (last !== undefined && rule.cooldownSec > 0) {
      const remaining = Math.ceil((last + rule.cooldownSec * 1000 - now) / 1000);
      if (remaining > 0) return `cooldown (${remaining}s remaining)`;
    }
    if (rule.oncePerService) {
      const key = this.serviceKey();
      if (key && this.firedForService.get(rule.id) === key) {
        return "already fired this service";
      }
    }
    return null;
  }

  private async runAction(rule: Rule, why: string): Promise<{ ok: boolean; detail: string }> {
    const action = AUTOMATION_ACTIONS[rule.action.id];
    if (!action) {
      const detail = `unknown action "${rule.action.id}"`;
      this.log(rule, "failed", detail);
      return { ok: false, detail };
    }
    let result: { ok: boolean; detail: string };
    try {
      result = await action.run(rule.action.params, { simulate: this.settings.simulate });
    } catch (e) {
      // A provider is contractually not supposed to throw; if one does, it must not
      // stop the engine or the next rule.
      result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    const outcome = !result.ok ? "failed" : this.settings.simulate ? "simulated" : "fired";
    this.log(rule, outcome, `${result.detail} (${why})`);
    return result;
  }

  private log(rule: Rule, outcome: Parameters<typeof automationLog.add>[0]["outcome"], detail: string): void {
    automationLog.add({
      at: new Date().toISOString(),
      ruleId: rule.id,
      ruleName: rule.name,
      triggerId: rule.trigger.id,
      actionId: rule.action.id,
      outcome,
      detail,
    });
  }

  private conditionCtx(): ConditionCtx {
    const live = stageController.getLastLive();
    const state = stageController.getState();
    return {
      pcoLive: live ? { mode: live.mode, serviceTimeId: live.serviceTimeId ?? null } : null,
      serviceTypeId: state.serviceTypeId ?? null,
    };
  }

  /** Identifies one service occurrence, for oncePerService. */
  private serviceKey(): string | null {
    return stageController.getLastLive()?.serviceTimeId ?? null;
  }
}

export const automationEngine = new AutomationEngine();
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: PASS, 0 fail.

> If `serviceTimeId` in the test payloads does not reach `serviceKey()` (which reads
> `stageController`, not the broadcast), the two `oncePerService` tests will fail.
> That is expected and correct: change the tests to drive `stageController`'s live
> state, or have `handleBroadcast` prefer the `serviceTimeId` on a `pco:live` payload
> when present. Prefer the latter — it keeps the engine testable without the
> controller.

- [ ] **Step 5: Prove the restart guard is really tested**

```bash
perl -0pi -e 's/if \(!had\) return;//' main/services/automation-engine.ts
npm test 2>&1 | grep -E "^. fail"   # expect: fail >= 1 (the restart-guard test)
git checkout main/services/automation-engine.ts
```

- [ ] **Step 6: Commit**

```bash
npm run type-check && npm run lint
git add main/services/automation-engine.ts main/services/automation-engine.test.ts
git commit -m "feat(automation): the engine — edge detection, suppression, dispatch

Subscribes to the existing broadcast bus and keeps the previous snapshot per
channel, asking each trigger's pure didFire whether an edge occurred.

The seeding guard is the most important line: the first snapshot on a channel
establishes a baseline and is never evaluated, so a restart mid-service cannot
read it as a transition and fire every rule at once. A seeded mutation removing
it fails the suite.

Cooldown and oncePerService are suppressions, and every suppression is logged
with its reason — a suppressed rule is otherwise invisible.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 7: API routes and startup wiring

**Files:**
- Create: `main/services/routes/automation-routes.ts`
- Modify: `main/services/remote-server.ts`
- Modify: `server.ts` (or wherever `integrationManager.init()` is called)
- Modify: `renderer/lib/api.ts`

**Interfaces:**
- Consumes: `automationEngine`, `automationLog`, the three registries.
- Produces: `automationRoutes(c: RouteCtx): Promise<void>`; renderer channels `automation:*`.

- [ ] **Step 1: Write the route module**

Create `main/services/routes/automation-routes.ts`:

```ts
// automation-routes.ts — rules, registries, settings, activity log.
//
// Every route must finish responding before it returns (see RouteCtx).

import { type RouteCtx, error, json, readBody } from "./context.js";
import { AUTOMATION_ACTIONS } from "../automation-actions.js";
import { AUTOMATION_CONDITIONS } from "../automation-conditions.js";
import { automationEngine } from "../automation-engine.js";
import { automationLog } from "../automation-log.js";
import { AUTOMATION_TRIGGERS } from "../automation-triggers.js";

/** Strip functions — didFire/holds/run cannot cross the wire. */
const shape = (o: Record<string, { id: string; label: string; params: unknown; help?: string }>) =>
  Object.values(o).map(({ id, label, params, help }) => ({ id, label, params, help }));

export async function automationRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;

  if (method === "GET" && pathname === "/api/automation/registry") {
    json(res, {
      triggers: Object.values(AUTOMATION_TRIGGERS).map(({ id, label, channel, params, help }) => ({ id, label, channel, params, help })),
      conditions: shape(AUTOMATION_CONDITIONS),
      actions: shape(AUTOMATION_ACTIONS),
    });
    return;
  }

  if (method === "GET" && pathname === "/api/automation/rules") {
    json(res, { rules: automationEngine.listRules(), settings: automationEngine.getSettings() });
    return;
  }

  if (method === "POST" && pathname === "/api/automation/rules") {
    const body = (await readBody(req)) as Record<string, unknown>;
    if (typeof body.name !== "string" || !body.trigger || !body.action) {
      error(res, "body.name, body.trigger and body.action are required");
      return;
    }
    json(res, await automationEngine.addRule(body as never), 201);
    return;
  }

  const idMatch = pathname.match(/^\/api\/automation\/rules\/([^/]+)$/);
  if (method === "PATCH" && idMatch) {
    const body = (await readBody(req)) as Record<string, unknown>;
    json(res, await automationEngine.updateRule(idMatch[1], body as never));
    return;
  }
  if (method === "DELETE" && idMatch) {
    json(res, await automationEngine.removeRule(idMatch[1]));
    return;
  }

  const testMatch = pathname.match(/^\/api\/automation\/rules\/([^/]+)\/test$/);
  if (method === "POST" && testMatch) {
    try {
      json(res, await automationEngine.testFire(testMatch[1]));
    } catch (err) {
      error(res, err instanceof Error ? err.message : String(err), 400);
    }
    return;
  }

  if (method === "GET" && pathname === "/api/automation/settings") {
    json(res, automationEngine.getSettings());
    return;
  }
  if (method === "POST" && pathname === "/api/automation/settings") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const patch: Record<string, boolean> = {};
    if (typeof body.simulate === "boolean") patch.simulate = body.simulate;
    if (typeof body.disarmed === "boolean") patch.disarmed = body.disarmed;
    json(res, await automationEngine.setSettings(patch));
    return;
  }

  if (method === "GET" && pathname === "/api/automation/log") {
    json(res, { entries: automationLog.list() });
    return;
  }
  if (method === "DELETE" && pathname === "/api/automation/log") {
    await automationLog.clear();
    json(res, { ok: true });
    return;
  }
}
```

- [ ] **Step 2: Register the module and start the engine**

In `main/services/remote-server.ts`, beside the other route modules:

```ts
import { automationRoutes } from "./routes/automation-routes.js";
```
```ts
    await automationRoutes(c);
    if (res.headersSent) return;
```

Start the engine after the integrations are up, so its first snapshots seed against
a settled system. In `main/services/integration-manager.ts` at the end of `init()`:

```ts
    // Last, so the engine's seeding sees a settled system. Its own seeding guard
    // means these first snapshots cannot fire anything regardless.
    const { automationEngine } = await import("./automation-engine.js");
    await automationEngine.init();
```

- [ ] **Step 3: Add the renderer channels**

In `renderer/lib/api.ts`, beside the `rosstalk:*` cases:

```ts
    case "automation:registry": return apiFetch("/api/automation/registry");
    case "automation:rules": return apiFetch("/api/automation/rules");
    case "automation:addRule": return post("/api/automation/rules", params);
    case "automation:updateRule": return patch(`/api/automation/rules/${(params as { id: string }).id}`, (params as { patch: unknown }).patch);
    case "automation:removeRule": return del(`/api/automation/rules/${(params as { id: string }).id}`);
    case "automation:testRule": return post(`/api/automation/rules/${(params as { id: string }).id}/test`);
    case "automation:settings": return apiFetch("/api/automation/settings");
    case "automation:setSettings": return post("/api/automation/settings", params);
    case "automation:log": return apiFetch("/api/automation/log");
    case "automation:clearLog": return del("/api/automation/log");
```

- [ ] **Step 4: Verify against an isolated instance**

Never the production server. Simulate is on by default, so nothing can reach a device:

```bash
PORT=$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')
export STAGE_UTILITY_DATA=$(mktemp -d) STAGE_UTILITY_PORT=$PORT STAGE_UTILITY_FRIENDLY_PORT=0 HOME=$(mktemp -d)
npm run build && node --import tsx server.ts > /tmp/auto.log 2>&1 &
sleep 8
B=http://127.0.0.1:$PORT
curl -s $B/api/automation/settings                     # {"simulate":true,"disarmed":false}
curl -s $B/api/automation/registry | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d["triggers"]),"triggers",len(d["conditions"]),"conditions",len(d["actions"]),"actions")'
ID=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"name":"smoke","enabled":true,"trigger":{"id":"pco.service-started","params":{}},"conditions":[],"action":{"id":"log.message","params":{"message":"hello"}},"cooldownSec":0,"oncePerService":false}' \
  $B/api/automation/rules | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X POST $B/api/automation/rules/$ID/test       # {"ok":true,...}
curl -s $B/api/automation/log | head -c 300
kill %1
```

- [ ] **Step 5: Commit**

```bash
npm run type-check && npm run lint && npm test
git add main/services/routes/automation-routes.ts main/services/remote-server.ts main/services/integration-manager.ts renderer/lib/api.ts
git commit -m "feat(automation): API routes and startup wiring

The engine starts last, after the integrations are up, so its first snapshots
seed against a settled system — though its own seeding guard means they could
not fire anything regardless.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 8: The guided builder UI

**Files:**
- Create: `renderer/settings/sections/automation-section.tsx`
- Modify: `renderer/settings/settings-view.tsx` (add the nav entry)

- [ ] **Step 1: Build the section**

Create `renderer/settings/sections/automation-section.tsx` with three parts:

**A safety strip at the top** — the simulate switch and a Disarm all button, using
the same treatment as the RossTalk panel (amber when simulate is ON, because that is
the abnormal state; a red-tinted Disarm button when `disarmed` is true).

**The rule list.** Each rule is a card showing `name`, an enabled `Switch`, a
one-line summary (`When <trigger label> · If <n> conditions · Then <action label>`),
and buttons for **Test fire**, edit and delete. Editing expands the card into the
builder:

- **When** — a `RowSelect` of triggers from `automation:registry`, then that
  trigger's params rendered from `ParamDef` exactly as the RossTalk inspector does:
  `number` → `RowNumber`, `enum` → `RowSelect`, `string` → `RowText`.
- **If** — a list of conditions with an "Add condition" `RowSelect`, each removable.
- **Then** — a `RowSelect` of actions, then that action's params the same way.
- **Cooldown** — `RowNumber`, seconds, defaulting to 30.
- **Once per service** — `RowSwitch`.

`optionsFrom` resolves at render time: `rosstalk-targets` and `rosstalk-commands`
from the `rosstalk:*` channels, `osc-targets` from `osc:targets-changed`,
`service-types` from stage state.

Unsaved edits use the shared neutral `UnsavedBanner`, matching the rest of Settings.

**The activity log** — a reverse-chronological list from `automation:log`, live via
the `automation:log` SSE channel. Each row: time, rule name, outcome and detail.
Color by outcome — `fired` neutral, `simulated` muted, `suppressed` muted with the
reason, `failed` red. Include a "Clear" button.

- [ ] **Step 2: Add the nav entry**

In `renderer/settings/settings-view.tsx`, add `Automation` to the **SYSTEM** group,
beside Advanced, rendering `<AutomationSection />`.

- [ ] **Step 3: Verify in a browser**

Start an isolated instance as in Task 7, then:
- The section lists 7 triggers, 4 conditions and 4 actions.
- Building a rule with the `log.message` action and pressing **Test fire** adds a
  `simulated` entry to the activity log.
- Turning simulate off and test-firing again logs it as `fired`.
- **Disarm all** grays the list and no rule fires.

- [ ] **Step 4: Commit**

```bash
npm run type-check && npm run lint && npm test && npm run build
git add renderer/settings/sections/automation-section.tsx renderer/settings/settings-view.tsx
git commit -m "feat(automation): guided rule builder and activity log

Trigger, condition and action forms all render from the registry's ParamDef, so a
new provider gains a UI without touching this file.

The activity log shows suppressions alongside fires — without it a suppressed
rule is invisible and 'why did nothing happen' is unanswerable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 9: Documentation

**Files:**
- Create: `docs/automation.md`
- Modify: `docs/integrations/README.md` (link it)

- [ ] **Step 1: Write the doc**

Cover: what a rule is; the trigger/condition/action model; **why edge detection
matters** (the channels are snapshots); the safety mechanisms and what each protects
against; the `log.message` workflow for validating a rule against a real service
without touching gear; and this warning verbatim:

> **Rules fire without a human present.** Build every rule with the `log.message`
> action first, watch the activity log through a real service to confirm it fires
> when you expect, and only then attach the real action. Simulate mode is on by
> default for the same reason.

Include the two-simulate-switch explanation: the engine's and RossTalk's compose by
AND, and the UI shows which one suppressed a send.

- [ ] **Step 2: Commit**

```bash
git add docs/automation.md docs/integrations/README.md
git commit -m "docs(automation): document the rule engine and its safety model

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

## Deferred providers

Not in this plan. Each is one registry entry once its integration exists.

- **`tsl.set-text` / `tsl.set-tally`** — `tsl-service` currently only formats people
  counts into fixed feeds. Arbitrary text per display address, and exposing the tally
  bits already present in `buildTsl31Packet`'s control byte, is a change to that
  service rather than to the engine.
- **PCO Calendar trigger** — needs the `calendar/v2` product, which this app has never
  touched. Its own integration.
- **Ecobee action** — blocked on developer API access.

## First rule against real gear

Everything here is tested with fakes, so the first rule that touches hardware is
untested by definition. Off-air, in this order:

1. Build the rule with the **`log.message`** action. Arm it. Watch a real service.
2. Confirm the activity log shows it firing at exactly the right moment, once.
3. Swap the action for the real one, leaving **simulate on**. Confirm the log shows
   the exact command it would send.
4. Turn simulate off, with something harmless as the action.
