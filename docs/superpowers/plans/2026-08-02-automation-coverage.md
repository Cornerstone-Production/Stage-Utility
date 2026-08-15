# Automation Coverage Implementation Plan (phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every integration and app feature can drive an automation rule, through hand-written triggers and conditions.

**Architecture:** Registry additions only. Triggers stay pure `didFire(prev, next, params, now)` over an existing broadcast channel; conditions stay pure `holds(ctx, params, now)`. No new transports, no device is contacted, and the app gains no new ability to act — which is what makes this landable in one branch.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node built-in test runner via `npx tsx --test`.

## Global Constraints

- Node >= 24, TypeScript strict, ESM with `.js` import specifiers even for `.ts` sources.
- No new runtime dependencies; `node:` builtins only.
- Never use emojis in code, UI, comments, or commit messages.
- **`didFire` MUST return false when `prev` is null.** The engine seeds the first snapshot per channel and never evaluates it; without this a restart mid-service fires every rule at once, unattended. `automation-triggers.test.ts` asserts it for every registered trigger and will cover new ones automatically.
- **A trigger must never throw.** The engine catches and treats a throw as "did not fire", but the existing "malformed payloads" test iterates the whole registry and must keep passing — every new trigger tolerates a payload missing its fields.
- Fire on the EDGE, never on the level. A trigger that returns true while a state merely persists fires on every broadcast.
- `occupancy.crossed-above` / `occupancy.crossed-below` keep their ids. Renaming breaks saved rules for no gain.
- This phase adds **no actions**. Actions are phases 2 and 3.
- Run `npm run type-check && npm run lint && npm test` before every commit. One pre-existing lint warning in `renderer/settings/sections/patch-import.tsx` is not yours.
- Conventional Commits. No AI attribution, no session links.
- Branch `feat/automation-coverage`, off `beta`.

## Reference: payload shapes

Copied from `main/types/` so no task has to go looking:

```ts
ConnectionState = "disconnected" | "connecting" | "connected" | "error";
IntegrationState = { id: string; enabled: boolean; connection: ConnectionState; message: string | null; config: Record<string, unknown> };
// "integrations:state-changed" broadcasts IntegrationState[]

ObsStatusDTO    = { connected, recording, recordPaused, streaming, virtualCam: boolean; recordTimecode: string | null };
ReaperStatusDTO = { connected, recording, recordPaused, playing: boolean; positionSeconds: number | null; positionString: string | null };
BaptismState    = { mode; phase: "idle" | "testimony" | "baptism"; personNumber: number; baptismIndex: number; segmentStartedAt: string | null; ... };
TranscriptLineDTO = { id: string; channel: string | null; channelName: string | null; color: string | null; text: string; ... };
// "displays:presence" broadcasts { connected: string[] }
// "spl:metrics" broadcasts SplMetricsDTO = { connected: boolean; apiVersion: string | null; meters: Record<string, SplMeterDTO> }
```

The twelve integration ids: `companion`, `obs`, `osc`, `planning-center`, `prodcom`, `propresenter`, `reaper`, `ross-tsl`, `rosstalk`, `sensource`, `smaart`, `wireless`.

---

## File structure

| File | Responsibility |
|---|---|
| `main/services/automation-triggers.ts` (modify) | All trigger definitions. |
| `main/services/automation-conditions.ts` (modify) | All condition definitions. |
| `main/services/automation-triggers.test.ts` (modify) | Edge cases per trigger. |
| `main/services/automation-conditions.test.ts` (modify) | Per condition. |
| `main/services/automation-coverage.test.ts` (create) | The completeness guardrail. |
| `docs/automation.md` (modify) | Document every new entry. |

---

### Task 1: Connection triggers and conditions for all twelve integrations

One task, not twelve: the entries are mechanically identical and a reviewer would accept or reject them as a set.

**Files:**
- Modify: `main/services/automation-triggers.ts`, `main/services/automation-conditions.ts`
- Test: `main/services/automation-triggers.test.ts`, `main/services/automation-conditions.test.ts`

**Interfaces:**
- Produces: triggers `<id>.connected` and `<id>.disconnected` for each of the twelve ids; conditions `<id>.is-connected`.

