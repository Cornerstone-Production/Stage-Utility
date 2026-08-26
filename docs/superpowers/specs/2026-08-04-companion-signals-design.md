# Companion Signals — design

**Goal:** Let an automation rule publish a named value that a Bitfocus Companion
Trigger can act on, so the app can drive Dante crosspoints (and anything else in
Companion) from the Planning Center roster without ever touching those devices.

**First use:** route the Lead TB Dante crosspoint to whichever scheduled vocalist
is marked as talkback that week.

---

## Why signals rather than pressing buttons

The app never presses a Companion button. It publishes state; Companion decides
what to do about it.

```
PCO roster  ->  app rule  ->  signal "dante-tb" = "Vox 4"
                                     |
                              (existing SSE stream)
                                     v
                        module variable $(stage:signal_dante-tb)
                                     |
                              Companion Trigger
                                     v
                     audinate-dantecontroller: Make Crosspoint
```

Rejected alternatives, and why:

- **App calls Companion's HTTP API.** Needs a second connection, host/port/auth
  config and a firewall path, and puts button layout knowledge in the app.
- **Formula/`post_install`-style outbound press.** Same, plus it would put the
  Dante action outside Companion, which is exactly the boundary we want to keep.

The module already dials out to us and consumes an SSE stream. Signals ride that.
Nothing new connects, and the Dante action never leaves Companion — which matters
because Dante is unforgiving and the Companion module is maintained by a team.

**The action is absolute** ("set crosspoint A -> B"), not a toggle. That is what
makes at-least-once delivery safe and lets the rule *converge* rather than needing
exactly-once semantics, which are not achievable across restarts anyway.

---

## App side

### 1. Trigger: `pco.before-plan-time`

Fires a set number of minutes before a plan time.

| Param | |
|---|---|
| `minutes` | lead time, 1-1440 |
| `timeTypes` | `rehearsal`, `service`, or both (default both) |

Fires before **every** matching time on the plan, not just the first. Rehearsal is
often days ahead of the service; firing only there would set the crosspoint on
Thursday and never look again, so a Saturday-night roster change would go live
wrong. Because the action is absolute, the repeat is a no-op when nothing changed
and a correction when it did.

**Mechanics.** Same edge technique as `pco.item-due`: compare `prev.serverNow` to
`next.serverNow` and fire when the target instant falls in that half-open window.
The windows are contiguous and non-overlapping, so it fires exactly once per time
with no stored state, and `prev === null` returns false (restart guard).

**Requires a payload change.** `PcoLiveDTO` carries only the chosen *service*
time. Add:

```ts
planTimes?: { id: string; name: string | null; timeType: string; startsAt: string }[];
```

`getPlanTimes` is already fetched and cached (it already feeds the reconnect
scheduler), so this costs no extra request.

**Lead time must sit inside the reconnect ramp.** `reconnectSchedule.leadMin`
defaults to 120; outside that window the app is deliberately backing off and the
gear may still be dark. A 45-90 minute lead is safely inside it. The default is
**60**, and the field's help text says why.

### 2. Action: `companion.signal-from-roster`

Matching happens in the action, not a condition, because it must produce a *value*
(which slot) and conditions are boolean.

| Param | |
|---|---|
| `signal` | signal name, e.g. `dante-tb` |
| `marker` | text to look for in a person's PCO notes, e.g. `TB` |
| `position` | optional position filter, e.g. `Vocals` |
| `rows` | slot number -> exact string to publish |

`rows` is a lookup table, not a template. Dante channel names may carry numeric
prefixes (`31.Vox 3`) or be renamed at will, so the operator types exactly what
they see in Dante Controller. A template that silently generates a name which does
not exist fails at the crosspoint, hours later; a text box can be eyeballed against
Dante. At four or five slots the table costs nothing.

**Resolution order:**

1. Take the scheduled team members for the active plan.
2. Keep those whose notes contain `marker` (case-insensitive, anywhere in the
   note, matched as a whole word so `TB` does not hit `TBD`).
3. If `position` is set, keep only those on it.
4. Determine each remaining person's **slot** from the resolved slots.
5. Exactly one match -> publish `rows[slot]`. Anything else -> do nothing.

**Slot number is read from the resolved slots, not parsed from the note.**
`slot-resolver.ts` already maps a person to a slot by notes prefix and already
handles notes like `"1 - lead vocal"`, which is live on production data. A second,
subtly different notes parser would drift from the first. Note that the existing
resolver uses a raw `startsWith`, so `"1"` prefix-matches `"10"` — harmless at five
slots, wrong at ten. Fixing that changes live slot assignment and is out of scope
here; it is recorded as a known issue.

### 3. Failure semantics — hold, never clear

