# Automation

Rules of the form **when something happens in Stage, do something to a device.**
Built under **Settings → Automation**.

> Rules fire with nobody present. Build every rule with the **Write a log message**
> action first, watch it through a real service, and only then attach the real
> action. Simulate mode is on by default for the same reason.

## A rule

| Part | |
|---|---|
| **When** | one trigger |
| **If** | zero or more conditions, all of which must hold |
| **Then** | one action |
| **Cooldown** | seconds before this rule may fire again (default 30) |
| **Once per service** | fire at most once per service occurrence |

Triggers fire on **change**, not on state. Stage's channels carry snapshots — the
live plan re-broadcasts constantly, the people counter reports the same number
every poll — so a trigger compares the previous snapshot with the new one.
*People count rises above 50* fires on the poll where it crossed, not on every
poll after.

## Triggers

| | Fires when |
|---|---|
| Service goes live | the plan moves from pre-service into the rundown |
| Service ends | the plan finishes |
| Plan reaches an item | the live item's title starts matching your text |
| People count rises above | attendance or occupancy crosses a threshold upward |
| People count falls below | crosses it downward |
| Recording starts | OBS or REAPER begins recording |
| Recording stops | stops. A recorder going offline does not count — that is unknown, not stopped |

## Conditions

**A service is live**, **service type is**, **day of week**, **time is between**. All
selected conditions must hold.

They keep triggers simple: "when occupancy rises above 50" would also fire for a
Tuesday meeting, so you add "and a service is live".

A time window may cross midnight. An unconfigured condition holds rather than
blocking, so a half-built rule does not silently never fire.

## Actions

| | |
|---|---|
| Write a log message | nothing but the log entry — the testing tool |
| Send a RossTalk command | a Carbonite or Ultrix command at a target |
| Send an OSC message | to an OSC target |
| Refresh all displays | reloads every connected display |

## Safety

**Simulate mode** (on by default) — rules evaluate fully and the resolved action is
logged, but nothing reaches a device. Leave it on while you build.

**Per-rule enable and Test fire** — Test runs the action immediately, ignoring the
trigger, so you can prove the action before arming the rule. It respects simulate.

**Disarm all** — stops every rule at once regardless of its own switch, and persists
across a restart. Simulate is for building; disarm is for stopping.

**Cooldown** — a value oscillating across a threshold produces real crossings each
time. The cooldown stops one flapping sensor firing repeatedly.

**Restart seeding** — the first snapshot on each channel after startup establishes a
baseline and is never evaluated, so an update or crash mid-service cannot read it as
a change and fire everything at once.

The activity log records suppressions as well as fires, with the reason:

```
14:02:11  Roll opener      rosstalk.command "CC 1:05"   sent
14:02:11  Cool the room    —                            suppressed: cooldown (19s left)
14:02:40  Stream crosspt   rosstalk.command "XPT 3:7"   SIMULATED
```

RossTalk has its own simulate switch, independent of the engine's. A command
reaches the wire only when both are off — the engine's does not cover a manual send
from a layout button, and RossTalk's does not cover other actions. The log shows
which one suppressed a send.

## Your first rule against real gear

Off-air, in this order:

1. Build the rule with **Write a log message**. Arm it. Watch a real service.
2. Confirm the log shows it firing at the right moment, once.
3. Swap in the real action, leaving simulate on. Confirm the log shows the exact
   command it would send.
4. Turn simulate off, with something harmless as the action.