- [ ] **Step 1: Write the failing test**

Add to `automation-triggers.test.ts`:

```ts
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
});
```

And to `automation-conditions.test.ts`:

```ts
describe("integration connection conditions", () => {
  test("is-connected holds only while that integration is connected", () => {
    for (const id of INTEGRATION_IDS) {
      const c = AUTOMATION_CONDITIONS[`${id}.is-connected`];
      assert.ok(c, `${id}.is-connected must be registered`);
    }
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx --test main/services/automation-triggers.test.ts main/services/automation-conditions.test.ts`
Expected: FAIL — none of the ids are registered.

- [ ] **Step 3: Implement the triggers**

In `automation-triggers.ts`, above the exported registry:

```ts
/** Live states arrive as an array on "integrations:state-changed". */
type IntState = { id?: string; connection?: string };
const asStates = (v: unknown): IntState[] => (Array.isArray(v) ? (v as IntState[]) : []);
const connOf = (v: unknown, id: string): string | null =>
  asStates(v).find((s) => s.id === id)?.connection ?? null;

/** Labels for the twelve, so a rule reads "OBS connects" rather than an id. */
const INTEGRATIONS: { id: string; label: string }[] = [
  { id: "companion", label: "Companion" },
  { id: "obs", label: "OBS" },
  { id: "osc", label: "OSC" },
  { id: "planning-center", label: "Planning Center" },
  { id: "prodcom", label: "ProdCom" },
  { id: "propresenter", label: "ProPresenter" },
  { id: "reaper", label: "REAPER" },
  { id: "ross-tsl", label: "Ross TSL" },
  { id: "rosstalk", label: "RossTalk" },
  { id: "sensource", label: "SenSource" },
  { id: "smaart", label: "Smaart" },
  { id: "wireless", label: "Wireless" },
];

/** Connect/disconnect pair for one integration. Written per integration rather
 *  than as a single parameterised entry so each reads in its own words. */
function connectionTriggers(id: string, label: string): Record<string, TriggerDef> {
  return {
    [`${id}.connected`]: def({
      id: `${id}.connected`,
      label: `${label} connects`,
      channel: "integrations:state-changed",
      params: [],
      didFire: (prev, next) => {
        if (prev === null) return false;
        return connOf(prev, id) !== "connected" && connOf(next, id) === "connected";
      },
    }),
    [`${id}.disconnected`]: def({
      id: `${id}.disconnected`,
      label: `${label} disconnects`,
      channel: "integrations:state-changed",
      params: [],
      help: "Fires when the link drops, including into an error state.",
      didFire: (prev, next) => {
        if (prev === null) return false;
        const after = connOf(next, id);
        // A missing entry is UNKNOWN, not disconnected — an integration that
        // vanished from the payload must not read as a device going down.
        if (after === null) return false;
        return connOf(prev, id) === "connected" && after !== "connected";
      },
    }),
  };
}
```

Then spread them into the registry:

```ts
export const AUTOMATION_TRIGGERS: Record<string, TriggerDef> = {
  ...Object.assign({}, ...INTEGRATIONS.map((i) => connectionTriggers(i.id, i.label))),
  // ... existing entries unchanged
```

- [ ] **Step 4: Implement the conditions**

In `automation-conditions.ts`, the condition context has no integration states today. Add them:

```ts
// In main/types/automation.ts, extend ConditionCtx:
  /** Connection state per integration id, for the <id>.is-connected conditions. */
  integrations: Record<string, string>;
```

In `automation-engine.ts`'s `conditionCtx()`, populate it from `integrationManager.getStates()`, keyed by id with the `connection` string. Import the manager alongside the existing imports.

Then, in `automation-conditions.ts`:

```ts
function isConnectedCondition(id: string, label: string): ConditionDef {
  return {
    id: `${id}.is-connected`,
    label: `${label} is connected`,
    params: [],
    holds: (ctx) => ctx.integrations?.[id] === "connected",
  };
}
```

and spread one per integration into `AUTOMATION_CONDITIONS`, using the same `INTEGRATIONS` list — export it from `automation-triggers.ts` and import it here so the two cannot diverge.

- [ ] **Step 5: Run and watch them pass**

