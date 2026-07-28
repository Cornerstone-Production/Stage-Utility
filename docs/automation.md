# Automation

Rules of the form **when something happens in Stage, do something to a device.**

Settings → **Automation**.

> **Rules fire without a human present.** Build every rule with the **Write a log
> message** action first, watch the activity log through a real service to confirm it
> fires when you expect, and only then attach the real action. Simulate mode is on by
> default for the same reason.

## A rule

| Part | What it is |
|---|---|
| **When** | one trigger — the thing that happens |
| **If** | zero or more conditions, all of which must hold |
| **Then** | one action — the thing that is done |
| **Cooldown** | seconds before this rule may fire again (default 30) |
| **Once per service** | fire at most once per PCO service occurrence |

## Why edge detection matters

Stage's internal channels carry **state snapshots**, not events. `pco:live`
re-broadcasts the current state constantly; `people:count` fires on every poll with
the same number.

So a rule cannot simply ask "is the service live?" — that is true for an hour and
would fire hundreds of times. Every trigger instead answers **"did this just
change?"**, comparing the previous snapshot with the new one. `People count rises
above 50` fires on the single poll where it crossed, not on every poll thereafter.

This is also why a rule can be wrong in a way that is hard to see: get the trigger
right and the action wrong, and nothing tells you — which is what the log-message
workflow above is for.

## Triggers

| Trigger | Fires when |
|---|---|
| Service goes live | PCO Live moves from pre-service into the plan |
| Service ends | PCO Live leaves the plan |
| Plan reaches an item | the live item's title starts matching your text |
| People count rises above | attendance or occupancy crosses a threshold upward |
| People count falls below | …crosses it downward |
| Recording starts | OBS or REAPER begins recording |
| Recording stops | …stops. A recorder going **offline** does not count — that is unknown, not stopped |

## Conditions

Four cross-cutting qualifiers: **a service is live**, **service type is**, **day of
week**, **time is between**. All selected conditions must hold.

They exist so triggers stay simple. Without them "when occupancy rises above 50" also
fires for a Tuesday meeting; with them you add "and a service is live".

A time window may cross midnight (22:00 → 02:00). An unconfigured condition holds
rather than blocking, so a half-filled rule does not silently never fire.

## Actions

| Action | What it does |
|---|---|
| Write a log message | nothing but the log entry — the testing tool |
| Send a RossTalk command | fires a Carbonite/Ultrix command at a target |
| Send an OSC message | sends to an OSC target |
| Refresh all displays | reloads every connected display |

## Safety

**Simulate mode** (default **on**) — rules evaluate fully, and the action is resolved
with its parameters and logged, but nothing reaches a device. Leave it on while you
build.

**Per-rule enable + Test fire** — Test runs the action immediately, ignoring the
trigger, so you can prove the action before arming the rule. It respects simulate.

**Disarm all** — stops every rule at once, whatever each rule's own switch says.
Persists across a restart. Distinct from simulate: simulate is for building, disarm is
for stopping.

**Cooldown** — a value that oscillates across a threshold produces real crossings each
time. The cooldown stops one flapping sensor firing a rule repeatedly.

**Seeding on restart** — when Stage starts, the first snapshot on each channel
establishes a baseline and is never evaluated. Without this an update or crash
mid-service would read that first snapshot as a change and fire every rule at once,
with nobody watching. It is not configurable.

**The activity log records suppressions as well as fires**, with the reason:

```
14:02:11  Roll opener      rosstalk.command "CC 1:05"   sent
14:02:11  Cool the room    —                            suppressed: cooldown (19s left)
14:02:40  Stream crosspt   rosstalk.command "XPT 3:7"   SIMULATED
```

Without that, a suppressed rule is invisible — and "it did not run and I do not know
why" is far harder to debug than "it ran twice".

## Two simulate switches

The engine has one, and RossTalk has its own. They compose by **AND**: a command
reaches the wire only when both are off.

Neither is redundant. The engine's does not cover a manual send from a layout button
or Companion; RossTalk's does not cover the other action providers. The UI shows which
one suppressed a send.

## First rule against real gear

Off-air, in this order:

1. Build the rule with the **Write a log message** action. Arm it. Watch a real
   service.
2. Confirm the activity log shows it firing at exactly the right moment, once.
3. Swap the action for the real one, leaving **simulate on**. Confirm the log shows
   the exact command it would send.
4. Turn simulate off, with something harmless as the action.

## Files

- `main/services/automation-triggers.ts` — trigger registry (pure `didFire`)
- `main/services/automation-conditions.ts` — condition registry (pure)
- `main/services/automation-actions.ts` — action registry (the only I/O)
- `main/services/automation-engine.ts` — bus subscriber, edge detection, dispatch
- `main/services/automation-log.ts` / `automation-store.ts` — log and persistence
- `main/services/routes/automation-routes.ts` — `/api/automation/*`
- `renderer/settings/sections/automation-section.tsx` — the builder
- Design: `docs/superpowers/specs/2026-07-26-automation-engine-design.md`

## Adding a trigger or action

Both are one registry entry. A trigger declares the channel it watches and a pure
`didFire(prev, next)`; an action declares its params and a `run()` that honours
`simulate`. The builder renders the form from the declared params, so **no UI change
is needed**.

A trigger's `didFire` must return `false` when `prev` is null — that is the restart
guard, and it is asserted for every trigger in the test suite.
