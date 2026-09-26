# Baptisms overhaul

**Goal.** The Baptisms tab reads as part of this app: the History service page's
header, stat strip and section nav; a two-lane session chart that puts the timer
and the plan on one axis; per-person splits on the rundown's scale; trends across
services. Underneath it, an append-only raw layer so a session can be rebuilt,
Companion variables and actions so a stream deck can run the whole baptism, and
advance/back as real automation actions so a custom layout can drive it.

**Mockup.** https://claude.ai/artifact/CKsh8UMt2uASE2xxxE7Gc8 (v3) — driveable;
the timer runs, the lane grows, the strip updates.

**Kept as is.** The timer service's two workflows, pause/resume with banked time,
undo, the `serviceKey` stamp, and the auto-start rules (keyword for testimonies,
per-plan item for baptisms). The `/baptism` standalone page and the Settings tab
continue to render the same `<BaptismOperator/>` against one live session.

## How this church runs a baptism

Every design decision below follows from this, so it is stated once here rather
than repeated.

Baptisms are **grouped**, not per-person. Every testimony happens inside one plan
item named `Baptism Stories`. Then there is a transition — vows, prayer, walking
to the water — and then people are baptised one at a time **across the song set**
while the room sings corporately. The dunks are spread over two to four song
items, not contained in one.

Three consequences:

- A session spans a large, discontinuous stretch of the service. Wall clock and
  timed segments diverge by several minutes, so they are two figures, never one.
- The plan items are half the story. Which songs the baptisms ate is the question
  the planning conversation has, and no single-lane chart can answer it.
- `per-person` is the minority workflow. It stays, but it stops being the default.

## Four PRs, in order

Ordered so the parts that protect Sunday's recording land and can be verified
first. Nothing is dropped from the scope; the later PRs stack behind the earlier
ones rather than interleaving with them.

| PR | What lands | Why this order |
|---|---|---|
| 1 | The two correctness fixes, the armed state, grouped as default, the `baptism` raw source and its rebuild | This is what makes Sunday's recording survivable and recoverable. It is the only PR that must land before the 27th |
| 2 | The tab: header, stat strip, section nav, the two-lane session chart, the people table, past-session rows, trends | Reuses PR 1's state fields; the chart is a configuration of the existing module |
| 3 | History integration: the Baptisms card gets the lane and the splits, cross-links both ways, Rebuild from raw | Reuses PR 2's chart |
| 4 | `baptism.*` automation actions, the new `baptism-timer` fields, and the Companion module's variables, actions, feedbacks and presets | The actions are what Companion and custom layouts both route through |

PR 4 spans two repositories: the automation actions and layout object fields land
in this repo, the module changes in
`Cornerstone-Production/companion-module-cornerstone-stageutility` as its own PR.

## PR 1: correctness and the raw layer

### Two bugs

**A finished session can be logged twice.** `finalize()` derives the session id
from `sessionStartedAt`. `undo()` from the finished state clears `finishedAt` and
re-enters the baptism phase. `baptismStore.addSession` prepends without checking
ids — only `addSessions`, the restore path, dedupes. So `finish → undo → finish`
writes a second session carrying the same id, and `linkBaptisms` counts that
service's people twice in History. Undo-after-finish is the first thing an
operator does after a mis-tap.

Fix: `addSession` replaces a session with a matching id in place, keeping its
position, rather than prepending a duplicate.

**Auto-start reports success when it did nothing.** `autoStartAction` returns
`start-baptisms` whenever the bound item goes live and the phase is `testimony`,
in either mode. `startBaptisms()` returns early unless the mode is `grouped`. The
caller in `onLiveTick` ignores the return value: it sets `autoStartedFrom` and
commits regardless. With the timer left in per-person mode, the song going live
paints *"Started automatically from Great Are You Lord"* on the panel while the
timer did nothing.

Fix: `onLiveTick` compares the state it got back and only records
`autoStartedFrom` when the phase actually moved. When a trigger could not be
honoured it logs why (see Logging).

### Grouped is the default

`idleState()` takes `per-person` at first run. It becomes a persisted operator
setting, `baptismDefaultMode`, defaulting to `grouped`. `setMode` continues to be
allowed only while idle, and `reset()` continues to keep the chosen mode.

### The armed state

`BaptismState` gains `armed?: boolean`.

When the baptism phase begins in grouped mode — whether from auto-start or the
`Start baptisms` button — the phase switches to `baptism` with `armed: true`,
`segmentStartedAt: null` and `segmentAccumMs: 0`. No clock runs. The first press
clears `armed` and starts person 1.

This is not cosmetic. Without it, person 1 absorbs however much intro the band
plays before the first person steps into the water, every single week. With it,
every person's span runs from their own press to the next person's, so they all
carry the same kind of boundary.