Run: `npm test`
Expected: PASS, including the existing restart-guard and malformed-payload sweeps over the enlarged registry.

- [ ] **Step 6: Commit**

```bash
git add main/services/automation-triggers.ts main/services/automation-conditions.ts main/services/automation-triggers.test.ts main/services/automation-conditions.test.ts main/types/automation.ts main/services/automation-engine.ts
git commit -m "feat(automation): connect and disconnect triggers for every integration"
```

---

### Task 2: OBS outputs

**Files:**
- Modify: `main/services/automation-triggers.ts`, `main/services/automation-conditions.ts`
- Test: both test files

**Interfaces:**
- Produces: `obs.streaming-started`, `obs.streaming-stopped`, `obs.virtualcam-started`, `obs.virtualcam-stopped`; condition `obs.is-recording`.

- [ ] **Step 1: Write the failing test**

```ts
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
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-triggers.test.ts`
Expected: FAIL — the four ids are not registered.

- [ ] **Step 3: Implement**

```ts
  "obs.streaming-started": def({
    id: "obs.streaming-started",
    label: "OBS starts streaming",
    channel: "obs:status",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return !asObs(prev).streaming && asObs(next).streaming === true;
    },
  }),

  "obs.streaming-stopped": def({
    id: "obs.streaming-stopped",
    label: "OBS stops streaming",
    channel: "obs:status",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      const p = asObs(prev);
      const n = asObs(next);
      // Unreachable is UNKNOWN, not stopped.
      if (n.connected === false) return false;
      return p.streaming === true && n.streaming === false;
    },
  }),
```

with the same pair for `virtualCam` under `obs.virtualcam-started` / `obs.virtualcam-stopped`, and:

```ts
type Obs = { connected?: boolean; recording?: boolean; streaming?: boolean; virtualCam?: boolean };
const asObs = (v: unknown): Obs => (v && typeof v === "object" ? (v as Obs) : {});
```

Condition:

```ts
  "obs.is-recording": {
    id: "obs.is-recording",
    label: "OBS is recording",
    params: [],
    holds: (ctx) => ctx.obsRecording === true,
  },
```

`ConditionCtx` gains `obsRecording: boolean`, populated in `conditionCtx()` from the last `obs:status` the engine saw.

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add main/services/automation-triggers.ts main/services/automation-conditions.ts main/services/automation-triggers.test.ts main/types/automation.ts main/services/automation-engine.ts
git commit -m "feat(automation): OBS streaming and virtual cam triggers"
```

---

### Task 3: REAPER transport

**Files:** as Task 2.

**Interfaces:** produces condition `reaper.is-recording`. (`recording.started` / `recording.stopped` already cover REAPER's record state and are not duplicated.)

- [ ] **Step 1: Write the failing test**

```ts
describe("reaper transport", () => {
  test("is-recording holds only while REAPER records", () => {
    const c = AUTOMATION_CONDITIONS["reaper.is-recording"];
    assert.ok(c, "reaper.is-recording must be registered");
    assert.equal(c.holds({ ...CTX, reaperRecording: true }, {}, NOW), true);
    assert.equal(c.holds({ ...CTX, reaperRecording: false }, {}, NOW), false);
  });
});
```

`CTX` is the existing base context fixture in `automation-conditions.test.ts`; extend it with `reaperRecording: false` and `obsRecording: false`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-conditions.test.ts`

- [ ] **Step 3: Implement**

```ts
  "reaper.is-recording": {
    id: "reaper.is-recording",
    label: "REAPER is recording",
    params: [],
    holds: (ctx) => ctx.reaperRecording === true,
  },
```

with `reaperRecording: boolean` on `ConditionCtx`, populated in `conditionCtx()`.

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add main/services/automation-conditions.ts main/services/automation-conditions.test.ts main/types/automation.ts main/services/automation-engine.ts
git commit -m "feat(automation): a condition for REAPER recording"
```

---

### Task 4: A phrase said over ProdCom

**Files:** `automation-triggers.ts`, `automation-triggers.test.ts`

**Interfaces:** produces `prodcom.phrase-said`, params `phrase` (string), `channel` (string, optional).

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-triggers.test.ts`

