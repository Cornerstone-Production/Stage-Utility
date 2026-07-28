# Automation engine — design

**Status:** approved 2026-07-26.

A shared rule engine: **when X happens in Stage, do Y to a device.** One core with
pluggable triggers and actions, so each integration contributes rather than growing
its own private automation.

## Why one engine

Three separate asks turned out to be the same feature:

- **RossTalk** — put status indicators on the Ultrix/Carbonite multiviewer driven by
  Stage's own state (route a source into a window, fire a salvo that swaps a layout).
- **Ecobee** — cool the room off the PCO master calendar, or when occupancy crosses a
  threshold.
- **OSC** — already sends to LAN gear, but only from an operator tapping a button.

All three are "when something happens, do something to a device". Building the
automation into whichever integration asks first means building it again for the next
one. The engine has two customers before it exists, which is the argument for doing it
properly once.

## Scope

**In:** the engine core, the trigger and action registries, rule storage, the guided
builder UI, the activity log, and the safety mechanisms. Ships with the action
providers whose transports already exist or are already specced.

**Out:** PCO Calendar and Ecobee. Both are **new integrations**, not engine work —
each plugs in later as one registry entry. See "Deferred providers".

## The event bus already exists

`main/services/broadcaster.ts` fans out 21 channels, and `addBroadcastListener` lets
anything subscribe to all of them. The engine is a third listener alongside the SSE
fan-out and the integration manager. **No new event infrastructure is needed.**

But those broadcasts are **state snapshots, not events**. `pco:live` re-broadcasts the
current state repeatedly; `people:count` fires every poll with the same number. A rule
wants "when the service *goes* live", not "while it *is* live". Converting snapshots
into edges is the core problem this design solves, and it is where every misfire will
come from.

## Architecture

```
main/types/automation.ts               Rule, TriggerDef, ActionDef, Condition
main/services/automation-triggers.ts   trigger registry — PURE didFire(), no I/O
main/services/automation-conditions.ts condition registry — PURE, no I/O
main/services/automation-actions.ts    action registry — the only part that does I/O
main/services/automation-engine.ts     bus subscriber, edge detection, dispatch
main/services/automation-store.ts      persisted rules + global flags
main/services/automation-log.ts        activity log (fires AND suppressions)
main/services/routes/automation-routes.ts  /api/automation/*
renderer/settings/sections/automation-section.tsx  the guided builder
```

Three registries, following the same pattern as the layout-object and RossTalk-command
registries. Two of them are pure and fully unit-testable; only the action registry
touches hardware.

### Rule

```ts
interface Rule {
  id: string;
  name: string;                    // "Cool the room before Sunday service"
  enabled: boolean;
  trigger: { id: string; params: Record<string, string | number> };
  conditions: { id: string; params: Record<string, string | number> }[]; // ALL must hold
  action: { id: string; params: Record<string, string | number> };
  /** Anti-flap. Seconds since this rule last fired before it may fire again. */
  cooldownSec: number;             // default 30
  /** Fire at most once per PCO service occurrence, keyed on serviceKey. */
  oncePerService: boolean;         // default false
}
```

### Triggers — a registry of pure edge functions

```ts
interface TriggerDef {
  id: string;                      // "pco.service-started"
  label: string;
  /** Broadcast channel to watch, or "clock" for the internal timer. */
  channel: string;
  params: ParamDef[];
  /**
   * Did this fire? PURE — no I/O, no clock reads beyond `now`.
   * `prev` is null only when seeding, and MUST return false then.
   */
  didFire(prev: unknown | null, next: unknown, params: Record<string, unknown>, now: number): boolean;
}
```

This is the load-bearing piece. `occupancy.crossed-above` returns true **only** on the
transition from below to above — two identical snapshots can never fire it. Because
`didFire` is pure, every edge case is testable by feeding it two snapshots and
asserting a boolean, with no device and no running service.

**Shipping triggers**, all from channels that already broadcast:

| Trigger | Channel | Fires when |
|---|---|---|
| `pco.service-started` | `pco:live` | mode goes `preservice` → `item` |
| `pco.service-ended` | `pco:live` | mode leaves `item` |
| `pco.item-reached` | `pco:live` | current item title matches the param |
| `pco.minutes-before-service` | `pco:live` | time-to-service crosses N minutes |
| `occupancy.crossed-above` | `people:count` | total crosses above N |
| `occupancy.crossed-below` | `people:count` | total crosses below N |
| `recording.started` | `obs:status`, `reaper:status` | recording false → true |
| `recording.stopped` | `obs:status`, `reaper:status` | recording true → false |
| `propresenter.section-changed` | `propresenter:status` | section name changes |
| `display.went-offline` | `displays:presence` | a display stops heartbeating |
| `clock.at-time` | internal | wall-clock time on selected days |

### Conditions — a small fixed set, not an expression language

The test for whether something is a condition or a trigger param: **does it apply
across triggers?** "Which PCO item name" only means something to the plan trigger — a
param. "Only on Sundays" applies to every trigger — a condition.

Without conditions the trigger list explodes into
`occupancy.crossed-above-during-service-on-sunday`. With them, one trigger composes.

| Condition | Holds when |
|---|---|
| `service.is-live` | a PCO service is currently live |
| `service.type-is` | the active service type matches |
| `time.day-of-week` | today is one of the selected days |
| `time.between` | now is within a start/end time |

Four is deliberately the whole list. If a rule needs more than these, the answer is a
better trigger, not a query language.

### Actions — the only part that touches hardware

```ts
interface ActionDef {
  id: string;                      // "rosstalk.command"
  label: string;
  params: ParamDef[];
  /** NEVER throws. A failure is a logged result, not an exception — an action that
   *  throws must not stop the engine or prevent other rules from running. */
  run(params: Record<string, unknown>, ctx: { simulate: boolean }): Promise<ActionResult>;
}

interface ActionResult { ok: boolean; detail: string }
```

Each provider honours `simulate` **itself**, so suppression happens at the one place
that touches hardware rather than being trusted to the engine.

**Shipping actions:**

| Action | Status | Notes |
|---|---|---|
| `log.message` | new, trivial | Writes to the activity log and does nothing else |
| `osc.send` | transport exists | Reuses `oscManager.send()` |
| `rosstalk.command` | transport specced | Reuses `rosstalkManager.send()` |
| `tsl.set-text` | needs extension | `tsl-service` currently only formats people counts; needs arbitrary text per display address |
| `tsl.set-tally` | needs extension | The TSL 3.1 control byte already carries tally bits (`buildTsl31Packet`); they are currently fixed at full brightness and unused |
| `display.refresh` | exists | Broadcasts `display:refresh` |

**`log.message` is not filler.** It is how you validate a rule against a real service
without touching gear: arm the rule with a log action, watch the activity log through a
Sunday, confirm it fired exactly when it should, then swap the action for the real one.
Given production cannot be experimented on, this is the primary testing tool.

## Safety

Six mechanisms. Four are yours; two are not optional.

### Not optional

**1. Edge detection.** Covered above — pure `didFire`, per trigger.

**2. Seed-without-firing on restart.** *The single most important rule in this design.*
On startup the engine has no previous snapshot. The first broadcast on each channel
**seeds** `prev` and can never fire a rule. Without this, restarting mid-service — an
update, a crash, a power blip — sees `prev = null`, reads the first snapshot as a
transition, and fires every rule at once with nobody watching. `didFire` is
contractually required to return `false` when `prev` is null, and that is asserted for
every trigger in the test suite.

### Configurable

**3. Global simulate mode.** Persisted, default **on**. Rules evaluate fully — triggers
fire, conditions are checked, the action is resolved with its parameters — and the
result is logged as "would have run", but no provider touches hardware.

Composes with RossTalk's own simulate by AND: a command reaches the wire only when both
are off. The UI must show *which* switch suppressed a send, or an operator will chase
the wrong one.

**4. Per-rule enable + Test fire.** Each rule has its own toggle. **Test fire** runs the
action once on demand, bypassing the trigger entirely, so the action can be proven
before the rule is armed. Test fire respects simulate.

**5. Activity log.** Every fire **and every suppression**, with the reason:

```
14:02:11  Roll opener            pco.service-started    rosstalk.command "CC 1:05"   sent
14:02:11  Cool the room          occupancy.crossed-above  —                          suppressed: cooldown (19s left)
14:02:40  Stream crosspoint      pco.service-started    rosstalk.command "XPT 3:7"   SIMULATED
```

