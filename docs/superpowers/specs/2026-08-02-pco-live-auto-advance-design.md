# Firing a PCO Live item automatically

**Goal:** An automation rule that advances PCO Services Live to a chosen plan item
when that item is due, so a cue everyone forgets — Doors — fires itself.

## Why

Every plan has a Doors item and nobody remembers to fire it. The rule must
generalise beyond that one item, so any item can be picked from a dropdown.

## What PCO actually allows

Established against the live API on 2026-08-02, not from documentation. The Live
resource offers exactly these links:

```
controller  current_item_time  go_to_next_item  go_to_previous_item  items
next_item_time  self  service_type  toggle_control  watchable_plans
```

Three findings shape everything:

**There is no jump.** `go_to_next_item` and `go_to_previous_item` are the only
actions that move the plan. "Fire item X" can only mean "step until X is current",
and every item stepped over is fired on the way.

**Control does not need taking.** The app has never called `toggle_control`, and
Live Next works today from the app and from Companion. PCO gates these actions on
a *permission* — the connected account must be allowed to control Live for that
service type — not on holding the controller. A 403 already carries that message
and it must be surfaced, not swallowed.

**PCO knows the times itself.** `current_item_time` and `next_item_time` mean the
server does not need to derive item schedules from durations. Using PCO's numbers
keeps "when is Doors due" identical to what everyone sees in Planning Center,
rather than drifting from it.

## The rule

> **When** item `[Doors ▾]` is due, offset `[0]` minutes, relative to
> `[the item's own time ▾ | service start ▾]`
> **If** service type is `[Weekend ▾]`
> **Then** advance PCO Live one item — only if that item is next

### Trigger: `pco.item-due`

| Param | Type | Notes |
|---|---|---|
| `title` | string, dropdown-assisted | Matched case-insensitively as a substring |
| `offsetMinutes` | number, default 0 | Negative fires early |
| `anchor` | enum: `item` \| `service-start` | `item` uses PCO's own item time |

**Stores the title, never the item id.** A plan's items are new objects every week,
so an id picked from a dropdown is dead by the next Sunday. The dropdown lists the
current plan's items purely for convenience and writes the title. This is the same
choice `pco.item-reached` already makes.

Consequence to accept: the rule is only as reliable as item naming, and it fails
*silently* when nothing matches. It must therefore log "no item matching 'doors' in
this plan" rather than nothing at all.

Fires once per plan per rule. A rule that has fired for plan P does not fire again
for P, so a restart mid-service cannot re-fire it.

### Action: `pco.live.advance`

| Param | Type | Notes |
|---|---|---|
| `guardTitle` | string, optional | Advance only if the *next* item matches |

One step, never a loop. With `guardTitle` set and the next item not matching, it
logs why and does nothing. It cannot skip, double-fire, or run past its item.

Stepping-only is not a compromise here — it is what the API permits. Per-item rules
walk the plan one step at a time, which is the natural shape.

### Conditions

None to build. `service.type-is`, `service.is-live`, `time.day-of-week` and
`time.between` already exist and are ANDed.

## Safety

This is the first action that changes something **outside** this app and visible to
the whole team. A mis-fire moves the service for everyone watching PCO.

- Simulate mode must exercise the real permission path, so "would advance to Doors"
  means it genuinely could — a simulation that skips the 403 proves nothing.
- A 403 surfaces PCO's own wording into the Activity log verbatim.
- Every outcome logs, including the boring ones: fired, skipped because the next
  item did not match, skipped because no item matched the title, refused by PCO.
  A rule that silently does nothing every Sunday is the worst failure mode, and it
  is the one this design is most exposed to.

## Testing

- Unit: title matching, including the no-match and multiple-match cases.
- Unit: due-time computation for both anchors, including a negative offset.
- Unit: the fire-once-per-plan guard, including across a simulated restart.
- Unit: the action's guard — next item matches, does not match, no live session.
- Integration: the trigger-to-action path with a faked PCO, asserting no request is
  issued when the guard fails.

Live firing against PCO is not automatable. It is verified in simulate mode over a
real weekend before it is armed.

## Risks

**Nothing verifies the rule ever ran.** The failure mode is silence, and silence
looks identical to success until a Sunday when Doors does not fire. The Activity
log is the mitigation and it must be complete.

**Item titles are user data.** Renaming Doors to something else breaks the rule
with no warning at setup time. Not solvable without ids, and ids do not survive
the week.