- [ ] **Step 3: Implement**

```ts
type Line = { id?: string; text?: string; channelName?: string | null };
const asLines = (v: unknown): Line[] => (Array.isArray(v) ? (v as Line[]) : []);

  "prodcom.phrase-said": def({
    id: "prodcom.phrase-said",
    label: "A phrase is said on ProdCom",
    channel: "prodcom:transcript",
    params: [
      { key: "phrase", label: "Phrase", type: "string", help: "Case-insensitive, matches part of a line." },
      { key: "channel", label: "On channel", type: "string", optional: true, help: "Leave blank for any channel." },
    ],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const want = String(params.phrase ?? "").trim().toLowerCase();
      if (!want) return false; // an empty phrase would match every line
      const onlyChannel = String(params.channel ?? "").trim().toLowerCase();

      // Only lines NOT already present: the transcript grows, so matching the
      // whole feed would fire on every broadcast for the rest of the service.
      const seen = new Set(asLines(prev).map((l) => l.id));
      return asLines(next).some((l) => {
        if (seen.has(l.id)) return false;
        if (onlyChannel && (l.channelName ?? "").trim().toLowerCase() !== onlyChannel) return false;
        return (l.text ?? "").toLowerCase().includes(want);
      });
    },
  }),
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add main/services/automation-triggers.ts main/services/automation-triggers.test.ts
git commit -m "feat(automation): trigger on a phrase said over ProdCom"
```

---

### Task 5: Baptism timer

**Files:** `automation-triggers.ts`, `automation-conditions.ts`, both test files.

**Interfaces:** produces `baptism.started`, `baptism.phase-changed`, `baptism.finished`; condition `baptism.phase-is` with param `phase`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-triggers.test.ts`

- [ ] **Step 3: Implement**

```ts
type Baptism = { phase?: string };
const asBaptism = (v: unknown): Baptism => (v && typeof v === "object" ? (v as Baptism) : {});

  "baptism.started": def({
    id: "baptism.started",
    label: "Baptism timer starts",
    channel: "baptism:state",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asBaptism(prev).phase === "idle" && asBaptism(next).phase !== "idle";
    },
  }),

  "baptism.phase-changed": def({
    id: "baptism.phase-changed",
    label: "Baptism moves to another phase",
    channel: "baptism:state",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      const a = asBaptism(prev).phase;
      const b = asBaptism(next).phase;
      return a !== undefined && b !== undefined && a !== b;
    },
  }),

  "baptism.finished": def({
    id: "baptism.finished",
    label: "Baptism timer finishes",
    channel: "baptism:state",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asBaptism(prev).phase !== "idle" && asBaptism(next).phase === "idle";
    },
  }),
```

Condition, with `baptismPhase: string | null` added to `ConditionCtx` and populated in `conditionCtx()`:

```ts
  "baptism.phase-is": {
    id: "baptism.phase-is",
    label: "Baptism phase is",
    params: [{
      key: "phase", label: "Phase", type: "enum",
      options: [
        { value: "idle", label: "Idle" },
        { value: "testimony", label: "Testimony" },
        { value: "baptism", label: "Baptism" },
      ],
    }],
    holds: (ctx, params) => ctx.baptismPhase === String(params.phase ?? ""),
  },
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add main/services/automation-triggers.ts main/services/automation-conditions.ts main/services/automation-triggers.test.ts main/types/automation.ts main/services/automation-engine.ts
git commit -m "feat(automation): baptism timer triggers and a phase condition"
```

---

### Task 6: Displays connecting and disconnecting

**Files:** `automation-triggers.ts`, `automation-triggers.test.ts`

**Interfaces:** produces `display.connected`, `display.disconnected`, `display.none-connected`; each with an optional `name` param except the last.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-triggers.test.ts`

- [ ] **Step 3: Implement**

