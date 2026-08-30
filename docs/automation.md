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
| *X* connects / disconnects | any integration's link comes up or drops. One pair per integration, named for it — "OBS connects", "Smaart disconnects" |
| Resi goes live / stops streaming | a watched Resi encoder starts or stops. Unreachable does not count |
| YouTube goes live / stops streaming | a broadcast on your channel reaches `live`, or leaves it |
| OBS starts / stops streaming | the stream output starts or stops |
| OBS starts / stops the virtual camera | the virtual camera output starts or stops |
| A phrase is said on ProdCom | a **new** transcript line contains your text, optionally on one channel only |
| Baptism timer starts | the timer leaves idle |
| Baptism moves to another phase | testimony to baptism, or either back to idle |
| Baptism timer finishes | it returns to idle |
| A display connects / disconnects | a named display arrives or goes, or any when left blank |
| Every display has disconnected | the last display drops off — fires once, not repeatedly while none are connected |
| SPL rises above / falls below | a Smaart meter crosses a level. Name the meter `device::channel`; leave the metric blank for the usual one |
| A pack's battery falls below | a wireless pack crosses a percentage, for one mic or any |
| A pack's RF falls below | the same for RF bars (0-5) |
| The service runs over plan by | cumulative overrun across finished items passes your margin — checked as each item ends |
| An update becomes available | a new release appears, not repeatedly while one waits |
| Before a rehearsal or service | a set number of minutes before any rehearsal or service time on the plan |
| A cue starts on a ProVideoPlayer layer | a layer starts showing different media. The same clip looping round is not a new cue |
| A ProVideoPlayer layer clears | a layer that was showing something now holds nothing. PVP going unreachable does not count |
| A ProVideoPlayer clip stops rolling | a clip has stopped, ended or been paused |
| A ProVideoPlayer layer is hidden / unhidden | the layer's hidden flag flips |
| A ProVideoPlayer layer is muted / unmuted | the layer's mute flag flips |

Every trigger fires on an **edge** — the moment something changes — never on a
state that merely persists. The channels carry state snapshots, re-sent
constantly, so a trigger that fired on a level would fire dozens of times per
service.

Nothing treats a device going offline as a value. A missing reading is unknown,
so a pack dropping off the network is not a low battery, an unreachable OBS is
not "stopped streaming", and an integration vanishing from a payload is not a
disconnect.

ProVideoPlayer layers, playlists and cues are matched **by name, not by id** — an
id is opaque and changes when a workspace is rebuilt from a template. **Renaming
the layer in ProVideoPlayer stops the rule**, silently. Nothing else will tell
you. A name that is only digits cannot be used at all: PVP reads an all-digits
value as a position rather than a name.

## Conditions

**A service is live**, **service type is**, **day of week**, **time is between**,
**baptism phase is**, **OBS is recording**, **REAPER is recording**, **Resi is
streaming**, **YouTube is streaming**, **a ProVideoPlayer layer has content**,
**is playing a video**, **is hidden** or **is muted**, **ProVideoPlayer has
something on screen**, and *X* **is connected** for each integration. All
selected conditions must hold.

They keep triggers simple: "when occupancy rises above 50" would also fire for a
Tuesday meeting, so you add "and a service is live".

Conditions only **hold** or don't — unlike a trigger they never fire on their own.
"OBS is recording" qualifies a rule that some other trigger started; it is not a
way to act the moment recording begins. Use the matching trigger for that.

A time window may cross midnight, and day-of-week and time-of-day both read the
app's time zone (Settings → Advanced), not the server's clock. An unconfigured
condition holds rather than blocking, so a half-built rule does not silently never
fire — with one deliberate exception: a ProVideoPlayer layer condition with no
layer named does **not** hold, because "some layer, I did not say which" would
qualify a rule against a layer nobody chose. That question is **ProVideoPlayer has
something on screen**, which exists separately. None of them hold while PVP has
never connected, either: unreachable is unknown, not empty. "Baptism phase is" does not hold at all until the timer has run — including
for "idle", because before it runs we do not know that it is idle.

## Actions

| | |
|---|---|
| Write a log message | nothing but the log entry — the testing tool |
| Send a RossTalk command | a Carbonite or Ultrix command at a target |
| Send an OSC message | to an OSC target |
| Advance PCO Live one item | steps the live plan forward once |
| Refresh all displays | reloads every connected display |
| Set a Companion signal from the roster | publishes a value for a Companion Trigger to act on — see [Signals](integrations/companion.md#signals) |
| Fire a ProVideoPlayer cue | a cue from a playlist; ProVideoPlayer decides which layer it lands on |
| Fire a ProVideoPlayer cue on a specific layer | the same, onto a layer you name — see the caveat below |
| Clear a ProVideoPlayer layer | takes whatever is on that layer off screen |
| Clear every ProVideoPlayer layer | blanks every screen PVP is driving |
| Hide / unhide a ProVideoPlayer layer | the layer's hidden flag |
| Mute / unmute a ProVideoPlayer layer | the layer's mute flag |
| Set a ProVideoPlayer layer's opacity | 0 is invisible, 100 is fully opaque |

> ProVideoPlayer answers every command with "OK" whether or not it acted on it, so
> every ProVideoPlayer action above reads PVP's state back to confirm what it did.
> A command that was accepted and ignored is recorded as a **failure**, not a
> success — which is the opposite of what the log would otherwise show.
>
> **Fire a ProVideoPlayer cue on a specific layer** carries an open question: PVP
> does not always honour the layer argument, so the action confirms the cue landed
> on the layer you named and reports a failure if it did not. If that fails every
> time on your workspace, use **Fire a ProVideoPlayer cue** and let PVP place it.
> See [ProVideoPlayer](integrations/provideoplayer.md).

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
