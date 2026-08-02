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
| Plan item is due | an item's scheduled moment passes — see [Firing an item on time](#firing-an-item-on-time) |
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
| Advance PCO Live one item | steps the live plan forward once |
| Refresh all displays | reloads every connected display |

## Firing an item on time

A plan usually has an item nobody remembers to fire — doors, a pre-roll, a
countdown. Pair the **Plan item is due** trigger with the **Advance PCO Live one
item** action and it fires itself.

Pick the item by title from the dropdown, or type one. The match is a
case-insensitive substring, and it is matched by **title, not id** — ids are new
objects every week, so a title is the only thing that survives to next Sunday.
**Renaming the item in Planning Center stops the rule**, silently. Nothing else
will tell you.

**Relative to** chooses what the offset counts from:

- *The item's own time* — when that item is scheduled.
- *The service start* — the service time, ignoring where the item sits.

A negative offset fires early, positive late.

### How an item gets a time

Planning Center puts **no time on a plan item**. It publishes a length and a
position, and the clock you see beside each row is arithmetic. Stage does the same
arithmetic, so an item's time is one of two things:

- **Exact** — a **plan time** whose name matches the item's title. Add one in PCO
  (Plan → Times) called `Doors` and the item called `Doors` is pinned to a real
  clock that holds even when the service runs long.
- **Estimated** — otherwise, the service time plus the running total of item
  lengths, anchored on the `SERVICE START` header. This matches the plan editor,
  and it drifts exactly as the plan does: an item that runs four minutes long
  pushes everything after it four minutes late.

Estimated times are dependable **above** the service-start header — nothing has run
yet, so there is nothing to drift. That is the doors case. For anything mid-service,
add a plan time or anchor on the service start.

### What it will not do

**It never jumps.** PCO's API has no jump action — next and previous are all it
offers — so the rule takes exactly one step. It cannot skip ahead to an item, and
it will not step repeatedly to get there: that would fire every item in between,
live.

Because of that, set **Only if the next item is** on the action. If the plan is not
sitting where the rule expected, it does nothing and logs why. Leave it blank only
when you genuinely want an unconditional single step.

**It never takes control.** The action is permission-gated, not possession-gated:
the connected account has to be permitted to control Live for that service type,
and if it is not, PCO's own refusal appears in the Activity log. Stage will not
seize control from whoever is driving.

### Before you arm it

Run it in simulate mode for a full weekend and read the Activity log. Every
outcome is recorded, including skips and the reason for them.

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