```ts
const asConnected = (v: unknown): string[] => {
  const c = (v && typeof v === "object" ? (v as { connected?: unknown }).connected : null);
  return Array.isArray(c) ? (c as string[]) : [];
};

  "display.connected": def({
    id: "display.connected",
    label: "A display connects",
    channel: "displays:presence",
    params: [{ key: "name", label: "Display", type: "string", optional: true, optionsFrom: "displays", help: "Leave blank for any." }],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const want = String(params.name ?? "").trim();
      const before = new Set(asConnected(prev));
      const arrived = asConnected(next).filter((d) => !before.has(d));
      return want ? arrived.includes(want) : arrived.length > 0;
    },
  }),

  "display.disconnected": def({
    id: "display.disconnected",
    label: "A display disconnects",
    channel: "displays:presence",
    params: [{ key: "name", label: "Display", type: "string", optional: true, optionsFrom: "displays", help: "Leave blank for any." }],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const want = String(params.name ?? "").trim();
      const after = new Set(asConnected(next));
      const left = asConnected(prev).filter((d) => !after.has(d));
      return want ? left.includes(want) : left.length > 0;
    },
  }),

  "display.none-connected": def({
    id: "display.none-connected",
    label: "Every display has disconnected",
    channel: "displays:presence",
    params: [],
    help: "Fires once when the last display drops off, not repeatedly while none are connected.",
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asConnected(prev).length > 0 && asConnected(next).length === 0;
    },
  }),
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add main/services/automation-triggers.ts main/services/automation-triggers.test.ts
git commit -m "feat(automation): display connect and disconnect triggers"
```

---

### Task 7: SPL thresholds

**Files:** `automation-triggers.ts`, `automation-triggers.test.ts`

**Interfaces:** produces `spl.crossed-above`, `spl.crossed-below`, params `meter` (string), `threshold` (number).

- [ ] **Step 1: Read the meter payload first**

Run: `grep -n "interface SplMeterDTO" -A 10 main/types/stage.ts`
The trigger reads one meter out of `meters: Record<string, SplMeterDTO>`; use the field that carries the current level, and name the param `meter` for its key.

- [ ] **Step 2: Write the failing test**

```ts
describe("spl thresholds", () => {
  // Replace `value` with the level field the DTO actually uses (step 1).
  const spl = (v: number | null) => ({ connected: true, apiVersion: "4", meters: { FOH: { value: v } } });

  test("crossed-above fires on the crossing, not while it stays high", () => {
    const t = AUTOMATION_TRIGGERS["spl.crossed-above"];
    const p = { meter: "FOH", threshold: 95 };
    assert.equal(t.didFire(spl(90), spl(96), p, NOW), true);
    assert.equal(t.didFire(spl(96), spl(97), p, NOW), false);
  });

  test("crossed-below fires on the way down", () => {
    const t = AUTOMATION_TRIGGERS["spl.crossed-below"];
    const p = { meter: "FOH", threshold: 95 };
    assert.equal(t.didFire(spl(96), spl(90), p, NOW), true);
  });

  test("a missing reading is no baseline, so nothing fires", () => {
    // Same rule the occupancy triggers follow: without both sides there is no
    // crossing, and inventing one fires on a reconnect.
    const t = AUTOMATION_TRIGGERS["spl.crossed-above"];
    assert.equal(t.didFire(spl(null), spl(96), { meter: "FOH", threshold: 95 }, NOW), false);
  });

  test("an unknown meter name fires nothing", () => {
    const t = AUTOMATION_TRIGGERS["spl.crossed-above"];
    assert.equal(t.didFire(spl(90), spl(96), { meter: "Nope", threshold: 95 }, NOW), false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-triggers.test.ts`

- [ ] **Step 4: Implement**

```ts
/** One meter's current level, or null when absent or not a finite number. */
function splLevel(v: unknown, meter: string): number | null {
  const meters = (v && typeof v === "object" ? (v as { meters?: Record<string, unknown> }).meters : null) ?? null;
  const m = meters && typeof meters === "object" ? (meters as Record<string, { value?: unknown }>)[meter] : null;
  const n = m?.value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

  "spl.crossed-above": def({
    id: "spl.crossed-above",
    label: "SPL rises above",
    channel: "spl:metrics",
    params: [
      { key: "meter", label: "Meter", type: "string", help: "The Smaart meter name, e.g. FOH." },
      { key: "threshold", label: "Threshold (dB)", type: "number", min: 0, max: 140 },
    ],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const meter = String(params.meter ?? "");
      const a = splLevel(prev, meter);
      const b = splLevel(next, meter);
      if (a === null || b === null) return false; // no baseline, no crossing
      const th = Number(params.threshold);
      return Number.isFinite(th) && a <= th && b > th;
    },
  }),
```