| Case | Behaviour |
|---|---|
| Nobody matches | do nothing; previous signal value stands |
| More than one matches | do nothing; log an error; previous value stands |
| Matched slot has no `rows` entry | do nothing; log an error |
| Anything else fails | do nothing |

Never blank a signal. An unrelated scheduling mistake must not take talkback off
entirely mid-service; a stale-but-working route beats no route. Every outcome is
already recorded by the automation log (`fired`, `failed`, `condition-not-met`,
`suppressed`), and a failed resolution additionally sets the signal's error flag so
a Companion button can go red.

Respects **simulate** mode and **disarm** like every other action.

### 4. Signal store

`signals.json`, a map of name -> `{ value, at, ruleId, error }`. Broadcast on a new
`companion:signals` channel, and included in the SSE hello burst so a reconnecting
module rehydrates rather than starting blank.

Persisted so a restart does not lose the current routing. Goes in **`RUNTIME_FILES`,
not `CONFIG_FILES`** — it is derived state, like recorded history, and restoring it
onto another install would assert a routing that machine never computed. The
config-snapshot drift test fails unless a new store appears in one list or the
other, so this must be done in the same change.

### 5. `oncePerService` (separate, pre-existing bug)

`firedForService` is in-memory and cleared in `init()`, so "once per service"
silently means "once per service, per restart". Not in this feature's safety path
now that the action is absolute, but it is wrong and worth fixing as hygiene.

---

## Module side (`companion-module-cornerstone-stageutility`)

Follows the patterns already in `variables.ts` / `feedbacks.ts`.

- **Variables** `signal_<name>` — one per signal seen, value as published.
- **Feedback `signal_is`** (name, value) — style when equal. For "TB is on Vox 4"
  indicators.
- **Feedback `signal_error`** (name) — style when the last evaluation failed.
  This is the red button on the wall; it is the only way an operator learns that
  nobody was marked TB, or that two people were.

Ships in a separate, sideloaded repo, so rolling back is more awkward than a normal
deploy — worth reviewing carefully before it goes out.

---

## Worked example: `dante-tb`

**In PCO.** Production sets each vocalist's note for the event: `1`, `2`, `3`, `4`
for the slot. The one with talkback gets the marker too, e.g. `4 TB`. This is
compatible with the existing slot assignment, because `notesStartsWith: "1"` still
matches `"1 TB"`.

**In the app.**

```
Rule: TB routing
  When:  60 minutes before any rehearsal or service time
  Then:  Set a Companion signal from the roster
           signal:   dante-tb
           marker:   TB
           position: Vocals
           rows:     1 -> Vox 1
                     2 -> Vox 2
                     3 -> Vox 3
                     4 -> Vox 4      (exact Dante source names, TBC)
```

**In Companion.**

```
Trigger
  When:  variable $(stage:signal_dante-tb) changes
  Then:  audinate-dantecontroller: Make Crosspoint
           Source Channel Name:  $(stage:signal_dante-tb)
           Source Device Name:   <dante source device>
           Destination Channel:  Lead TB
           Destination Device:   <dante destination device>
```

One trigger covers every slot, because the module's action accepts variables in
every field. Adding a fifth slot is one row in the app and nothing in Companion.

---

## What this does NOT do

- Press Companion buttons directly.
- Touch the Dante network in any way.
- Validate that a published name exists in Dante. A typo in `rows` produces a valid
  signal that fails silently at the crosspoint — **test each row once after setup**.
- Fix the `startsWith` slot-matching issue at ten or more slots.

---

## Open questions

1. **Exact Dante names.** Source channels (`Vox 1` vs `31.Vox 3`) and the
   destination. Only affects the worked example, not the design.

2. **Which view's slots define "slot 1-4"?** `slots.json` holds slots per view *and*
   per service type — production has `display-1`, `display-2`, `view-2`, `view-8`,
   each with their own. "Slot 4" is ambiguous until we say which view is the source
   of truth. **Assumed for now:** the rule names a view explicitly, defaulting to the
   first view that has slots for the active service type. This needs confirming; it
   is the one thing most likely to be quietly wrong.

3. **Marker on the person, or on the slot?** Assumed: on the *person's* PCO note,
   found by scanning scheduled members, then the slot is looked up. The alternative
   (scan slots, read the occupant's note) gives the same answer when every marked
   person occupies a slot, and differs when someone marked `TB` is not in any slot —
   where the assumption above logs an error rather than silently ignoring them.

4. **Should Test Fire actually publish?** It would move a real crosspoint. Assumed
   yes (it respects simulate, and a test that does not test is useless), but it
   should warn in the UI.

5. **Does Companion re-fire a Trigger when the module reconnects?** Variables get
   re-set on reconnect and `undefined -> "Vox 4"` may read as a change, so an app
   restart could re-run the crosspoint. Harmless because the action is absolute —
   but worth confirming, because it is load-bearing for that claim.