A person's baptism time is therefore **press to press**: their walk-up, the words
spoken over them, the dunk, and getting out. It is not time submerged. No label
anywhere may imply that it is — "in the water" does not appear in the UI.

Button labels in grouped mode become `First person in` → `Next person in` →
`Last person out`. `armed` is distinct from paused: the readout says `armed` and
`waiting for the first person to step in`, and Pause is hidden while armed.

### The raw layer

A fourth source joins `spl`, `attendance` and `events` in `SOURCES`.
`sampleArchive.recordBaptism(ctx, fields)` appends one row per operator action to
`baptism.csv` in the service's directory, gated on `serviceKey` exactly like the
other three.

The column set is **fixed**, for the reason `recordEvent` already documents: two
header shapes in one source roll the file on every alternation, and
`readArchiveRows` concatenates rolled files in file order, so a rebuild would walk
rows out of time order.

```
at, event, mode, phase, personNumber, baptismIndex, segmentMs, itemId, item, detail
```

`event` is one of `start`, `testimony-end`, `baptisms-armed`, `baptisms-start`,
`person-complete`, `pause`, `resume`, `undo`, `finish`, `reset`.

`itemId` and `item` name the plan item live at that moment, held by the timer
service from the last `onLiveTick`. Without them the file knows a dunk happened at
11:31:40 but not that the room was singing *O Praise The Name*, and the plan lane
cannot be redrawn from raw.

**Nothing is ever rewritten.** An undo is a new `undo` row, never the removal of
the row it undoes. The file is the full record of what the operator did.

`rebuildBaptismSessions(serviceKey, serviceDate)` replays the rows into
`BaptismSession[]`, returning null when the service has no `baptism.csv` — the
same "nothing to rebuild from" contract `rebuildSplItems` has.

`baptism.json` stays classified `"runtime"`. It is an observation, not the
operator's work, and it is already carried in the archive bundle. The raw layer is
what makes it recoverable.

## PR 2: the tab

**Header.** The History service page's shape: the title, a `recording` pill while
a session is live, the plan and service line, an action group (Copy report, Export
CSV, Rebuild from raw), and the KPI row on `StatStrip` — the existing component,
not a copy. Section nav below it: Timer, Session, People, Past sessions, Trends.

**Figures.** Baptized, Timed, Wall clock, Not counted, Avg testimony, Avg baptism.
`Timed` is the sum of banked segments; `Wall clock` is session start to finish;
`Not counted` is the difference. In this church's workflow those differ by the
whole transition plus any pause, so conflating them into one "total" would be a
number that means neither thing. Customize picks which figures show, through the
existing `prefs` store.

**The timer.** Stays a large, thumb-sized readout and a row of wide buttons. It is
the one thing an operator touches during a service, and the rest of the page
reorganising around it must not shrink it.

**The session chart.** Two lanes on one x axis, built from the `history-chart`
module's `laneSegments` / `LaneItem`:

- *timer* — one segment per phase, testimony in the accent, baptism in the live
  green, labelled with the person number when the segment is wide enough,
  following the existing `laneLabel` fit rule. Gaps between segments draw hatched
  and read `not counted`, so an uncounted stretch is visible rather than absent.
- *plan* — the service's timeline items over the same window, outlined, labelled
  with the item title when it fits.

Hovering a segment puts the person, the phase, the duration and the boundary times
on the strip, the way the attendance and sound charts already do.

While the session is open the chart grows live off `baptism:state`, appending
rather than rebuilding the path, honouring `prefers-reduced-motion`.

**People.** The per-person splits on the rundown's scale: 10px uppercase headers,
13px rows, mono tabular figures, plus a split bar per person showing the testimony
and baptism proportions.

**Past sessions.** List rows in the History list's shape — the service, the date,
then Baptized, Avg testimony, Avg baptism, Total — each linking to that service's
History page.

**Trends.** One card, using the same chart module for the line: Baptized per service, Avg
testimony, Avg baptism, and Whole segment, each with a sparkline over the last
eight baptism services and the change against the eight before. The last of those
is the number the planning conversation wants and that nothing in the app answers
today.

## PR 3: History integration

The `Baptisms` card on a service's page keeps its place above Attendance and Sound
and stops being six flat tiles. It gets the same stat strip, the same two-lane
chart read-only, and the per-person splits inline.

The dead-end sentence *"Per-person splits are in the Baptisms tab"* goes; a real
link replaces it, and the Baptisms tab's past-session rows link back. The
`baptisms` export sheet picks up the new fields. `Rebuild from raw` gains baptisms
alongside SPL.