with the mirrored `spl.crossed-below` (`a >= th && b < th`).

- [ ] **Step 5: Run and watch it pass**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add main/services/automation-triggers.ts main/services/automation-triggers.test.ts
git commit -m "feat(automation): SPL threshold triggers"
```

---

### Task 8: Wireless battery and RF

**Files:** `automation-triggers.ts`, `automation-triggers.test.ts`

**Interfaces:** produces `wireless.battery-below`, `wireless.rf-below`, params `slot` (string, optional) and `threshold` (number).

- [ ] **Step 1: Read the payload first**

Run: `grep -rn 'broadcast("slots:devices"' -B 6 main/services/*.ts`
Confirm the per-slot shape (each entry carries a label plus `device.battery` and `device.rf`). Write the fixture from what you find, not from memory.

- [ ] **Step 2: Write the failing test**

```ts
describe("wireless thresholds", () => {
  // Shape confirmed in step 1.
  const slots = (label: string, battery: number | null, rf: number | null) =>
    [{ label, device: { battery, rf } }];

  test("battery-below fires on the crossing for the named slot", () => {
    const t = AUTOMATION_TRIGGERS["wireless.battery-below"];
    const p = { slot: "Vox 1", threshold: 20 };
    assert.equal(t.didFire(slots("Vox 1", 25, 5), slots("Vox 1", 18, 5), p, NOW), true);
    assert.equal(t.didFire(slots("Vox 1", 18, 5), slots("Vox 1", 15, 5), p, NOW), false);
  });

  test("with no slot named it fires for any pack crossing", () => {
    const t = AUTOMATION_TRIGGERS["wireless.battery-below"];
    assert.equal(t.didFire(slots("Vox 1", 25, 5), slots("Vox 1", 18, 5), { threshold: 20 }, NOW), true);
  });

  test("a pack going offline is not a low battery", () => {
    // null is UNKNOWN. Firing a low-battery rule because a receiver dropped
    // would page someone about a pack that is fine.
    const t = AUTOMATION_TRIGGERS["wireless.battery-below"];
    assert.equal(
      t.didFire(slots("Vox 1", 25, 5), slots("Vox 1", null, null), { slot: "Vox 1", threshold: 20 }, NOW),
      false,
    );
  });

  test("rf-below fires on bars dropping past the threshold", () => {
    const t = AUTOMATION_TRIGGERS["wireless.rf-below"];
    assert.equal(
      t.didFire(slots("Vox 1", 80, 4), slots("Vox 1", 80, 1), { slot: "Vox 1", threshold: 2 }, NOW),
      true,
    );
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-triggers.test.ts`

- [ ] **Step 4: Implement**

```ts
type SlotDev = { label?: string | null; device?: { battery?: unknown; rf?: unknown } };
const asSlots = (v: unknown): SlotDev[] => (Array.isArray(v) ? (v as SlotDev[]) : []);

/** Reading for a slot, or null when absent/offline. `field` is "battery" or "rf". */
function slotReading(v: unknown, slot: string, field: "battery" | "rf"): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of asSlots(v)) {
    const label = (s.label ?? "").trim();
    if (!label) continue;
    if (slot && label !== slot) continue;
    const n = s.device?.[field];
    if (typeof n === "number" && Number.isFinite(n)) out.set(label, n);
  }
  return out;
}

/** Crossed downward for any watched slot present on BOTH sides. A pack that
 *  went offline has no reading and is skipped: unknown is not low. */
function crossedBelow(prev: unknown, next: unknown, slot: string, field: "battery" | "rf", th: number): boolean {
  if (!Number.isFinite(th)) return false;
  const before = slotReading(prev, slot, field);
  const after = slotReading(next, slot, field);
  for (const [label, b] of after) {
    const a = before.get(label);
    if (a === undefined) continue;
    if (a >= th && b < th) return true;
  }
  return false;
}

  "wireless.battery-below": def({
    id: "wireless.battery-below",
    label: "A pack's battery falls below",
    channel: "slots:devices",
    params: [
      { key: "slot", label: "Mic", type: "string", optional: true, help: "The slot's mic label. Leave blank for any." },
      { key: "threshold", label: "Battery (%)", type: "number", min: 0, max: 100 },
    ],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      return crossedBelow(prev, next, String(params.slot ?? "").trim(), "battery", Number(params.threshold));
    },
  }),