Logging suppressions matters as much as logging fires. A suppressed rule is invisible
otherwise, and "my rule didn't run and I don't know why" is far harder to debug than
"it ran twice". Persisted and capped, like the existing log buffer.

**6. Panic / disarm all.** One control that disables every rule immediately and
persists across restart, for when something is firing wrongly mid-service. Distinct
from simulate: simulate is for building, panic is for stopping.

### Why cooldown rather than a once-flag

Edge detection stops repeat-firing on identical snapshots, but a genuinely oscillating
value produces genuine edges: occupancy 49 → 51 → 49 → 51 crosses the threshold three
times, and each crossing is real. A **cooldown** is the right fix, and it applies
universally.

`oncePerService` is separate and orthogonal, for "roll the opener once this service"
where a PCO live-state blip would otherwise fire twice. It keys on the `serviceKey`
that the SPL and attendance recorders already use.

The default is deliberately permissive — 30s cooldown, `oncePerService` off — because
**a suppressed fire is invisible while a double fire is visible.** Defaulting to
aggressive suppression optimises for the harder failure to debug.

## Data flow

```
broadcast(channel, payload)
   → engine listener
   → is this the first snapshot for the channel?  → seed prev, STOP
   → for each enabled rule whose trigger watches this channel:
        didFire(prev, next, params, now)?          → no  → next rule
        all conditions hold?                       → no  → log "condition not met", next
        within cooldown / already fired this service? → yes → log "suppressed", next
        action.run(params, { simulate })
        log the result
   → prev = next
```

Evaluation is synchronous per broadcast and actions are fired without awaiting each
other, so one slow provider cannot delay another rule. An action that rejects is caught
and logged; the engine never propagates a provider failure.

## Deferred providers

Both are new integrations rather than engine work. Each is one registry entry once its
integration exists.

**PCO Calendar trigger** — "cool the room off the master calendar" needs PCO's
**Calendar** product (`calendar/v2`), which this app has never touched; it only uses
Services (`services/v2`). That means new endpoints, likely new token scopes, and a new
poll loop. It is a PCO integration expansion that happens to feed the engine.

**Ecobee action** — **blocked**: ecobee stopped accepting new developer registrations
and is not issuing new API keys (reported since at least July 2024). Existing keys are
permanent, so the first question is whether one is already held. If not, the official
API is closed and control needs a different path (Matter/HomeKit local, or SmartThings)
— a different design, not a different action provider. Also note ecobee's API is
OAuth with 60-minute access tokens and rotating refresh tokens, unlike every current
integration, and temperatures are **°F × 10** (720 = 72.0°F).

## Testing

The two pure registries carry the risk and take the bulk of the testing. **No test may
touch a real device.**

**Triggers** — for every trigger: fires on the correct edge; does **not** fire on two
identical snapshots; does **not** fire when `prev` is null (the restart guard, asserted
for all of them); handles a missing or malformed field without throwing.

**Conditions** — each holds and fails on the obvious cases, and an unknown condition id
fails closed rather than open.

**Engine** — a fake trigger and a recording fake action, driven by synthetic
broadcasts: cooldown suppresses and then permits; `oncePerService` fires once across
repeated edges and again after `serviceKey` changes; a disabled rule never runs; panic
stops everything; simulate reaches the provider with `simulate: true` and the provider
records no side effect; an action that rejects is logged and does not stop the next
rule; and the restart path seeds without firing.

**Actions** — each provider is tested against its own fake (the fake TCP server for
RossTalk, a capture socket for OSC/TSL), asserting simulate produces no bytes.

## Risks

- **A misfire is a live production incident.** Everything above is arranged around
  that: pure testable edges, seed-on-restart, simulate default on, log everything
  including suppressions, and one control to stop it all.
- **Snapshot channels were not designed as an event source.** A payload shape change in
  an integration could silently break a trigger's edge detection. The trigger tests pin
  the shapes they depend on, so such a change fails CI rather than a service.
- **The builder can express a rule that is valid but wrong** — right trigger, wrong
  crosspoint. No amount of validation catches that. `log.message` plus the activity log
  is the mitigation: prove the trigger timing first, then attach the real action.