The card is what the rundown cannot show. The rundown lists `Baptism Stories` and
the songs as separate rows each with its own over/under; the card shows that the
dunks did not overrun one item, they spread across three.

## PR 4: actions, objects and Companion

**Automation actions.** `baptism.start`, `baptism.advance`, `baptism.back`,
`baptism.pause`, `baptism.finish` join `AUTOMATION_ACTIONS`, which carries twelve
actions today and none that touch baptisms. One addition buys three things: an
`action-button` in a custom layout, a target for an automation rule, and a second
route for Companion.

`baptism.advance` is phase-aware — it does whatever the operator panel's primary
button would do in the current mode and phase, including clearing `armed`. One
physical key runs the whole baptism, and nobody has to remember which action is
legal in which phase.

**Layout object.** `baptism-timer` keeps its five fields (`live`, `count`,
`total`, `average`, `last`) and gains `testimony` (this person's banked
testimony), `session` (wall clock, not the segment), `phase` (the word) and
`person` (`Person 3`, or `3 of 7` in grouped mode once the testimony pass has run).

**Companion module.** `baptism:state` joins `SSE_EVENTS`. Variables derive on the
existing 1s ticker through `serverNowMs()`, the same delivery-compensated clock
`countdown_seconds` and `resi_elapsed` use, so a clock counts smoothly between
pushes instead of stepping.

| Variable | Reads |
|---|---|
| `baptism_phase` | `idle` · `armed` · `testimony` · `baptism` |
| `baptism_segment` | the live clock, m:ss |
| `baptism_testimony` | this person's testimony once banked, m:ss |
| `baptism_session` | wall clock since the session started, m:ss |
| `baptism_person` | current person number, `3 of 7` in grouped |
| `baptism_count` | people completed |
| `baptism_paused` | `yes` · `no` |
| `baptism_avg_testimony` | running average, m:ss |
| `baptism_avg_baptism` | running average, m:ss |
| `baptism_mode` | `per-person` · `grouped` |

Actions: Start, Advance, Mark baptized, Start baptisms, Next, Pause/resume, Undo,
Finish, Reset, Set workflow — each posting to the `POST /api/baptism/<action>`
endpoints that already exist. Feedbacks: phase colour, paused, running. Presets:
the eight keys in the mockup.

## Docs

Each PR ships its own, in the same commit as the code.

| PR | Files |
|---|---|
| 1 | `docs/features/scriptview-and-baptisms.md` (armed, the default mode, the two fixes), `docs/data-archive.md` (the fourth source and its columns) |
| 2 | `docs/features/scriptview-and-baptisms.md` (the tab) |
| 3 | `docs/features/attendance-and-history.md` (the Baptisms card) |
| 4 | `docs/automation.md` (the actions), `docs/reference/widgets.md` (the object fields), `docs/integrations/companion.md` (variables, actions, feedbacks) |

## Logging

Tagged `[baptism]`. Decisions and failures only, never every success.

- `[baptism] auto-start: "<item>" is bound to the baptisms but the timer is in per-person mode — ignored`
  — the silent failure above, now audible.
- `[baptism] auto-start: started <phase> from "<item>"` — once per transition, so
  a timer that started itself is explainable at 9am on a Sunday.
- `[baptism] raw: no service open, session not archived` — once per session, when
  a session runs with no `serviceKey`. Baptisms are always inside a service here,
  so this means something is wrong with the timeline record, not with baptisms.
- `[baptism] rebuild: <n> sessions from <rows> rows` on an operator rebuild.
- The archive's own append failures already log through `CsvAppender`.

## Tests, each proven red

Per CLAUDE.md, every guard ships with proof: the bug is reintroduced or the guard
deleted, and the test is watched going red in the session that writes it.

- `finish → undo → finish` leaves **one** session in the store, not two. Red on
  today's `addSession`.
- Auto-start firing `start-baptisms` in per-person mode leaves `autoStartedFrom`
  unset and logs the ignored line. Red on today's `onLiveTick`.
- A grouped baptism phase begins armed: no clock advances until the first press,
  and person 1's banked time excludes the stretch before it.
- A replay of a `baptism.csv` fixture rebuilds the same `BaptismSession[]` the
  live presses produced, including across an `undo`.
- `baptism` appears in `SOURCES`, and a merge moves its rows — asserted against
  the sorted source list, one entry per line, not a count.
- The lane's gap segments cover exactly the stretches no person was timed for.
- Companion: a `baptism:state` frame with `segmentStartedAt` in the past yields a
  `baptism_segment` that advances on the ticker without a further frame.

## Open, deliberately

Person identity stays numeric — `Person 1`, `Person 2`. Names, and any PCO roster
link, are out of scope. Revisit once there is a real session's data to look at.