```

with `wireless.rf-below` identical but for `"rf"` and a 0-5 bar range.

- [ ] **Step 5: Run and watch it pass**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add main/services/automation-triggers.ts main/services/automation-triggers.test.ts
git commit -m "feat(automation): wireless battery and RF triggers"
```

---

### Task 9: Service pacing and updates

**Files:** `automation-triggers.ts`, `automation-triggers.test.ts`

**Interfaces:** produces `service.running-over` and `update.available`.

- [ ] **Step 1: Read both payloads first**

Run:
```bash
grep -rn 'broadcast("service-timeline:history"' -B 6 main/services/service-timeline-recorder.ts
grep -n "interface UpdateStatus" -A 12 main/types/stage.ts
```
`service.running-over` needs the field carrying minutes over plan; `update.available` reads `behind` / `releasesBehind` off `UpdateStatus`.

- [ ] **Step 2: Write the failing test**

```ts
describe("service pacing and updates", () => {
  test("running-over fires once as the plan goes past the margin", () => {
    const t = AUTOMATION_TRIGGERS["service.running-over"];
    // Field name confirmed in step 1.
    const s = (overMin: number) => ({ overUnderMinutes: overMin });
    assert.equal(t.didFire(s(2), s(6), { minutes: 5 }, NOW), true);
    assert.equal(t.didFire(s(6), s(9), { minutes: 5 }, NOW), false);
  });

  test("update.available fires when a release appears, not while one waits", () => {
    const t = AUTOMATION_TRIGGERS["update.available"];
    assert.equal(t.didFire({ releasesBehind: 0 }, { releasesBehind: 1 }, {}, NOW), true);
    assert.equal(t.didFire({ releasesBehind: 1 }, { releasesBehind: 1 }, {}, NOW), false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-triggers.test.ts`

- [ ] **Step 4: Implement**

```ts
  "service.running-over": def({
    id: "service.running-over",
    label: "The service runs over plan by",
    channel: "service-timeline:history",
    params: [{ key: "minutes", label: "Minutes over", type: "number", min: 1, max: 120 }],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const th = Number(params.minutes);
      if (!Number.isFinite(th)) return false;
      const at = (v: unknown) => {
        const n = (v && typeof v === "object" ? (v as { overUnderMinutes?: unknown }).overUnderMinutes : null);
        return typeof n === "number" && Number.isFinite(n) ? n : null;
      };
      const a = at(prev);
      const b = at(next);
      if (a === null || b === null) return false;
      return a <= th && b > th;
    },
  }),

  "update.available": def({
    id: "update.available",
    label: "An update becomes available",
    channel: "update:status",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      const n = (v: unknown) => {
        const x = (v && typeof v === "object" ? (v as { releasesBehind?: unknown }).releasesBehind : null);
        return typeof x === "number" && Number.isFinite(x) ? x : 0;
      };
      return n(prev) === 0 && n(next) > 0;
    },
  }),
```

- [ ] **Step 5: Run and watch it pass**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add main/services/automation-triggers.ts main/services/automation-triggers.test.ts
git commit -m "feat(automation): service pacing and update-available triggers"
```

---

### Task 10: The completeness guardrail, and docs

**Files:**
- Create: `main/services/automation-coverage.test.ts`
- Modify: `docs/automation.md`

- [ ] **Step 1: Write the test**

It passes as soon as Tasks 1-9 are done; its job is the future.

```ts
// Every integration must be reachable from a rule.
//
// Entries are hand-written per integration, which is deliberate — each reads in
// its own words. The cost is drift: a new integration would otherwise have no
// automation until somebody remembered. This turns that from "noticed months
// later" into "fails on the pull request", and names the id that is missing.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AUTOMATION_TRIGGERS } from "./automation-triggers.js";
import { AUTOMATION_CONDITIONS } from "./automation-conditions.js";
import { INTEGRATION_IDS } from "./integration-ids.js";

describe("automation coverage", () => {
  test("every integration appears in at least one trigger or condition", () => {
    const ids = [...Object.keys(AUTOMATION_TRIGGERS), ...Object.keys(AUTOMATION_CONDITIONS)];
    const missing = INTEGRATION_IDS.filter((id) => !ids.some((k) => k.startsWith(`${id}.`)));
    assert.deepEqual(
      missing, [],
      `No automation entries for: ${missing.join(", ")}. ` +
        "Add a trigger or condition for each, or this integration cannot be automated.",
    );
  });

  test("every registered trigger names a channel that something broadcasts", () => {
    // A typo'd channel is a trigger that can never fire, and nothing else
    // would ever say so.
    const known = new Set([
      "pco:live", "people:count", "obs:status", "reaper:status", "spl:metrics",
      "prodcom:transcript", "baptism:state", "displays:presence",
      "service-timeline:history", "update:status", "integrations:state-changed",
    ]);
    for (const t of Object.values(AUTOMATION_TRIGGERS)) {
      assert.ok(known.has(t.channel), `${t.id} watches unknown channel "${t.channel}"`);
    }
  });
});
```

- [ ] **Step 2: Extract the integration id list**

Create `main/services/integration-ids.ts` exporting the twelve ids, and have `integration-manager.ts` build its descriptors from that list so the test and the manager cannot disagree:

```ts
/** Every integration the app ships. The automation coverage test reads this, so
 *  adding an id here fails CI until that integration has a trigger or condition. */
export const INTEGRATION_IDS = [
  "companion", "obs", "osc", "planning-center", "prodcom", "propresenter",
  "reaper", "ross-tsl", "rosstalk", "sensource", "smaart", "wireless",
] as const;
```

- [ ] **Step 3: Run it**

Run: `npx tsx --test main/services/automation-coverage.test.ts`
Expected: PASS. If it fails, it names the integration that has no entries — add them rather than relaxing the test.

- [ ] **Step 4: Document every new entry**

Extend the Triggers and Conditions tables in `docs/automation.md` with one row each, in the same voice as the existing rows. Say plainly which triggers fire on an edge and which conditions merely hold, and note that a device going offline is never treated as "stopped" or "low" — unknown is not a value.

- [ ] **Step 5: Run everything**

```bash
npm run type-check && npm run lint && npm test
```

- [ ] **Step 6: Commit**

```bash
git add main/services/automation-coverage.test.ts main/services/integration-ids.ts main/services/integration-manager.ts docs/automation.md
git commit -m "test(automation): fail CI when an integration has no automation entries"
```

---

## Self-review

**Spec coverage.** OBS → Tasks 1, 2. REAPER → 1, 3. ProPresenter → 1 (connection; slide-level triggers need a payload design and are deferred to phase 2 with the actions). Planning Center → already covered, plus 1. SenSource → 1, and `occupancy.*` unchanged. Smaart → 1, 7. Wireless → 1, 8. ProdCom → 1, 4. RossTalk / OSC / Ross TSL / Companion → 1. Baptism → 5. Displays → 6. Service timeline → 9. Updates → 9. Attendance → covered by `people:count`, as the spec states. Completeness test → 10.

**Deviation from the spec, recorded deliberately.** The spec lists ProPresenter "slide changed / presentation changed" triggers. `propresenter:instances` carries per-instance status keyed by id, and a per-slide trigger needs a decision about which instance a rule watches. That is a design question, not a registry addition, so this phase ships ProPresenter's connection coverage only and the slide triggers move to phase 2. The completeness test still passes, because `propresenter.connected` exists.

**Type consistency.** `def()`, `TriggerDef`, `ConditionDef`, `ConditionCtx` are the existing exports. New `ConditionCtx` fields — `integrations`, `obsRecording`, `reaperRecording`, `baptismPhase` — are each added in the task that first uses them and populated in `conditionCtx()` in the same task.

**Not built here.** Any action. Phase 1 cannot make the app do anything new, which is what makes the whole set safe to land at once.
